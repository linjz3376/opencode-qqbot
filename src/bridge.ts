// @input:  ./config, ./qq/* (types, api, sender), ./opencode/* (client, sessions), ./commands, ./core/*
// @output: createBridge, isAllowedUser, milestoneTargets, loadWatchedMap, saveWatchedMap,
//          （O7b 再导出）parsePermissionDecision, formatPermissionPrompt
// @pos:    根层 - 核心桥接: QQ 消息 -> OpenCode -> QQ 回复
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import { getAccessToken, sendC2CInputNotify, sendC2CMessage, sendGroupMessage } from "./qq/api.js"
import { prepareQQAttachments, augmentPromptWithAttachments, purgeOldQQImages } from "./qq/media.js"
import type { OpencodeClient } from "./opencode/client.js"
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
import { createMirror } from "./core/mirror.js"
import {
  createPermissionGate,
  parsePermissionDecision,
  formatPermissionPrompt,
  DECISION_LABELS,
} from "./core/permission.js"
import { truncate } from "./core/util.js"
import { createDelivery } from "./core/delivery.js"
import { handleApprovalInteraction, sendApprovalCard } from "./core/card-approval.js"
import { createFormBridge, renderFormPrompt } from "./core/form-bridge.js"
import type { InteractionEvent } from "./qq/types.js"
// O7b：解析/格式化保持经 bridge 再导出——单测与既有调用方导入路径不变
export { parsePermissionDecision, formatPermissionPrompt } from "./core/permission.js"

// E 闲置回收纯函数（导出供测试，2026-10-29）：返回应回收的闲置会话 id——
// 超过 idleMs 无活动且未被 /watch 显式盯住的会话。
export function evictableIdleSessions(
  lastActivity: ReadonlyMap<string, number>,
  watched: ReadonlySet<string>,
  now: number,
  idleMs: number,
): string[] {
  const out: string[] = []
  for (const [sid, at] of lastActivity) {
    if (watched.has(sid)) continue
    if (now - at > idleMs) out.push(sid)
  }
  return out
}

// H2 停滞提醒决策（导出供测试，2026-10-30）：bgWait 零进展时提醒用户处置桌面弹窗。
// 首次：startedAt 后 firstMs；之后：上次进展/提醒后 intervalMs；最多 maxNudges 次。
export function stallNudgeDecision(
  startedAt: number,
  lastProgressAt: number,
  nudges: number,
  now: number,
  firstMs: number,
  intervalMs: number,
  maxNudges: number,
): "nudge" | "wait" {
  if (nudges >= maxNudges) return "wait"
  const base = nudges === 0 ? startedAt : lastProgressAt
  const need = nudges === 0 ? firstMs : intervalMs
  return now - base >= need ? "nudge" : "wait"
}

interface Bridge {
  handleMessage: (ctx: MessageContext) => Promise<void>
  // HC2（2026-10-26）：暴露事件流句柄，index 侧链路自愈巡检需对其热换基
  eventStream: ReturnType<typeof createEventStream>
  // A 项（2026-10-29）：卡片按钮互动回调（index 侧挂到 QQ 网关 onInteraction）
  handleInteraction: (event: InteractionEvent) => void
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

  // ===== 实时观察 / 回合过程推送 =====
  // 单条 SSE 连接按 sessionID 分流，多订阅者共享（同会话同 userId Set 去重不双发）。
  // 里程碑投递 = /watch 专属（2026-10-14 拍板）；sessionSubs 只管 SSE 活性与去重。
  const eventStream = createEventStream(client.baseUrl)
  const sessionSubs = new Map<string, Set<string>>()   // sessionID -> userIds
  const sessionUnsubs = new Map<string, () => void>()  // sessionID -> SSE 退订
  const activeWatches = new Map<string, string>()      // userId -> sessionID（/watch 显式订阅）
  const lastCtx = new Map<string, MessageContext>()    // userId -> 最近消息 ctx（推送通道选择依据）
  const bgWaits = new Map<string, { cancel: () => void }>() // 会话 -> 后台等待
  const callCache = new Map<string, string>()              // callID -> 命令摘要（⚠️ 上下文用）

  // E（2026-10-29 同步升级，吸收 dsh session/idle-evictor）：闲置会话回收——
  // 长期无活动的会话退订 SSE，降 opencode 服务端事件扇出；/watch 显式盯着的
  // 会话豁免；用户再来消息时 subscribeSession 会重新挂上。env QQ_SESSION_IDLE_HOURS。
  const sessionLastActivity = new Map<string, number>()
  const IDLE_EVICT_MS = (() => {
    const h = Number(process.env.QQ_SESSION_IDLE_HOURS ?? "6")
    return Number.isFinite(h) && h > 0 ? Math.floor(h * 3600_000) : 6 * 3600_000
  })()
  setInterval(() => {
    const now = Date.now()
    for (const sid of evictableIdleSessions(sessionLastActivity, new Set(activeWatches.values()), now, IDLE_EVICT_MS)) {
      sessionUnsubs.get(sid)?.()
      sessionUnsubs.delete(sid)
      sessionSubs.delete(sid)
      sessionLastActivity.delete(sid)
      console.log(`[bridge] 闲置会话已回收（${Math.round(IDLE_EVICT_MS / 3600_000)}h 无活动）: ${sid}`)
    }
  }, 30 * 60 * 1000)

  function subscribeSession(sessionID: string, userId: string): void {
    sessionLastActivity.set(sessionID, Date.now())
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
      sessionLastActivity.delete(sessionID)
    }
  }

  function onSessionEvent(sessionID: string, ev: V2Event): void {
    sessionLastActivity.set(sessionID, Date.now())
    const line = formatMilestone(ev, callCache)
    if (!line) return
    // 2026-10-14 用户拍板：里程碑只投 /watch 显式订阅者——自身回合回显与
    // 会话订阅表的其他来源一律不再隐式携带（镜像只发📋摘要卡）。
    for (const userId of milestoneTargets(activeWatches, sessionID)) enqueuePush(userId, line)
  }

  // ===== 摘要镜像域已随 O7d 收进 core/mirror.ts（订阅/在途标记/解锁/摘要投递）=====

  // ===== 后台等待：前台超时后不放弃，任务完成时回传结果 =====
  // SSE execution.succeeded 即时触发 + 5 分钟轮询兜底（防 SSE 断连漏事件），
  // 上限 24 小时。用户在同一会话发起新回合时被取代（避免同一结果投递两次）。
  const BG_WAIT_MAX_MS = 24 * 60 * 60 * 1000
  const BG_POLL_MS = 5 * 60 * 1000

  // H2（2026-10-30，昨晚卡死事故复盘）：桌面审批/选择弹窗对 bot 无通道（V2 无
  // question API，C 项已证伪）——共享会话会被"桌面弹窗挂起"传导性卡死，且静默。
  // bgWait 期间检测"零进展停滞"，主动提醒用户：去桌面端处理弹窗，或用 /stop 终止。
  const STALL_FIRST_NUDGE_MS = 30 * 60 * 1000
  const STALL_NUDGE_INTERVAL_MS = 30 * 60 * 1000
  const STALL_NUDGE_MAX = 3

  function startBackgroundWait(sessionId: string, ctx: MessageContext, baseline: number): void {
    let cancelled = false
    let finished = false
    const startedAt = Date.now()
    let lastProgressAt = startedAt
    let nudges = 0
    let lastMarker = ""

    const cleanup = (): void => {
      cancelled = true
      unsub()
      clearInterval(pollTimer)
      clearTimeout(giveupTimer)
      bgWaits.delete(sessionId)
      // 后台等待结束（完成/被新回合取代）→ 延迟解锁摘要镜像
      mirror.scheduleUnlock(sessionId)
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

        // H2 停滞检测：消息数或最新 created 变化=有进展；零进展超窗则提醒用户
        let maxCreated = 0
        for (const m of msgs) {
          const created = m.time?.created ?? 0
          if (created > maxCreated) maxCreated = created
        }
        const marker = `${msgs.length}:${maxCreated}`
        const now = Date.now()
        if (marker !== lastMarker) {
          lastMarker = marker
          lastProgressAt = now
        } else if (
          stallNudgeDecision(startedAt, lastProgressAt, nudges, now, STALL_FIRST_NUDGE_MS, STALL_NUDGE_INTERVAL_MS, STALL_NUDGE_MAX) === "nudge"
        ) {
          nudges += 1
          lastProgressAt = now
          console.log(`[bridge] 后台任务停滞提醒 #${nudges} session=${sessionId}`)
          void safeDeliver(
            ctx,
            "⚠️ 后台任务已停滞超过 30 分钟——很可能在桌面端等待确认（审批/选择弹窗无法同步到 QQ）。请到桌面端查看处理；或回复 /stop 终止该任务后重发。",
          ).catch(() => {})
        }

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

  // O7c：投递域门面（统一投递/降级/配额/节流队列/被动回复全在 core/delivery.ts）
  const { enqueuePush, safeDeliver, sendReply } = createDelivery(config, lastCtx)

  // O7b：审批域门面（挂起槽/等待/裁决/跨重启恢复全在 core/permission.ts）
  const perm = createPermissionGate({
    client,
    sendReply,
    safeDeliver,
    // A 项：审批卡片发送（失败自动降级文字菜单，permission 域内处理）
    sendApprovalPrompt: (ctx, request, mainSessionId) =>
      sendApprovalCard({ appId: config.qq.appId, clientSecret: config.qq.clientSecret }, ctx, request, mainSessionId),
  })

  // O7d：摘要镜像域门面（订阅/回合标记/延迟解锁/摘要投递全在 core/mirror.ts）
  const mirror = createMirror({ sessions, eventStream, client, lastCtx, safeDeliver, bgWaits, busyUsers })

  // L 项（2026-10-30）：表单桥（选择弹窗 A/B/C/D 的 QQ 同步与作答回传）。
  // 与审批共用"每用户单一交互槽"心智：表单挂起时优先消费用户回复。
  // 按钮卡片（弹窗验证前置）：选项直点直交，失败自动降级文字编号作答。
  const formBridge = createFormBridge({
    client,
    sendReply,
    safeDeliver,
    sendFormCard: async (ctx, form, keyboard) => {
      try {
        const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
        const text = renderFormPrompt(form)
        if (ctx.type === "group" && ctx.groupId) {
          await sendGroupMessage(token, ctx.groupId, text, ctx.msgId || undefined, undefined, true, keyboard)
        } else {
          await sendC2CMessage(token, ctx.userId, text, ctx.msgId || undefined, undefined, true, keyboard)
        }
        return true
      } catch (error) {
        console.error("[bridge] 表单卡片发送失败，降级文字:", error instanceof Error ? error.message : error)
        return false
      }
    },
  })

  // L 项：常驻交互监听——轮询全局待答权限 + 表单，反查 QQ 用户后推送。
  // 覆盖"桌面端回合发起的交互"（昨晚事故盲区）：bot 空闲时也能把弹窗送到 QQ。
  const INTERACTION_WATCH_MS = (() => {
    const n = Number(process.env.QQ_INTERACTION_WATCH_SECONDS ?? "12")
    return Number.isFinite(n) && n >= 0 ? Math.floor(n * 1000) : 12_000
  })()

  function usersOfSession(sessionID: string): string[] {
    return sessions
      .all()
      .filter((e) => e.sessionId === sessionID)
      .map((e) => e.userId)
  }

  function ctxForUser(userId: string): MessageContext {
    return (
      lastCtx.get(userId) ?? { type: "c2c", userId, msgId: "", content: "", timestamp: String(Date.now()) }
    )
  }

  async function interactionTick(): Promise<void> {
    try {
      const [permRes, formRes] = await Promise.all([client.permission.list(), client.form.list()])
      for (const req of permRes?.data ?? []) {
        for (const uid of usersOfSession(req.sessionID)) {
          if (perm.hasPending(uid)) continue // 单一槽：在挂起（含同 id）即跳过
          perm.pushExternal(uid, ctxForUser(uid), req, req.sessionID)
        }
      }
      for (const form of formRes?.data ?? []) {
        // 全局列表可能含已答表单：有 state 字段时只推 pending
        const state = (form as { state?: { status?: string } }).state
        if (state && state.status !== "pending") continue
        for (const uid of usersOfSession(form.sessionID)) {
          formBridge.pushForm(uid, ctxForUser(uid), form)
        }
      }
    } catch (error) {
      console.error("[interaction-watch] 轮询失败:", error instanceof Error ? error.message : error)
    }
  }

  if (INTERACTION_WATCH_MS > 0) {
    setInterval(() => void interactionTick(), INTERACTION_WATCH_MS)
    console.log(`[interaction-watch] 常驻交互监听已启动（每 ${INTERACTION_WATCH_MS / 1000}s 轮询权限+表单）`)
  }

  const mirrorApi: MirrorApi = mirror.api

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

  // O2（P2-4a）：恢复重启前挂起的审批（逻辑随 O7b 收进 core/permission.ts）
  perm.restore()

  // 摘要镜像：启动时对全部映射会话挂常驻订阅
  mirror.ensureSubs()
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
      if (decision && perm.hasPending(ctx.userId)) {
        // 债务D2：不在这里发"已允许"——等 client 的 reply POST 成功回调
        //（onPermissionReplied）再确认；404（桌面已批）走 onPermissionConflict。
        perm.resolve(ctx.userId, decision)
        return
      }

      // L 项：表单作答消费（选择弹窗 A/B/C/D）——有挂起表单时优先于命令/普通消息。
      // 文字"允许"与表单答案的歧义：parsePermissionDecision 先行的同时要求存在
      // 待审权限才会消费；表单槽独立判断，互不串线。
      if (formBridge.tryResolveText(ctx.userId, content)) {
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
      const pendingPerm = perm.getPending(ctx.userId)
      if (pendingPerm) {
        await sendReply(ctx, formatPermissionPrompt(pendingPerm.request, pendingPerm.mainSessionId))
        return
      }

      if (busyUsers.has(ctx.userId)) {
        await sendReply(ctx, "上一条消息还在处理中，请稍候再试")
        return
      }

      busyUsers.add(ctx.userId)

      // B3（2026-10-29 同步升级）：C2C typing 指示——长回合处理中给用户
      // "对方正在输入"体感（官方 input_notify，仅 C2C；失败静默不阻塞主流程）
      if (ctx.type === "c2c") {
        void getAccessToken(config.qq.appId, config.qq.clientSecret)
          .then((token) => sendC2CInputNotify(token, ctx.userId, ctx.msgId, 60))
          .catch(() => {})
      }

      let sessionId = ""
      let turnStart = 0
      try {
        const session = await sessions.getOrCreate(ctx.userId)
        sessionId = session.sessionId
        sessionLastActivity.set(sessionId, Date.now())
        // 新回合取代旧的后台等待（steer 合并运行时只投递一次合并结果）
        bgWaits.get(sessionId)?.cancel()
        // 会话订阅通道（SSE 活性 + 同会话同用户 Set 去重不双发）；里程碑投递
        // 已改 /watch 专属（2026-10-14），此订阅只保通道不再隐式携带推送
        subscribeSession(sessionId, ctx.userId)
        // 摘要镜像：新映射会话补挂订阅；QQ 轮次在途标记（防完成后重复镜像）
        mirror.beginTurn(sessionId)
        turnStart = Date.now()
        // 原生附件接入（2026-10-14）：QQ 图片下载落盘 → prompt files；
        // 下载失败/类型不支持转成可见文字备注，绝不静默丢
        const prepared = await prepareQQAttachments(ctx.attachments, () =>
          getAccessToken(config.qq.appId, config.qq.clientSecret),
        )
        const { text: promptText, files } = augmentPromptWithAttachments(content, prepared)
        const replyText = await client.promptAndWait(sessionId, promptText, {
          files: files.length ? files : undefined,
          onPermission: (req) => perm.waitForDecision(ctx, req, sessionId),
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
        if (sessionId && !bgWaits.has(sessionId)) mirror.scheduleUnlock(sessionId)
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

  return {
    handleMessage,
    eventStream,
    handleInteraction: (event) => {
      if (handleApprovalInteraction(event, perm)) return
      void formBridge.handleButton(event)
    },
  }
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
