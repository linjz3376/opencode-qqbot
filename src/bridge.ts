// @input:  ./config, ./qq/* (types, api, sender), ./opencode/* (client, sessions), ./commands
// @output: createBridge, isAllowedUser, milestoneTargets, loadWatchedMap, saveWatchedMap
// @pos:    根层 - 核心桥接: QQ 消息 -> OpenCode -> QQ 回复
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import { getAccessToken, sendC2CMessage, sendGroupMessage, getNextMsgSeq } from "./qq/api.js"
import { replyToQQ } from "./qq/sender.js"
import { prepareQQAttachments, augmentPromptWithAttachments, purgeOldQQImages } from "./qq/media.js"
import type { OpencodeClient, PermissionDecision, PermissionRequest } from "./opencode/client.js"
import { collectReplyText } from "./opencode/client.js"
import { createEventStream, type V2Event } from "./opencode/eventstream.js"
import { summarizeInput, redactSecrets } from "./opencode/history.js"
import { SessionManager } from "./opencode/sessions.js"
import {
  buildHelpText,
  handleCommand,
  handlePendingSelection,
  isCommand,
  type CommandContext,
  type MirrorApi,
  type PendingSelection,
  type WatchApi,
} from "./commands.js"
import { buildDigest } from "./opencode/mirror.js"

interface Bridge {
  handleMessage: (ctx: MessageContext) => Promise<void>
}

// 用户级单槽：一次只有一个待审批请求在等该用户回复
interface PendingPermission {
  request: PermissionRequest
  mainSessionId: string // 审批发起时的主会话（子会话请求需要它做来源标注）
  resolve: (decision: PermissionDecision) => void
  timer: ReturnType<typeof setTimeout>
}

// 用户级推送队列：节流合并（主动消息配额记账已移至 activeQuota 共享）
interface PushQueue {
  lastSent: number
  timer: ReturnType<typeof setTimeout> | null
  lines: string[]
}

export function createBridge(
  config: Config,
  client: OpencodeClient,
  sessions: SessionManager,
): Bridge {
  const busyUsers = new Set<string>()
  // Persist greeted users to disk so restarting the bot doesn't re-send the
  // full command list to every user on their next message.
  const greeted = loadGreetedSet()
  const pendingSelections = new Map<string, PendingSelection>()
  const pendingPermissions = new Map<string, PendingPermission>()

  // ===== 实时观察 / 回合过程推送 =====
  // 单条 SSE 连接按 sessionID 分流，多订阅者共享（同会话同 userId Set 去重不双发）。
  // 里程碑投递 = /watch 专属（2026-10-14 拍板）；sessionSubs 只管 SSE 活性与去重。
  const eventStream = createEventStream(client.baseUrl)
  const sessionSubs = new Map<string, Set<string>>()   // sessionID -> userIds
  const sessionUnsubs = new Map<string, () => void>()  // sessionID -> SSE 退订
  const activeWatches = new Map<string, string>()      // userId -> sessionID（/watch 显式订阅）
  const lastCtx = new Map<string, MessageContext>()    // userId -> 最近消息 ctx（推送通道选择依据）
  const pushQueues = new Map<string, PushQueue>()
  const activeQuota = new Map<string, { day: string; count: number; warned: boolean }>()
  const bgWaits = new Map<string, { cancel: () => void }>() // 会话 -> 后台等待
  const callCache = new Map<string, string>()              // callID -> 命令摘要（⚠️ 上下文用）
  const mirrorUnsubs = new Map<string, () => void>()       // 摘要镜像订阅（独立于 /watch）
  const qqTurnActive = new Set<string>()                   // QQ 发起的轮次在途（镜像跳过防重复）
  const mirrorState = { enabled: loadMirrorEnabled() }

  const PUSH_MIN_GAP_MS = 2000      // 用户级节流：最快 2 秒一批
  const PUSH_MAX_LINES = 6          // 队列上限：洪峰丢最旧，防积压
  // 债务D4（2026-10-13 官方文档查证）：主动消息频控 = 单关系 1000 条/天 + 20/qpm，
  // Bot 维度认证 10/qps（超限报 40034100）。原自设 15/天过度保守 → 默认 100 留
  // 余量，可用 env QQ_ACTIVE_DAILY_LIMIT 覆盖。
  const ACTIVE_DAILY_LIMIT = Number(process.env.QQ_ACTIVE_DAILY_LIMIT ?? 100)

  function subscribeSession(sessionID: string, userId: string): void {
    if (!sessionSubs.has(sessionID)) {
      sessionSubs.set(sessionID, new Set())
      sessionUnsubs.set(
        sessionID,
        eventStream.subscribe(sessionID, (ev) => onSessionEvent(sessionID, ev)),
      )
    }
    sessionSubs.get(sessionID)!.add(userId)
  }

  function unsubscribeSession(sessionID: string, userId: string): void {
    const set = sessionSubs.get(sessionID)
    if (!set) return
    set.delete(userId)
    if (set.size === 0) {
      sessionSubs.delete(sessionID)
      sessionUnsubs.get(sessionID)?.()
      sessionUnsubs.delete(sessionID)
    }
  }

  function onSessionEvent(sessionID: string, ev: V2Event): void {
    const line = formatMilestone(ev, callCache)
    if (!line) return
    // 2026-10-14 用户拍板：里程碑只投 /watch 显式订阅者——自身回合回显与
    // 会话订阅表的其他来源一律不再隐式携带（镜像只发📋摘要卡）。
    for (const userId of milestoneTargets(activeWatches, sessionID)) enqueuePush(userId, line)
  }

  function enqueuePush(userId: string, line: string): void {
    let q = pushQueues.get(userId)
    if (!q) {
      q = { lastSent: 0, timer: null, lines: [] }
      pushQueues.set(userId, q)
    }
    if (q.lines.length >= PUSH_MAX_LINES) q.lines.shift()
    q.lines.push(line)
    if (q.timer) return
    const wait = Math.max(0, PUSH_MIN_GAP_MS - (Date.now() - q.lastSent))
    q.timer = setTimeout(() => {
      q!.timer = null
      void flushPush(userId)
    }, wait)
  }

  // 统一投递：被动回复优先（ctx.msg_id，5 分钟窗口内、无配额消耗）；
  // 窗口过期/失败降级主动消息（计日配额，超限告警一次）。
  // 观察推送与最终回复共用——超长回合（>被动窗口）的答案靠它送达
  //（2026-10-13 实测教训：回合 >5 分钟时旧路径答案永久丢失）。
  async function deliver(ctx: MessageContext, text: string): Promise<void> {
    try {
      await sendReply(ctx, text)
      return
    } catch (error) {
      console.warn(
        "[bridge] 被动回复失败（可能超 5 分钟窗口），降级主动消息:",
        error instanceof Error ? error.message : error,
      )
    }

    const today = new Date().toISOString().slice(0, 10)
    let q = activeQuota.get(ctx.userId)
    if (!q || q.day !== today) {
      q = { day: today, count: 0, warned: false }
      activeQuota.set(ctx.userId, q)
    }
    if (q.count >= ACTIVE_DAILY_LIMIT) {
      if (!q.warned) {
        q.warned = true
        console.warn(`[bridge] 用户 ${ctx.userId} 今日主动推送配额用尽，窗口外消息无法送达`)
        try {
          await sendActive(ctx, "⚠️ 今日主动推送配额已用尽（QQ 限制），窗口外消息明日恢复送达")
        } catch {
          // 告警也发不出去就静默
        }
      }
      throw new Error("主动消息配额已用尽，本条无法送达")
    }
    await sendActive(ctx, text)
    q.count++
  }

  async function flushPush(userId: string): Promise<void> {
    const q = pushQueues.get(userId)
    const ctx = lastCtx.get(userId)
    if (!q || q.lines.length === 0) return
    if (!ctx) {
      q.lines.length = 0
      return
    }
    const text = q.lines.splice(0, q.lines.length).map((l) => `· ${l}`).join("\n")
    q.lastSent = Date.now()
    try {
      await deliver(ctx, text)
    } catch (error) {
      console.error("[bridge] 观察推送失败（被动+主动均失败，丢弃本批）:", error)
    }
  }

  async function safeDeliver(c: MessageContext, text: string): Promise<void> {
    try {
      await deliver(c, text)
    } catch (error) {
      console.error("[bridge] 消息无法送达（被动+主动均失败）:", error)
    }
  }

  // ===== 摘要镜像（E 阶段 A 方案）：桌面会话轮次完成 → QQ 摘要卡 =====
  // 与 /watch 观察推送互补：观察给过程里程碑，镜像给问答正文摘要。
  // QQ 自己发起的轮次由 promptAndWait 正常回复，不重复镜像（qqTurnActive 守卫）。
  function ensureMirrorSubs(): void {
    if (!mirrorState.enabled) return
    for (const { sessionId } of sessions.all()) {
      if (mirrorUnsubs.has(sessionId)) continue
      mirrorUnsubs.set(
        sessionId,
        eventStream.subscribe(sessionId, (ev) => {
          if (!mirrorState.enabled) return
          if (ev.type !== "session.execution.succeeded") return
          if (qqTurnActive.has(sessionId)) return
          void mirrorTurn(sessionId)
        }),
      )
    }
  }

  function disableMirrorSubs(): void {
    for (const unsub of mirrorUnsubs.values()) unsub()
    mirrorUnsubs.clear()
  }

  // QQ 轮次结束后延迟解锁镜像：SSE 完成事件可能晚于 promptAndWait 返回，
  // 5 秒宽限内若又有新 QQ 回合/后台等待在途则不解锁（防竞态开窗）。
  function scheduleMirrorUnlock(sessionId: string): void {
    setTimeout(() => {
      if (bgWaits.has(sessionId)) return
      const ownerBusy = sessions
        .all()
        .some((x) => x.sessionId === sessionId && busyUsers.has(x.userId))
      if (ownerBusy) return
      qqTurnActive.delete(sessionId)
    }, 5000)
  }

  async function mirrorTurn(sessionID: string): Promise<void> {
    try {
      const owners = sessions.all().filter((x) => x.sessionId === sessionID).map((x) => x.userId)
      if (owners.length === 0) return
      const listJson = await client.session.messages({ path: { id: sessionID } })
      const digest = buildDigest(listJson?.data ?? [])
      if (!digest) return
      for (const userId of owners) {
        // 无最近 ctx（重启后尚未收到新消息）→ 构造主动通道 ctx，
        // deliver 的被动尝试失败会自然降级为主动消息（D4 配额内）。
        const recent = lastCtx.get(userId)
        const ctx: MessageContext = recent ?? { type: "c2c", userId, msgId: "", content: "" }
        await safeDeliver(ctx, digest)
      }
      console.log(`[mirror] 会话 ${sessionID} 摘要已镜像给 ${owners.length} 个用户`)
    } catch (error) {
      console.error("[mirror] 摘要镜像失败:", error)
    }
  }

  // ===== 后台等待：前台超时后不放弃，任务完成时回传结果 =====
  // SSE execution.succeeded 即时触发 + 5 分钟轮询兜底（防 SSE 断连漏事件），
  // 上限 24 小时。用户在同一会话发起新回合时被取代（避免同一结果投递两次）。
  const BG_WAIT_MAX_MS = 24 * 60 * 60 * 1000
  const BG_POLL_MS = 5 * 60 * 1000

  function startBackgroundWait(sessionId: string, ctx: MessageContext, baseline: number): void {
    let cancelled = false
    let finished = false

    const cleanup = (): void => {
      cancelled = true
      unsub()
      clearInterval(pollTimer)
      clearTimeout(giveupTimer)
      bgWaits.delete(sessionId)
      // 后台等待结束（完成/被新回合取代）→ 延迟解锁摘要镜像
      scheduleMirrorUnlock(sessionId)
    }

    async function finish(kind: "done" | "giveup"): Promise<void> {
      if (cancelled || finished) return
      finished = true
      cleanup()
      if (kind === "giveup") {
        await safeDeliver(ctx, "⚠️ 后台任务 24 小时仍未完成，停止自动跟进；结果可随时用 /history 查询")
        return
      }
      // SSE 完成事件后给最终消息落库留 2 秒余量，避免读到半截
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const listJson = await client.session.messages({ path: { id: sessionId } })
        const text = collectReplyText(listJson?.data ?? [], baseline)
        await safeDeliver(
          ctx,
          text
            ? `📤 后台任务完成，结果如下：\n\n${text}`
            : "📤 后台任务完成（无文本产出），详情可用 /history 查看",
        )
        console.log(`[bridge] 会话 ${sessionId} 后台等待已交付`)
      } catch (error) {
        console.error("[bridge] 后台完成结果获取失败:", error)
      }
    }

    async function tick(): Promise<void> {
      if (cancelled || finished) return
      try {
        const listJson = await client.session.messages({ path: { id: sessionId } })
        const msgs = listJson?.data ?? []
        if (msgs.some((x) => x.type === "idle" && (x.time?.created ?? 0) >= baseline)) {
          await finish("done")
        }
      } catch (error) {
        console.error("[bridge] 后台等待轮询失败:", error)
      }
    }

    const unsub = eventStream.subscribe(sessionId, (ev) => {
      if (ev.type === "session.execution.succeeded") void finish("done")
    })
    const pollTimer = setInterval(() => void tick(), BG_POLL_MS)
    const giveupTimer = setTimeout(() => void finish("giveup"), BG_WAIT_MAX_MS)
    bgWaits.set(sessionId, { cancel: cleanup })
    console.log(`[bridge] 会话 ${sessionId} 转入后台等待（最长 ${BG_WAIT_MAX_MS / 3_600_000} 小时）`)
  }

  // 主动消息（不带 msg_id）：markdown 优先，失败回退纯文本
  async function sendActive(ctx: MessageContext, text: string): Promise<void> {
    const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    const seq = getNextMsgSeq("")
    const isGroup = ctx.type === "group" && ctx.groupId
    try {
      if (isGroup) await sendGroupMessage(token, ctx.groupId!, text, undefined, seq, true)
      else await sendC2CMessage(token, ctx.userId, text, undefined, seq, true)
      return
    } catch (error) {
      console.error("[bridge] 主动 markdown 发送失败，回退纯文本:", error)
    }
    if (isGroup) await sendGroupMessage(token, ctx.groupId!, text, undefined, seq, false)
    else await sendC2CMessage(token, ctx.userId, text, undefined, seq, false)
  }

  const watchApi: WatchApi = {
    start(userId, sessionID, ctx) {
      const prev = activeWatches.get(userId)
      if (prev && prev !== sessionID) unsubscribeSession(prev, userId)
      activeWatches.set(userId, sessionID)
      lastCtx.set(userId, ctx)
      subscribeSession(sessionID, userId)
      saveWatchedMap(activeWatches) // R2-P1-3：落盘，重启恢复
      return [
        `👁 已开启观察：${sessionID}`,
        "该会话的工具调用/执行完成会实时推送摘要，/watch off 停止。",
        "（≥2 秒节流合并；QQ 主动消息有日配额，被动窗口内不受限）",
      ].join("\n")
    },
    stop(userId) {
      const sid = activeWatches.get(userId)
      if (!sid) return "当前没有开启观察"
      activeWatches.delete(userId)
      unsubscribeSession(sid, userId)
      saveWatchedMap(activeWatches) // R2-P1-3：落盘，重启不复活
      return `已停止观察：${sid}`
    },
    status(userId) {
      const sid = activeWatches.get(userId)
      return sid ? `👁 观察中：${sid}` : "未开启观察"
    },
  }

  const mirrorApi: MirrorApi = {
    set(enabled) {
      const prev = mirrorState.enabled
      mirrorState.enabled = enabled
      saveMirrorEnabled(enabled)
      if (enabled) {
        if (!prev) ensureMirrorSubs()
      } else {
        disableMirrorSubs()
      }
      return enabled
        ? "✅ 摘要镜像已开启：桌面会话轮次完成后推送问答摘要"
        : "🔇 摘要镜像已关闭（/mirror on 重新开启）"
    },
    status() {
      const subs = mirrorUnsubs.size
      return mirrorState.enabled
        ? `📋 摘要镜像：开（已挂 ${subs} 个会话订阅）`
        : "📋 摘要镜像：关（/mirror on 开启）"
    },
  }

  const commandContext: CommandContext = {
    config,
    client,
    sessions,
    getAccessToken: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
    pendingSelections,
    watch: watchApi,
    mirror: mirrorApi,
  }

  // R2 修复批次启动项（2026-10-14）
  if (config.allowedUsers.length === 0) {
    console.warn("[security] ALLOWED_USERS 为空 → 所有消息将被拒绝（fail-closed）；请在 ~/.openqq/.env 配置白名单")
  }
  // R2-P1-3：恢复持久化的 /watch 订阅（里程碑已改 /watch 专属，重启不得静默丢）
  {
    const saved = loadWatchedMap()
    const known = new Set(sessions.all().map((x) => x.sessionId))
    let pruned = false
    for (const [uid, sid] of Object.entries(saved)) {
      if (!known.has(sid)) {
        pruned = true
        continue
      }
      activeWatches.set(uid, sid)
      subscribeSession(sid, uid)
      console.log(`[watch] 恢复订阅 ${uid.slice(0, 8)}… → ${sid}`)
    }
    if (pruned) saveWatchedMap(activeWatches)
  }

  // 摘要镜像：启动时对全部映射会话挂常驻订阅
  ensureMirrorSubs()
  // 图片落盘：清理 7 天前的 QQ 图片（原生附件接入）
  purgeOldQQImages()

  const handleMessage = async (ctx: MessageContext): Promise<void> => {
    try {
      if (!isAllowedUser(ctx.userId, config.allowedUsers)) {
        await sendReply(ctx, "你不在允许使用的名单里")
        return
      }

      const content = ctx.content.trim()
      // 纯图消息（无文字但有附件）同样放行；真空消息才丢
      if (!content && !ctx.attachments?.length) {
        return
      }
      // 记录最近消息上下文：观察/过程推送的通道选择（被动优先）
      lastCtx.set(ctx.userId, ctx)

      if (!greeted.has(ctx.userId)) {
        greeted.add(ctx.userId)
        saveGreetedSet(greeted)
        await sendReply(ctx, buildHelpText())
      }

      // 权限审批决策优先于命令/普通消息：原 prompt 在 promptAndWait 里
      // 挂起等待该 promise（busy 检查也在其后，不会被"处理中"拒绝）。
      const decision = parsePermissionDecision(content)
      if (decision && pendingPermissions.has(ctx.userId)) {
        // 债务D2：不在这里发"已允许"——等 client 的 reply POST 成功回调
        //（onPermissionReplied）再确认；404（桌面已批）走 onPermissionConflict。
        resolvePermission(ctx.userId, decision)
        return
      }

      if (isCommand(content)) {
        const reply = await handleCommand(ctx, commandContext)
        await sendReply(ctx, reply)
        return
      }

      const pendingReply = await maybeHandlePendingSelection(ctx, commandContext)
      if (pendingReply !== null) {
        await sendReply(ctx, pendingReply)
        return
      }

      // 审批待决时，普通消息不进新 prompt（会话正阻塞在审批上），重发审批菜单
      const pendingPerm = pendingPermissions.get(ctx.userId)
      if (pendingPerm) {
        await sendReply(ctx, formatPermissionPrompt(pendingPerm.request, pendingPerm.mainSessionId))
        return
      }

      if (busyUsers.has(ctx.userId)) {
        await sendReply(ctx, "上一条消息还在处理中，请稍候再试")
        return
      }

      busyUsers.add(ctx.userId)

      let sessionId = ""
      let turnStart = 0
      try {
        const session = await sessions.getOrCreate(ctx.userId)
        sessionId = session.sessionId
        // 新回合取代旧的后台等待（steer 合并运行时只投递一次合并结果）
        bgWaits.get(sessionId)?.cancel()
        // 会话订阅通道（SSE 活性 + 同会话同用户 Set 去重不双发）；里程碑投递
        // 已改 /watch 专属（2026-10-14），此订阅只保通道不再隐式携带推送
        subscribeSession(sessionId, ctx.userId)
        // 摘要镜像：新映射会话补挂订阅；QQ 轮次在途标记（防完成后重复镜像）
        ensureMirrorSubs()
        qqTurnActive.add(sessionId)
        turnStart = Date.now()
        // 原生附件接入（2026-10-14）：QQ 图片下载落盘 → prompt files；
        // 下载失败/类型不支持转成可见文字备注，绝不静默丢
        const prepared = await prepareQQAttachments(ctx.attachments, () =>
          getAccessToken(config.qq.appId, config.qq.clientSecret),
        )
        const { text: promptText, files } = augmentPromptWithAttachments(content, prepared)
        const replyText = await client.promptAndWait(sessionId, promptText, {
          files: files.length ? files : undefined,
          onPermission: (req) => waitForPermissionDecision(ctx, req, sessionId),
          onPermissionReplied: (d) => {
            void safeDeliver(ctx, `已${DECISION_LABELS[d]}，AI 将继续执行…`)
          },
          onPermissionConflict: () => {
            void safeDeliver(ctx, "⚠️ 该审批已在桌面端处理，AI 继续执行…")
          },
        })

        if (replyText.trim()) {
          // 超长回合可能已超被动窗口：deliver 被动失败自动降级主动，答案不丢
          await safeDeliver(ctx, replyText)
        }
      } catch (error) {
        if (sessionId && turnStart > 0 && error instanceof Error && error.message.includes("响应超时")) {
          // 前台时限到 ≠ 放弃：任务继续跑，转入后台等待（SSE + 5 分钟轮询兜底，
          // 最长 24 小时），完成时经 deliver 被动/主动回传 —— 12 小时长任务的答案也不丢。
          await safeDeliver(
            ctx,
            "⏳ 回合超过前台时限，已转后台等待：任务继续执行，完成即回传结果（最长 24 小时）。期间可用 /history 查看进展。",
          )
          startBackgroundWait(sessionId, ctx, turnStart)
        } else {
          await safeDeliver(ctx, `处理失败：${toErrorMessage(error)}`)
        }
      } finally {
        if (sessionId) unsubscribeSession(sessionId, ctx.userId) // /watch 若仍挂着则保留订阅
        // 镜像解锁：转后台的任务由 bgWait 完成时解锁，其余延迟 5 秒（SSE 事件宽限）
        if (sessionId && !bgWaits.has(sessionId)) scheduleMirrorUnlock(sessionId)
        busyUsers.delete(ctx.userId)
      }
    } catch (error) {
      console.error("[bridge] handleMessage failed:", error)
      try {
        await sendReply(ctx, `处理消息失败：${toErrorMessage(error)}`)
      } catch (replyError) {
        console.error("[bridge] failed to send error reply:", replyError)
      }
    }
  }

  async function sendReply(ctx: MessageContext, text: string): Promise<void> {
    const accessToken = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    await replyToQQ(accessToken, ctx, text, config.maxReplyLength)
  }

  // promptAndWait 的 onPermission 回调：推 QQ 审批菜单，挂起等待用户回复。
  // 只有 用户回复 或 30 分钟 TTL 会 resolve —— 后者自动拒绝，避免永久挂起。
  function waitForPermissionDecision(
    ctx: MessageContext,
    request: PermissionRequest,
    mainSessionId: string,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingPermissions.get(ctx.userId)?.request.id === request.id) {
          pendingPermissions.delete(ctx.userId)
          resolve("reject")
          void sendReply(ctx, "审批超时（30 分钟），已自动拒绝该权限请求").catch(() => {})
        }
      }, PERM_PROMPT_TTL_MS)

      pendingPermissions.set(ctx.userId, { request, mainSessionId, resolve, timer })
      // 通知失败不 reject promise（用户仍可能稍后主动回复）
      void sendReply(ctx, formatPermissionPrompt(request, mainSessionId)).catch((error) => {
        console.error("[bridge] 发送审批请求失败:", error)
      })
    })
  }

  function resolvePermission(userId: string, decision: PermissionDecision): void {
    const entry = pendingPermissions.get(userId)
    if (!entry) return
    clearTimeout(entry.timer)
    pendingPermissions.delete(userId)
    entry.resolve(decision)
  }

  return { handleMessage }
}

async function maybeHandlePendingSelection(
  ctx: MessageContext,
  commandContext: CommandContext,
): Promise<string | null> {
  const pending = commandContext.pendingSelections.get(ctx.userId)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  if (!/^\d+$/.test(ctx.content.trim())) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  return handlePendingSelection(ctx.userId, Number(ctx.content.trim()), commandContext)
}

// R2-P1-1（2026-10-14）：空名单 fail-closed——配置缺失时宁可全拒，不静默
// 全开（首轮 P0-2 只闭了配置层，本次闭结构层）。
export function isAllowedUser(userId: string, allowedUsers: string[]): boolean {
  if (allowedUsers.length === 0) return false
  return allowedUsers.includes(userId)
}

// R2-P1-3（2026-10-14）：/watch 持久化——里程碑已改 /watch 专属，重启静默丢
// 订阅不可接受；与 greeted.json 同款风格（损坏即空、文件名参数化供单测）。
const WATCH_FILE = join(homedir(), ".openqq", "watch.json")

export function loadWatchedMap(file: string = WATCH_FILE): Record<string, string> {
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8")
      const obj = JSON.parse(raw)
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(obj)) if (typeof v === "string" && v) out[k] = v
        return out
      }
    }
  } catch {
    // 损坏即空
  }
  return {}
}

export function saveWatchedMap(m: ReadonlyMap<string, string>, file: string = WATCH_FILE): void {
  try {
    writeFileSync(file, JSON.stringify(Object.fromEntries(m), null, 2))
  } catch (error) {
    console.warn("[watch] 持久化失败:", error instanceof Error ? error.message : error)
  }
}

const GREETED_FILE = join(homedir(), ".openqq", "greeted.json")

function loadGreetedSet(): Set<string> {
  try {
    if (existsSync(GREETED_FILE)) {
      const raw = readFileSync(GREETED_FILE, "utf-8")
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        return new Set(arr.filter((x): x is string => typeof x === "string"))
      }
    }
  } catch {
    // fall through to empty set
  }
  return new Set<string>()
}

function saveGreetedSet(set: Set<string>): void {
  try {
    mkdirSync(join(homedir(), ".openqq"), { recursive: true })
    writeFileSync(GREETED_FILE, JSON.stringify([...set]))
  } catch (error) {
    console.error("[bridge] 保存 greeted 失败:", error)
  }
}

// 摘要镜像开关（~/.openqq/settings.json 持久；BOM 防御与 greeted 一致）
const MIRROR_SETTINGS_FILE = join(homedir(), ".openqq", "settings.json")

function loadMirrorEnabled(): boolean {
  try {
    if (existsSync(MIRROR_SETTINGS_FILE)) {
      const raw = readFileSync(MIRROR_SETTINGS_FILE, "utf-8").replace(/^\uFEFF/, "")
      const parsed = JSON.parse(raw)
      if (typeof parsed?.mirror === "boolean") return parsed.mirror
    }
  } catch {
    // fall through to default
  }
  return true // 默认开（用户点单 A 摘要镜像）
}

function saveMirrorEnabled(enabled: boolean): void {
  try {
    mkdirSync(join(homedir(), ".openqq"), { recursive: true })
    let existing: Record<string, unknown> = {}
    if (existsSync(MIRROR_SETTINGS_FILE)) {
      try {
        const raw = readFileSync(MIRROR_SETTINGS_FILE, "utf-8").replace(/^\uFEFF/, "")
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === "object") existing = parsed
      } catch {
        // 损坏则重建
      }
    }
    existing.mirror = enabled
    writeFileSync(MIRROR_SETTINGS_FILE, JSON.stringify(existing, null, 2), "utf-8")
  } catch (error) {
    console.error("[mirror] 保存设置失败:", error)
  }
}

const PERM_PROMPT_TTL_MS = 30 * 60 * 1000

// 里程碑映射（事件载荷实测 2026-10-13）：
//   tool.called.data.input{command,...} → 动作可见
//   tool.success.data.metadata.exit     → 非零退出码才提示（成功静默，避免刷屏）
//   execution.succeeded/failed          → 轮次收尾
// 纯函数（导出供测试；生产路径经 onSessionEvent → enqueuePush）。
// calls: 可选的 callID→命令摘要缓存——tool.success 的载荷可能不含 input，
// 失败行靠缓存补上命令上下文（仅"上条命令 exit N"无从对号入座，用户误以为大量报错）。
export function formatMilestone(ev: V2Event, calls?: Map<string, string>): string | null {
  const d = (ev.data ?? {}) as Record<string, any>
  switch (ev.type) {
    case "session.tool.called": {
      const line = truncate(redactSecrets(summarizeInput(d.input)), 140)
      if (d.id && calls) {
        calls.set(String(d.id), line)
        if (calls.size > 100) {
          const oldest = calls.keys().next().value
          if (oldest !== undefined) calls.delete(oldest)
        }
      }
      // 2026-10-14 用户反馈：纯文件类工具（read/edit/write/grep…）推送裸路径没有
      // 意义——只保留动作类里程碑（input.command 的 shell 命令，或 input 即命令串）；
      // 文件类静默，过程内容由摘要镜像 /history 承载。⚠️失败行不受影响（走 calls 缓存）。
      const cmd = typeof d.input === "string" ? d.input : d.input?.command
      if (!(typeof cmd === "string" && cmd.trim())) return null
      return `🔧 ${line}`
    }
    case "session.tool.success": {
      const exit = d.metadata?.exit
      if (typeof exit !== "number" || exit === 0) return null
      const what =
        (d.id ? calls?.get(String(d.id)) : undefined) ??
        (d.input ? truncate(redactSecrets(summarizeInput(d.input)), 80) : "")
      return what ? `⚠️ exit ${exit}：${what}` : `⚠️ exit ${exit}`
    }
    case "session.execution.succeeded":
      return "✅ 本轮完成"
    case "session.execution.failed":
      return "❌ 执行失败"
    default:
      return null
  }
}

const DECISION_LABELS: Record<PermissionDecision, string> = {
  once: "允许（本次）",
  always: "总是允许（已存入项目白名单）",
  reject: "拒绝",
}

// 里程碑投递目标（纯函数，供单测）：只认 /watch 显式订阅（activeWatches）。
// 2026-10-14 拍板：推不推完全由用户显式控制；sessionSubs（自身回合/镜像等
// 来源）不再隐式携带里程碑，避免"没开 /watch 却在收"的噪声。
export function milestoneTargets(
  activeWatches: ReadonlyMap<string, string>,
  sessionID: string,
): string[] {
  const out: string[] = []
  for (const [userId, sid] of activeWatches) {
    if (sid === sessionID) out.push(userId)
  }
  return out
}

// 解析用户的审批回复（自然语言或 /allow /always /deny 命令式）。
// 优先级：绝对否定 > 总是 > 允许。
// 安全方向性：审批场景下误判的代价不对称 —— 误拒只需重试，误放行会执行
// 危险命令。所以否定词最优先，且「不X」前缀词（不同意/不允许/不要/别）
// 必须盖住「X」（同意/允许）与「总是」（总是不允许 ≠ 总是允许）。
export function parsePermissionDecision(content: string): PermissionDecision | null {
  const t = content
    .trim()
    .toLowerCase()
    .replace(/^\/(allow|always|deny|reject|ok|yes|no)\s*$/, "$1")
  if (!t) return null
  // 债务D5：混合否定增强——"不ok/不太行/否决/驳回/不可以"等一律 reject。
  // 方向性不变：否定最优先，歧义一律倒向拒绝（误拒可重试，误放行是事故）。
  if (
    /\b(deny|reject|no|nope|nah)\b|拒绝|否决|驳回|不准|不给|^否$|别|不要|不\s*(同意|允许|批准|许可|行|ok|okay|可以)|不(太|怎么|太特么)\s*(行|ok|okay|可以)/.test(t)
  )
    return "reject"
  if (/\balways\b|总是(?!不)|永久/.test(t)) return "always"
  if (/\b(allow|approve|yes|ok|y)\b|允许|同意|批准/.test(t)) return "once"
  return null
}

export function formatPermissionPrompt(request: PermissionRequest, mainSessionId?: string): string {
  const lines = ["🔐 需要权限审批", `动作：${request.action || "(未知)"}`]
  // 债务D1：子会话（subagent）发起的审批要标注来源，用户知道批的是谁
  if (mainSessionId && request.sessionID && request.sessionID !== mainSessionId) {
    lines.push(`来源：子会话 ${request.sessionID}（subagent 发起）`)
  }
  const resources = (request.resources ?? []).slice(0, 5)
  if (resources.length > 0) {
    lines.push("资源：")
    for (const r of resources) lines.push(`  ${truncate(r, 300)}`)
  }
  if (request.message) lines.push(`说明：${truncate(request.message, 300)}`)
  lines.push("")
  lines.push("回复「允许」= 仅本次｜「总是」= 保存为项目级白名单（后续同类命令永久放行）｜「拒绝」= 驳回（含本会话其他待审）")
  lines.push("（30 分钟无响应自动拒绝，也可用 /allow /always /deny）")
  return lines.join("\n")
}

function truncate(value: string, max: number): string {
  const s = value.replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
