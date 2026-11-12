// @input:  ../opencode/client, ../qq/types, fs/path/os
// @output: createPermissionGate, parsePermissionDecision, formatPermissionPrompt, DECISION_LABELS,
//          PERM_PROMPT_TTL_MS, PERM_NUDGE_MS, createPushGate（弹卡延迟闸）,
//          classifyApprovalReplyError, formatPermissionConflictNotice（纯函数供测试）, ApprovalReplyFailure
// @pos:    根层/core - 审批域（O7b 2026-10-15 自 bridge.ts 拆出：挂起槽、等待/
//          裁决、跨重启恢复、自然语言决策解析、菜单格式化、中断态落盘）
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { MessageContext } from "../qq/types.js"
import type { OpencodeClient, PermissionDecision, PermissionRequest } from "../opencode/client.js"
import { truncate } from "./util.js"

// 用户级单槽：一次只有一个待审批请求在等该用户回复
export interface PendingPermission {
  request: PermissionRequest
  mainSessionId: string // 审批发起时的主会话（子会话请求需要它做来源标注）
  resolve: (decision: PermissionDecision) => void
  timer: ReturnType<typeof setTimeout> | null
  /** design §3.6 保险网：10min 无裁决告警计时器（裁决/TTL/清槽即取消；只报一次） */
  alertTimer?: ReturnType<typeof setTimeout> | null
  ctx: MessageContext // O2：落盘快照，跨重启直答用
  createdAt: number // O2：TTL 基准（落盘与恢复共用）
  restored?: boolean // O2：无活 waiter 槽（裁决走直连 reply）——restore() 与 pushExternal() 都会置位
  /** DEF-qqbot-20261110-7：真跨重启恢复标记，仅 restore() 置位。
   *  restored 表达的是"无活 waiter、裁决走直连 reply"的行为语义，实时推送（pushExternal）
   *  同样置位；但实时审批的卡片/文字菜单在点击后已有选择回显，再补一条"跨重启"回执
   *  属误报，只在从磁盘恢复的条目上投递。 */
  resumedFromDisk?: boolean
  origin?: PermOrigin // 2026-11-09：回合归属标注——bot=机器人回合，external=桌面端发起（镜像推送）
  /** DEF-qqbot-20261112-1：裁决 reply 的 x-opencode-directory 值（建槽时快照；
   *  引擎待审批按 location 实例分仓，裁决/超时拒答不带目录会对项目会话 404） */
  directory?: string
}

/** 审批发起来源（卡片/文字菜单标注 + 联动清槽决策用） */
export type PermOrigin = "bot" | "external"

export const PERM_PROMPT_TTL_MS = 30 * 60 * 1000

/** design §3.6 权限保险网：挂起 10 分钟仍无裁决则告警提醒（TTL 30min 自动拒前的兜底） */
export const PERM_NUDGE_MS = 10 * 60 * 1000

/**
 * 弹卡延迟闸（owner 2026-11-10 拍板）：SSE permission.asked 到达后不立即推 QQ 卡，
 * 延迟 deferMs 判定——桌面端 autoApprove 实测 20~500ms 内秒回 once，窗口内被处置的
 * ask 不再推卡（与桌面「静默放行不打扰」表现一致）；超时仍悬置才推。
 * cancel 按 requestID 撤定时器（replied 事件到达即弃推）；schedule 同键去重。
 */
export interface PushGate {
  schedule: (userId: string, requestID: string, run: () => void) => void
  /** 按 requestID 撤掉所有待决 schedule（不关心 uid） */
  cancel: (requestID: string) => void
  dispose: () => void
}

export function createPushGate(deferMs: number): PushGate {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  return {
    schedule(userId, requestID, run) {
      const key = `${userId}\u0000${requestID}`
      if (timers.has(key)) return
      const timer = setTimeout(() => {
        timers.delete(key)
        run()
      }, deferMs)
      timer.unref?.()
      timers.set(key, timer)
    },
    cancel(requestID) {
      for (const [key, timer] of timers) {
        if (key.endsWith(`\u0000${requestID}`)) {
          clearTimeout(timer)
          timers.delete(key)
        }
      }
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}

/** QQ_PERM_DEFER_MS 解析（owner 拍板默认 500ms）：空值/非法回退默认——
 *  注意 Number("")===0，必须先判空再 Number（2026-11-10 回归实证默认值曾因此失效为 0）。 */
export function resolvePermDeferMs(envValue: string | undefined): number {
  if (envValue === undefined || envValue.trim() === "") return 500
  const n = Number(envValue)
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : 500
}

export const DECISION_LABELS: Record<PermissionDecision, string> = {
  once: "允许（本次）",
  always: "总是允许（已存入项目白名单）",
  reject: "拒绝",
}

/**
 * 拒绝裁决遇到「他端已处理（404）」时的用户告警（纯函数，供单测）。
 * 2026-11-07 DEF-qqbot-20261107-1：引擎 ask fail-open 下，用户点「拒绝」时
 * 操作可能已被服务端先行放行并执行。此时静默继续=用户误以为已阻断，
 * 必须给出明确告警；允许类冲突仍走 10 分钟保险网，不在此处噪音。
 */
export function formatPermissionConflictNotice(decision: PermissionDecision): string | null {
  if (decision !== "reject") return null
  return "⚠️ 已收到「拒绝」，但服务端在该裁决前已放行此操作（引擎 ask fail-open），命令可能已执行。本条结果请勿视为已授权；若为破坏性命令请立即核对现场。"
}

/**
 * 跨重启审批转发失败的分类（纯函数，供单测）。
 * - expired：404/410——请求已不在服务端（等待超时已被自动拒绝/已裁决），
 *   用户点的是"重启后恢复的过期副本"，重试无意义，只能重新发起原操作；
 * - transient：网络错误/5xx 等——可能只是服务端暂时不可达，可稍后重试。
 * 错误形状来自 opencode/client.ts 的 `OpenCode API {status}: {excerpt}`。
 */
export type ApprovalReplyFailure = "expired" | "transient"
export function classifyApprovalReplyError(error: unknown): ApprovalReplyFailure {
  const msg = error instanceof Error ? error.message : String(error)
  return /\bAPI\s+(404|410)\b/.test(msg) ? "expired" : "transient"
}

// O2（2026-10-15，P2-4a）：审批中断态落盘——重启前挂起的审批重启后仍可
// 处置（直连 reply 或明确回执），不再出现"回复允许灌进会话当普通消息"的
// 误导路径。与 greeted/watch.json 同款风格（损坏即空）。
const PENDING_PERM_FILE = join(homedir(), ".openqq", "pending-permissions.json")

export type PersistedPermission = {
  request: PermissionRequest
  mainSessionId: string
  createdAt: number
  ctx: MessageContext
  origin?: PermOrigin
}

function loadPendingPermMap(): Record<string, PersistedPermission> {
  try {
    if (existsSync(PENDING_PERM_FILE)) {
      const raw = readFileSync(PENDING_PERM_FILE, "utf-8")
      const obj = JSON.parse(raw)
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const out: Record<string, PersistedPermission> = {}
        for (const [k, v] of Object.entries(obj)) {
          const e = v as PersistedPermission
          if (e && e.request?.id && e.ctx?.userId && typeof e.createdAt === "number") out[k] = e
        }
        return out
      }
    }
  } catch {
    // 损坏即空
  }
  return {}
}

function savePendingPermMap(m: ReadonlyMap<string, PendingPermission>): void {
  try {
    const out: Record<string, PersistedPermission> = {}
    for (const [uid, e] of m) {
      if (!e.ctx) continue
      out[uid] = {
        request: e.request,
        mainSessionId: e.mainSessionId,
        createdAt: e.createdAt,
        ctx: e.ctx,
        ...(e.origin ? { origin: e.origin } : {}),
      }
    }
    writeFileSync(PENDING_PERM_FILE, JSON.stringify(out))
  } catch (error) {
    console.warn("[perm] 审批态落盘失败:", error instanceof Error ? error.message : error)
  }
}

export interface PermissionGateDeps {
  client: OpencodeClient
  sendReply: (ctx: MessageContext, text: string) => Promise<void>
  safeDeliver: (ctx: MessageContext, text: string) => Promise<boolean>
  /** A 项（2026-10-29）：卡片按钮审批发送通道；返回 false 时本域自动降级文字菜单 */
  sendApprovalPrompt?: (
    ctx: MessageContext,
    request: PermissionRequest,
    mainSessionId: string,
    origin?: PermOrigin,
  ) => Promise<boolean>
  /** 槽位清空的唤醒钩子（用户裁决/TTL 自动拒绝均触发）：审批挂起期间 drainQueue 被守卫
   *  挡回，裁决后须由调用方重新放行队列——否则挂起期间入队的消息要等用户再发一条才动
   *  （2026-11-05 举一反三：permission 域的"终态无人唤醒"漏洞）。 */
  onDecision?: (userId: string) => void
  /** 10min 无裁决告警间隔（测试注入小值；缺省 PERM_NUDGE_MS） */
  nudgeMs?: number
  /** 跨重启恢复读盘入口（测试注入；缺省读 ~/.openqq/pending-permissions.json） */
  loadPending?: () => Record<string, PersistedPermission>
  /** DEF-qqbot-20261112-1：按用户查会话项目目录——裁决/超时拒答 reply 的
   *  x-opencode-directory（引擎待审按 location 实例分仓；bridge 注入 sessions 映射） */
  directoryOf?: (userId: string) => string | undefined
}

export interface PermissionGate {
  hasPending: (userId: string) => boolean
  getPending: (userId: string) => PendingPermission | undefined
  waitForDecision: (
    ctx: MessageContext,
    request: PermissionRequest,
    mainSessionId: string,
  ) => Promise<PermissionDecision>
  resolve: (userId: string, decision: PermissionDecision) => void
  restore: () => void
  // L 项（2026-10-30）：常驻监听器发现的外部审批（如桌面端回合发起）——注册
  // "无活 waiter"槽（restored 语义：裁决走直连 reply），推卡片/文字菜单
  pushExternal: (userId: string, ctx: MessageContext, request: PermissionRequest, mainSessionId: string, origin?: PermOrigin) => void
  /** 联动清槽（2026-11-09）：SSE permission.replied={sessionID,requestID,reply} 到达时，
   *  若该 requestID 在挂起槽中（无论来源 bot/external），清槽 + QQ 回执「源头已处理」，
   *  并唤醒队列。返回 true=确有槽被清。无匹配槽返回 false（正常：QQ 已先裁决）。 */
  clearIfResolved: (sessionID: string | undefined, requestID: string, reply: unknown) => boolean
}

// 审批域门面：挂起槽 + 等待/裁决 + 跨重启恢复。所有状态与文件读写收在本域。
export function createPermissionGate(deps: PermissionGateDeps): PermissionGate {
  const { client, sendReply, safeDeliver } = deps
  const pendingPermissions = new Map<string, PendingPermission>()

  function hasPending(userId: string): boolean {
    return pendingPermissions.has(userId)
  }

  function getPending(userId: string): PendingPermission | undefined {
    return pendingPermissions.get(userId)
  }

  // design §3.6 权限保险网：10min 无裁决告警。只报一次（计时器随建槽设置、
  // 随裁决/TTL/清槽取消）；到点时槽位仍属于同一请求才发，防误报旧请求。
  function startNudgeTimer(userId: string, requestId: string, ctx: MessageContext): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      if (pendingPermissions.get(userId)?.request.id !== requestId) return
      console.log(`[perm] 10min 无裁决告警 user=${userId.slice(0, 8)}… request=${requestId}`)
      void safeDeliver(
        ctx,
        "⏳ 一条审批已等待 10 分钟未裁决，30 分钟到期将自动拒绝。如需继续请尽快裁决（允许/总是/拒绝）。",
      ).catch(() => {})
    }, deps.nudgeMs ?? PERM_NUDGE_MS)
    t.unref?.()
    return t
  }

  function clearTimers(entry: PendingPermission): void {
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.alertTimer) clearTimeout(entry.alertTimer)
  }

  // promptAndWait 的 onPermission 回调：推 QQ 审批菜单，挂起等待用户回复。
  // 只有 用户回复 或 30 分钟 TTL 会 resolve —— 后者自动拒绝，避免永久挂起。
  function waitForDecision(
    ctx: MessageContext,
    request: PermissionRequest,
    mainSessionId: string,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      // DEF-qqbot-20261112-3（2026-11-12 ZERO3 实测双卡实证）：SSE 即时推送路径
      // （flushPermPush→pushExternal）可能已为同一请求建槽推卡——promptAndWait 轮询
      // 路径随后发现同请求再进 waitForDecision 时，必须收养既有槽（换真 resolver、
      // 刷 TTL、清 restored），绝不再推第二张卡。修复前轮询失明掩盖了该竞态。
      const existing = pendingPermissions.get(ctx.userId)
      if (existing && existing.request.id === request.id) {
        clearTimers(existing)
        const adopted: PendingPermission = {
          ...existing,
          resolve,
          mainSessionId,
          ctx,
          createdAt: Date.now(),
          restored: false, // 收养后裁决走 entry.resolve（真 waiter），非直连 reply
          directory: deps.directoryOf?.(ctx.userId),
          origin: "bot",
        }
        adopted.alertTimer = startNudgeTimer(ctx.userId, request.id, ctx)
        adopted.timer = setTimeout(() => {
          if (pendingPermissions.get(ctx.userId)?.request.id === request.id) {
            pendingPermissions.delete(ctx.userId)
            savePendingPermMap(pendingPermissions)
            deps.onDecision?.(ctx.userId) // TTL 自动拒绝也要唤醒被守卫挡回的队列
            resolve("reject")
            void safeDeliver(ctx, "审批超时（30 分钟），已自动拒绝该权限请求").catch(() => {})
          }
        }, PERM_PROMPT_TTL_MS)
        adopted.timer.unref?.()
        pendingPermissions.set(ctx.userId, adopted)
        savePendingPermMap(pendingPermissions)
        console.log(`[perm] 同请求收养既有审批槽（不重复推卡）user=${ctx.userId.slice(0, 8)}… request=${request.id}`)
        return
      }
      const createdAt = Date.now()
      // DEF-qqbot-20261110-3（P2，2026-11-10 实战实证）：覆写单一槽前必须先清旧槽
      // 计时器——SSE pushExternal 先建的 external 槽被本 waiter 覆写后，其 TTL/告警
      // 计时器仍按同 request.id 挂表，30min 到点会误删新 waiter 槽、把正在等的
      // 回合自动拒绝（旧 restored 槽 resolve 为 noop，无需代答）。
      const stale = pendingPermissions.get(ctx.userId)
      if (stale) clearTimers(stale)
      const alertTimer = startNudgeTimer(ctx.userId, request.id, ctx)
      const timer = setTimeout(() => {
        if (pendingPermissions.get(ctx.userId)?.request.id === request.id) {
          pendingPermissions.delete(ctx.userId)
          savePendingPermMap(pendingPermissions)
          deps.onDecision?.(ctx.userId) // TTL 自动拒绝也要唤醒被守卫挡回的队列
          resolve("reject")
          // 2026-11-04 修复（DEF-qqbot-20261104-3）：超时回执改走 safeDeliver——
          // 原裸 sendReply 投递失败被 .catch 静默吞掉，用户收不到任何超时通知。
          void safeDeliver(ctx, "审批超时（30 分钟），已自动拒绝该权限请求").catch(() => {})
        }
      }, PERM_PROMPT_TTL_MS)
      timer.unref?.() // 不阻塞进程退出（测试链收尾；生产为长驻进程无影响）

      pendingPermissions.set(ctx.userId, {
        request,
        mainSessionId,
        resolve,
        timer,
        alertTimer,
        ctx,
        createdAt,
        origin: "bot", // 机器人自己回合的权限（bridge onPermission 直答路径）
        directory: deps.directoryOf?.(ctx.userId),
      })
      savePendingPermMap(pendingPermissions) // O2：落盘，重启不丢
      // A 项（2026-10-29）：卡片按钮优先，发送失败降级文字菜单；两者都失败
      // 不 reject promise（用户仍可能稍后主动回复）
      void (async () => {
        const sentByCard = deps.sendApprovalPrompt
          ? await deps.sendApprovalPrompt(ctx, request, mainSessionId, "bot").catch(() => false)
          : false
        if (!sentByCard) {
          await sendReply(ctx, formatPermissionPrompt(request, mainSessionId, "bot")).catch((error) => {
            console.error("[bridge] 发送审批请求失败:", error)
          })
        }
      })()
    })
  }

  function resolve(userId: string, decision: PermissionDecision): void {
    const entry = pendingPermissions.get(userId)
    if (!entry) return
    clearTimers(entry)
    pendingPermissions.delete(userId)
    savePendingPermMap(pendingPermissions)
    deps.onDecision?.(userId) // 裁决即唤醒队列（drainQueue 的 pendingPerm 守卫此刻已放行）
    if (entry.restored) {
      // O2（P2-4a）：跨重启——原 waiter 已随进程消失，直连 POST reply 争取
      // 原位生效；会话已不在等待则明确回执"重新发起"，绝不灌会话当普通消息
      void (async () => {
        const label = decision === "always" ? "总是允许" : decision === "once" ? "允许" : "拒绝"
        try {
          await client.permission.reply({
            path: { sessionID: entry.request.sessionID, requestID: entry.request.id },
            body: { decision },
            directory: entry.directory,
          })
          // DEF-qqbot-20261110-7：只有真跨重启恢复的条目才补回执。实时推送
          // （pushExternal）的审批在 QQ 点击后卡片/菜单本身已有选择回显，
          // 再发"已跨重启完成"既是误报也会重复刷屏。
          if (entry.resumedFromDisk) {
            await safeDeliver(entry.ctx, `✅ 审批已跨重启完成（${label}），原会话已继续`)
          } else {
            console.log(
              `[perm] 实时审批已裁决 user=${userId.slice(0, 8)}… request=${entry.request.id} decision=${decision}`,
            )
          }
        } catch (error) {
          // 2026-11-05 用户拍板：失败按类型区分文案——过期副本（点的是旧卡片）明确说
          // "重新发起"，服务异常才说"稍后重试"，不再一句"可能已失效"糊在一起。
          if (classifyApprovalReplyError(error) === "expired") {
            await safeDeliver(
              entry.ctx,
              "⚠️ 审批等待超时：服务端已自动拒绝。请重新发起原操作，新审批会正常生效",
            )
          } else {
            await safeDeliver(
              entry.ctx,
              `⚠️ 审批转发失败（${error instanceof Error ? error.message : String(error)}），请稍后重试；若仍未生效请重新发起原操作`,
            )
          }
        }
      })()
      return
    }
    entry.resolve(decision)
  }

  // O2（P2-4a）：恢复重启前挂起的审批（30min TTL 内有效）；恢复条目超时则
  // 直连 reject 解阻塞会话（原 waiter 已不存在，无人代答）
  function restore(): void {
    const saved = (deps.loadPending ?? loadPendingPermMap)()
    for (const [uid, e] of Object.entries(saved)) {
      const left = PERM_PROMPT_TTL_MS - (Date.now() - e.createdAt)
      if (left <= 0) continue
      // 保险网告警按 createdAt 对齐：恢复时若 10min 点已过则不再补报
      const nudgeLeft = PERM_NUDGE_MS - (Date.now() - e.createdAt)
      const alertTimer = nudgeLeft > 0 ? startNudgeTimer(uid, e.request.id, e.ctx) : null
      const timer = setTimeout(() => {
        if (pendingPermissions.get(uid)?.request.id === e.request.id) {
          pendingPermissions.delete(uid)
          savePendingPermMap(pendingPermissions)
          void client.permission
            .reply({
              path: { sessionID: e.request.sessionID, requestID: e.request.id },
              body: { decision: "reject" },
              directory: deps.directoryOf?.(uid),
            })
            .catch(() => {})
          void safeDeliver(e.ctx, "审批超时（30 分钟），已自动拒绝该权限请求").catch(() => {})
          deps.onDecision?.(uid) // 恢复槽 TTL 拒绝也要唤醒队列
        }
      }, left)
      timer.unref?.()
      pendingPermissions.set(uid, {
        request: e.request,
        mainSessionId: e.mainSessionId,
        resolve: () => {},
        timer,
        alertTimer,
        ctx: e.ctx,
        createdAt: e.createdAt,
        restored: true,
        resumedFromDisk: true, // DEF-qqbot-20261110-7：真跨重启条目，裁决后补回执
        ...(e.origin ? { origin: e.origin } : {}),
        directory: deps.directoryOf?.(uid),
      })
      console.log(`[perm] 恢复重启前挂起的审批 ${uid.slice(0, 8)}… request=${e.request.id}`)
      // 恢复即重推审批卡片（卡片优先，失败降级文字）——重启后用户必须能重新
      // 看到可点按钮；旧行为只注册槽位不推送，用户收不到任何审批入口（2026-11-05
      // 按钮丢失事故：重启后只剩文字重发路径，按钮再也出不来）。
      void (async () => {
        const sentByCard = deps.sendApprovalPrompt
          ? await deps.sendApprovalPrompt(e.ctx, e.request, e.mainSessionId, e.origin).catch(() => false)
          : false
        if (!sentByCard) {
          await sendReply(e.ctx, formatPermissionPrompt(e.request, e.mainSessionId, e.origin)).catch((error) => {
            console.error("[bridge] 恢复审批推送失败:", error)
          })
        }
      })()
    }
  }

  // L 项（2026-10-30）：常驻交互监听器发现外部审批时的注册入口。与 restore() 同款
  // "无活 waiter"槽：用户在 QQ 裁决后 resolve() 走直连 POST reply（restored 路径），
  // 并回执"已从 QQ 批准"。同 request.id 已在挂起则去重。
  function pushExternalImpl(
    userId: string,
    ctx: MessageContext,
    request: PermissionRequest,
    mainSessionId: string,
    origin: PermOrigin = "external",
  ): void {
    if (pendingPermissions.get(userId)?.request.id === request.id) return
    // 单一挂起槽：新审批取代旧槽
    const prev = pendingPermissions.get(userId)
    if (prev) clearTimers(prev)

    const alertTimer = startNudgeTimer(userId, request.id, ctx)
    const directory = deps.directoryOf?.(userId)
    const timer = setTimeout(() => {
      if (pendingPermissions.get(userId)?.request.id !== request.id) return
      pendingPermissions.delete(userId)
      savePendingPermMap(pendingPermissions)
      deps.onDecision?.(userId) // 外部审批 TTL 拒绝也要唤醒队列
      void client.permission
        .reply({ path: { sessionID: request.sessionID, requestID: request.id }, body: { decision: "reject" }, directory })
        .catch(() => {})
      void safeDeliver(ctx, "审批超时（30 分钟），已自动拒绝该权限请求").catch(() => {})
    }, PERM_PROMPT_TTL_MS)
    timer.unref?.()

    pendingPermissions.set(userId, {
      request,
      mainSessionId,
      resolve: () => {},
      timer,
      alertTimer,
      ctx,
      createdAt: Date.now(),
      restored: true,
      origin, // DEF-qqbot-20261110-4：来源按回合归属传入（bot=QQ 回合 / external=桌面回合），不再一律桌面
      directory,
    })
    savePendingPermMap(pendingPermissions)
    console.log(`[perm] 外部审批已推送 user=${userId.slice(0, 8)}… request=${request.id} action=${request.action} origin=${origin}`)
    // 推送失败不撤槽（用户仍可能文字裁决）
    void (async () => {
      const sentByCard = deps.sendApprovalPrompt
        ? await deps.sendApprovalPrompt(ctx, request, mainSessionId, origin).catch(() => false)
        : false
      if (!sentByCard) {
        await sendReply(ctx, formatPermissionPrompt(request, mainSessionId, "external")).catch((error) => {
          console.error("[bridge] 发送审批请求失败:", error)
        })
      }
    })()
  }

  // 联动清槽（2026-11-09）：SSE permission.replied={sessionID,requestID,reply} 到达时，
  // 若该 requestID 在挂起槽中（无论来源 bot/external），清槽 + QQ 回执「源头已处理」，
  // 并唤醒队列。返回 true=确有槽被清；无匹配槽返回 false（正常：QQ 已先裁决 兜底 TTL 已走）。
  function clearIfResolved(sessionID: string | undefined, requestID: string, reply: unknown): boolean {
    for (const [uid, entry] of pendingPermissions) {
      if (entry.request.id !== requestID) continue
      if (sessionID && entry.request.sessionID && sessionID !== entry.request.sessionID) continue
      const e = entry
      clearTimers(e)
      pendingPermissions.delete(uid)
      savePendingPermMap(pendingPermissions)
      deps.onDecision?.(uid) // 槽清空即唤醒该用户队列（与裁决/TTL 同口径）
      const label =
        reply === "allow" || reply === "once"
          ? "允许（本次）"
          : reply === "always"
            ? "总是允许"
            : reply === "reject"
              ? "拒绝"
              : `已处理（${String(reply ?? "未知")}）`
      console.log(`[perm] 联动清槽（源头已解决）：uid=${uid.slice(0, 8)}… request=${requestID} reply=${String(reply)}`)
      void safeDeliver(
        e.ctx,
        `🔄 审批 ${requestID.slice(-8)} 已由${e.origin === "bot" ? "机器人回合侧" : "桌面端"}处理（${label}），QQ 审批自动关闭`,
      ).catch(() => {})
      return true
    }
    return false
  }

  return { hasPending, getPending, waitForDecision, resolve, restore, pushExternal: pushExternalImpl, clearIfResolved }
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

export function formatPermissionPrompt(
  request: PermissionRequest,
  mainSessionId?: string,
  origin?: PermOrigin,
): string {
  const lines = ["🔐 需要权限审批", `动作：${request.action || "(未知)"}`]
  if (origin === "external") {
    // 2026-11-09 联动修复：桌面端发起的回合经事件流镜像到 QQ——标注来源，
    // 用户一眼知道这卡是桌面 AI 的活；QQ 与桌面审批等效（先到先解）。
    lines.push("来源：桌面端回合（bot 镜像推送；QQ 与桌面放行等效）")
  }
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
