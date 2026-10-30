// @input:  ../opencode/client, ../qq/types, fs/path/os
// @output: createPermissionGate, parsePermissionDecision, formatPermissionPrompt, DECISION_LABELS, PERM_PROMPT_TTL_MS
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
  ctx: MessageContext // O2：落盘快照，跨重启直答用
  createdAt: number // O2：TTL 基准（落盘与恢复共用）
  restored?: boolean // O2：启动恢复条目（无活 waiter，走直连 reply）
}

export const PERM_PROMPT_TTL_MS = 30 * 60 * 1000

export const DECISION_LABELS: Record<PermissionDecision, string> = {
  once: "允许（本次）",
  always: "总是允许（已存入项目白名单）",
  reject: "拒绝",
}

// O2（2026-10-15，P2-4a）：审批中断态落盘——重启前挂起的审批重启后仍可
// 处置（直连 reply 或明确回执），不再出现"回复允许灌进会话当普通消息"的
// 误导路径。与 greeted/watch.json 同款风格（损坏即空）。
const PENDING_PERM_FILE = join(homedir(), ".openqq", "pending-permissions.json")

type PersistedPermission = {
  request: PermissionRequest
  mainSessionId: string
  createdAt: number
  ctx: MessageContext
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
      out[uid] = { request: e.request, mainSessionId: e.mainSessionId, createdAt: e.createdAt, ctx: e.ctx }
    }
    writeFileSync(PENDING_PERM_FILE, JSON.stringify(out))
  } catch (error) {
    console.warn("[perm] 审批态落盘失败:", error instanceof Error ? error.message : error)
  }
}

export interface PermissionGateDeps {
  client: OpencodeClient
  sendReply: (ctx: MessageContext, text: string) => Promise<void>
  safeDeliver: (ctx: MessageContext, text: string) => Promise<void>
  /** A 项（2026-10-29）：卡片按钮审批发送通道；返回 false 时本域自动降级文字菜单 */
  sendApprovalPrompt?: (ctx: MessageContext, request: PermissionRequest, mainSessionId: string) => Promise<boolean>
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
  pushExternal: (userId: string, ctx: MessageContext, request: PermissionRequest, mainSessionId: string) => void
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

  // promptAndWait 的 onPermission 回调：推 QQ 审批菜单，挂起等待用户回复。
  // 只有 用户回复 或 30 分钟 TTL 会 resolve —— 后者自动拒绝，避免永久挂起。
  function waitForDecision(
    ctx: MessageContext,
    request: PermissionRequest,
    mainSessionId: string,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingPermissions.get(ctx.userId)?.request.id === request.id) {
          pendingPermissions.delete(ctx.userId)
          savePendingPermMap(pendingPermissions)
          resolve("reject")
          void sendReply(ctx, "审批超时（30 分钟），已自动拒绝该权限请求").catch(() => {})
        }
      }, PERM_PROMPT_TTL_MS)

      pendingPermissions.set(ctx.userId, {
        request,
        mainSessionId,
        resolve,
        timer,
        ctx,
        createdAt: Date.now(),
      })
      savePendingPermMap(pendingPermissions) // O2：落盘，重启不丢
      // A 项（2026-10-29）：卡片按钮优先，发送失败降级文字菜单；两者都失败
      // 不 reject promise（用户仍可能稍后主动回复）
      void (async () => {
        const sentByCard = deps.sendApprovalPrompt
          ? await deps.sendApprovalPrompt(ctx, request, mainSessionId).catch(() => false)
          : false
        if (!sentByCard) {
          await sendReply(ctx, formatPermissionPrompt(request, mainSessionId)).catch((error) => {
            console.error("[bridge] 发送审批请求失败:", error)
          })
        }
      })()
    })
  }

  function resolve(userId: string, decision: PermissionDecision): void {
    const entry = pendingPermissions.get(userId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    pendingPermissions.delete(userId)
    savePendingPermMap(pendingPermissions)
    if (entry.restored) {
      // O2（P2-4a）：跨重启——原 waiter 已随进程消失，直连 POST reply 争取
      // 原位生效；会话已不在等待则明确回执"重新发起"，绝不灌会话当普通消息
      void (async () => {
        const label = decision === "always" ? "总是允许" : decision === "once" ? "允许" : "拒绝"
        try {
          await client.permission.reply({
            path: { sessionID: entry.request.sessionID, requestID: entry.request.id },
            body: { decision },
          })
          await safeDeliver(entry.ctx, `✅ 审批已跨重启完成（${label}），原会话已继续`)
        } catch {
          await safeDeliver(entry.ctx, "⚠️ 审批未能跨重启完成（原请求可能已失效），请重新发起原操作")
        }
      })()
      return
    }
    entry.resolve(decision)
  }

  // O2（P2-4a）：恢复重启前挂起的审批（30min TTL 内有效）；恢复条目超时则
  // 直连 reject 解阻塞会话（原 waiter 已不存在，无人代答）
  function restore(): void {
    const saved = loadPendingPermMap()
    for (const [uid, e] of Object.entries(saved)) {
      const left = PERM_PROMPT_TTL_MS - (Date.now() - e.createdAt)
      if (left <= 0) continue
      const timer = setTimeout(() => {
        if (pendingPermissions.get(uid)?.request.id === e.request.id) {
          pendingPermissions.delete(uid)
          savePendingPermMap(pendingPermissions)
          void client.permission
            .reply({
              path: { sessionID: e.request.sessionID, requestID: e.request.id },
              body: { decision: "reject" },
            })
            .catch(() => {})
          void safeDeliver(e.ctx, "审批超时（30 分钟），已自动拒绝该权限请求").catch(() => {})
        }
      }, left)
      pendingPermissions.set(uid, {
        request: e.request,
        mainSessionId: e.mainSessionId,
        resolve: () => {},
        timer,
        ctx: e.ctx,
        createdAt: e.createdAt,
        restored: true,
      })
      console.log(`[perm] 恢复重启前挂起的审批 ${uid.slice(0, 8)}… request=${e.request.id}`)
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
  ): void {
    if (pendingPermissions.get(userId)?.request.id === request.id) return
    // 单一挂起槽：新审批取代旧槽
    const prev = pendingPermissions.get(userId)
    if (prev?.timer) clearTimeout(prev.timer)

    const timer = setTimeout(() => {
      if (pendingPermissions.get(userId)?.request.id !== request.id) return
      pendingPermissions.delete(userId)
      savePendingPermMap(pendingPermissions)
      void client.permission
        .reply({ path: { sessionID: request.sessionID, requestID: request.id }, body: { decision: "reject" } })
        .catch(() => {})
      void safeDeliver(ctx, "审批超时（30 分钟），已自动拒绝该权限请求").catch(() => {})
    }, PERM_PROMPT_TTL_MS)

    pendingPermissions.set(userId, {
      request,
      mainSessionId,
      resolve: () => {},
      timer,
      ctx,
      createdAt: Date.now(),
      restored: true,
    })
    savePendingPermMap(pendingPermissions)
    console.log(`[perm] 外部审批已推送 user=${userId.slice(0, 8)}… request=${request.id} action=${request.action}`)
    // 推送失败不撤槽（用户仍可能文字裁决）
    void (async () => {
      const sentByCard = deps.sendApprovalPrompt
        ? await deps.sendApprovalPrompt(ctx, request, mainSessionId).catch(() => false)
        : false
      if (!sentByCard) {
        await sendReply(ctx, formatPermissionPrompt(request, mainSessionId)).catch((error) => {
          console.error("[bridge] 发送审批请求失败:", error)
        })
      }
    })()
  }

  return { hasPending, getPending, waitForDecision, resolve, restore, pushExternal: pushExternalImpl }
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
