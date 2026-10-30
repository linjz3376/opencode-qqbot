// @input:  ../config, ../qq/types, ../qq/api, ../qq/sender, fs/path/os
// @output: createDelivery
// @pos:    根层/core - 投递域（O7c 2026-10-15 自 bridge.ts 拆出：统一投递
//          被动→主动降级、日配额记账与落盘、观察推送节流队列、主动/被动通道发送）
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { Config } from "../config.js"
import type { MessageContext } from "../qq/types.js"
import { getAccessToken, sendC2CMessage, sendGroupMessage, getNextMsgSeq } from "../qq/api.js"
import { replyToQQ } from "../qq/sender.js"
import { ReplyLimiter } from "./reply-limiter.js"

// 用户级推送队列：节流合并（主动消息配额记账已移至 activeQuota 共享）
interface PushQueue {
  lastSent: number
  timer: ReturnType<typeof setTimeout> | null
  lines: string[]
}

// O5（2026-10-15，P2-4b）：主动配额落盘——跨重启不归零，防日配额轻微超发。
const QUOTA_FILE = join(homedir(), ".openqq", "quota.json")

function loadQuotaMap(): Record<string, { day: string; count: number; warned: boolean }> {
  try {
    if (existsSync(QUOTA_FILE)) {
      const raw = readFileSync(QUOTA_FILE, "utf-8")
      const obj = JSON.parse(raw)
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const out: Record<string, { day: string; count: number; warned: boolean }> = {}
        for (const [k, v] of Object.entries(obj)) {
          const e = v as { day?: unknown; count?: unknown; warned?: unknown }
          if (typeof e?.day === "string" && typeof e.count === "number") {
            out[k] = { day: e.day, count: e.count, warned: Boolean(e.warned) }
          }
        }
        return out
      }
    }
  } catch {
    // 损坏即空
  }
  return {}
}

function saveQuotaMap(m: ReadonlyMap<string, { day: string; count: number; warned: boolean }>): void {
  try {
    writeFileSync(QUOTA_FILE, JSON.stringify(Object.fromEntries(m)))
  } catch (error) {
    console.warn("[bridge] 配额落盘失败:", error instanceof Error ? error.message : error)
  }
}

// B-msgid 纯函数（导出供测试，2026-10-29）：挑选可"骑"的被动 msg_id——
// 同一聊天类型、时间戳在窗口内才有效；任何不对齐都返回 undefined（回落真主动）。
export function selectRideMsgId(
  last: MessageContext | undefined,
  ctx: MessageContext,
  now: number,
  windowMs: number,
): string | undefined {
  if (!last?.msgId) return undefined
  if (last.type !== ctx.type) return undefined
  const ts = Number(last.timestamp ?? 0)
  if (!Number.isFinite(ts) || ts <= 0) return undefined
  if (now - ts > windowMs) return undefined
  return last.msgId
}

export interface Delivery {
  enqueuePush: (userId: string, line: string) => void
  deliver: (ctx: MessageContext, text: string) => Promise<void>
  safeDeliver: (ctx: MessageContext, text: string) => Promise<void>
  sendReply: (ctx: MessageContext, text: string) => Promise<void>
}

// 投递域门面。lastCtx 为跨域共享状态（bridge 拥有写权），本域只读——
// 用于推送/批量行的被动窗口内降级判断与主动通道选择。
export function createDelivery(
  config: Config,
  lastCtx: ReadonlyMap<string, MessageContext>,
): Delivery {
  const PUSH_MIN_GAP_MS = 2000      // 用户级节流：最快 2 秒一批
  const PUSH_MAX_LINES = 6          // 队列上限：洪峰丢最旧，防积压
  // 债务D4（2026-10-13 官方文档查证）：主动消息频控 = 单关系 1000 条/天 + 20/qpm，
  // Bot 维度认证 10/qps（超限报 40034100）。原自设 15/天过度保守 → 默认 100 留
  // 余量，可用 env QQ_ACTIVE_DAILY_LIMIT 覆盖。
  const ACTIVE_DAILY_LIMIT = Number(process.env.QQ_ACTIVE_DAILY_LIMIT ?? 100)

  // B-msgid（2026-10-29，吸收 dsh transport/msgid-cache）：主动降级前尝试让发送
  // "骑"该用户最近的被动 msg_id——平台窗口内接受则按被动计（不耗主动配额）。
  // 窗口口径保守取 5 分钟（社区亦有 60 分钟说法；骑失败无副作用自动回落真主动，
  // 故从保守值起步，可用 QQ_PASSIVE_RIDE_WINDOW_MS 调整）。
  const RIDE_WINDOW_MS = (() => {
    const n = Number(process.env.QQ_PASSIVE_RIDE_WINDOW_MS ?? "300000")
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300_000
  })()

  // J-轻（2026-10-30，用户拍板固化）：伪流式错峰——多片回复片间间隔（默认 300ms），
  // 配合 B3 typing 指示，长答案逐段到达体感近打字机；0=关闭恢复一次性全发。
  const STREAM_STAGGER_MS = (() => {
    const n = Number(process.env.QQ_STREAM_STAGGER_MS ?? "300")
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300
  })()

  const pushQueues = new Map<string, PushQueue>()
  const activeQuota = new Map<string, { day: string; count: number; warned: boolean }>()
  // B1（2026-10-29，吸收自 openclaw-qqbot reply-limiter）：被动回复限额预判——
  // 单 msgId 4 次/1h 窗口，耗尽/过期直接转主动，省一次注定被拒的 API 往返。
  // 记账点在 sendReply 成功路径（统一出口，bridge 直调与 deliver 共用）。
  const passiveLimiter = new ReplyLimiter()
  // O5：恢复落盘配额（非当日条目由 deliver 按 day 字段自然重置）
  for (const [uid, q] of Object.entries(loadQuotaMap())) activeQuota.set(uid, q)

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

  // 统一投递：被动回复优先（ctx.msg_id，5 分钟窗口内、无配额消耗）；
  // 窗口过期/失败降级主动消息（计日配额，超限告警一次）。
  // 观察推送与最终回复共用——超长回合（>被动窗口）的答案靠它送达
  //（2026-10-13 实测教训：回合 >5 分钟时旧路径答案永久丢失）。
  async function deliver(ctx: MessageContext, text: string): Promise<void> {
    // B1：被动尝试前预判额度，耗尽/过期直接走主动（避免注定被拒的被动请求）
    const passive = ctx.msgId ? passiveLimiter.checkLimit(ctx.msgId) : null
    if (passive?.shouldFallbackToProactive) {
      console.log(
        `[bridge] 被动回复${passive.fallbackReason === "expired" ? "窗口已过期" : "次数已耗尽"}，直接走主动通道: msgId=${ctx.msgId}`,
      )
    } else {
      try {
        await sendReply(ctx, text)
        return
      } catch (error) {
        console.warn(
          "[bridge] 被动回复失败（可能超 5 分钟窗口），降级主动消息:",
          error instanceof Error ? error.message : error,
        )
      }
    }

    // B-msgid（吸收 dsh msgid-cache，2026-10-29）：主动降级前尝试"骑"该用户最近
    // 的被动 msg_id——平台窗口内接受则按被动计（不耗主动配额、记 B1 账本）；
    // 骑失败无副作用，回落下方真主动流程。
    const rideMsgId = selectRideMsgId(lastCtx.get(ctx.userId), ctx, Date.now(), RIDE_WINDOW_MS)
    if (rideMsgId) {
      try {
        await sendActive(ctx, text, rideMsgId)
        passiveLimiter.record(rideMsgId)
        console.log(`[bridge] 主动降级已骑被动窗口 msgId=${rideMsgId}，省一次主动配额`)
        return
      } catch {
        console.log("[bridge] 骑被动窗口失败（窗口可能已过），回落真主动消息")
      }
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
        saveQuotaMap(activeQuota) // O5：告警态也落盘
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
    saveQuotaMap(activeQuota) // O5：计数落盘，跨重启不归零
  }

  async function safeDeliver(c: MessageContext, text: string): Promise<void> {
    try {
      await deliver(c, text)
    } catch (error) {
      console.error("[bridge] 消息无法送达（被动+主动均失败）:", error)
    }
  }

  // 主动消息（不带 msg_id）：markdown 优先，失败回退纯文本。
  // passiveMsgId（B-msgid 2026-10-29）："骑"被动窗口时传入，平台接受则按被动计。
  async function sendActive(ctx: MessageContext, text: string, passiveMsgId?: string): Promise<void> {
    const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    const seq = getNextMsgSeq(passiveMsgId ?? "")
    const isGroup = ctx.type === "group" && ctx.groupId
    try {
      if (isGroup) await sendGroupMessage(token, ctx.groupId!, text, passiveMsgId, seq, true)
      else await sendC2CMessage(token, ctx.userId, text, passiveMsgId, seq, true)
      return
    } catch (error) {
      console.error("[bridge] 主动 markdown 发送失败，回退纯文本:", error)
    }
    if (isGroup) await sendGroupMessage(token, ctx.groupId!, text, passiveMsgId, seq, false)
    else await sendC2CMessage(token, ctx.userId, text, passiveMsgId, seq, false)
  }

  async function sendReply(ctx: MessageContext, text: string): Promise<void> {
    const accessToken = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    // J-轻：伪流式错峰（多片时隔 300ms 逐段到达）；replyToQQ 返回实际片数
    const chunks = await replyToQQ(accessToken, ctx, text, config.maxReplyLength, {
      staggerMs: STREAM_STAGGER_MS,
    })
    // B1：被动回复成功才记额度（失败不计，避免虚耗）；按片记账——平台限额按"条"计，
    // 多片回复此前少计 N-1（J-轻顺手修正）；bridge 直调与 deliver 共用此出口
    if (ctx.msgId) {
      for (let i = 0; i < chunks; i++) passiveLimiter.record(ctx.msgId)
    }
  }

  return { enqueuePush, deliver, safeDeliver, sendReply }
}
