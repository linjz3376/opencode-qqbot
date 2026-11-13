// @input:  ../config, ../qq/types, ../qq/api, ../qq/sender, fs/path/os
// @output: createDelivery
// @pos:    根层/core - 投递域（O7c 2026-10-15 自 bridge.ts 拆出：统一投递
//          被动→主动降级、日配额记账与落盘、观察推送节流队列、主动/被动通道发送）
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, statSync } from "fs"
import { join } from "path"
import { createHash } from "node:crypto"
import { homedir } from "os"
import type { Config } from "../config.js"
import type { MessageContext } from "../qq/types.js"
import { getAccessToken, sendC2CMessage, sendGroupMessage, getNextMsgSeq } from "../qq/api.js"
import { replyToQQ } from "../qq/sender.js"
import { matchFence, normalizeOutboundMarkdown } from "./markdown.js"
import { ReplyLimiter } from "./reply-limiter.js"
import { recordMessage, scopeKeyOf } from "./context-buffer.js"

// 用户级推送队列：节流合并（主动消息配额记账已移至 activeQuota 共享）。
// 每行带可选锚定会话（owner 2026-11-14 出站推送门）：flush 时按锚定分组、逐组校验当前绑定。
interface PushQueue {
  lastSent: number
  timer: ReturnType<typeof setTimeout> | null
  lines: Array<{ line: string; anchor?: string }>
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

// P 项（2026-10-30，吸收竞品 pendingNotice 模式）：发送彻底失败不静默——
// 记"有未送达消息"，下一次成功投递时前缀贴条告知用户（导出供测试）。
export const UNDELIVERED_NOTICE = "（此前有未能送达的消息）\n"

// QQ 渲染适配（2026-11-03 用户双端截图实证）：QQ 官方 markdown 渲染器把跨
// 段落的有序列表续接编号（原文 1./2. 渲染成 3./4.），与桌面端所见不一致。
// 对策=列表标记 `N.` 统一改写为 `N)`：非 CommonMark 列表语法 → 字面保留，
// 编号所见即原文，桌面与 QQ 端逐字一致；变换幂等（N) 不再被任何渲染器续编）。
// 代码围栏（```/~~~）内不动；仅行首（含缩进）的 `N. ` 命中，行内「1.5 版本」
// 类文本无空格不受影响。导出供测试。
// 顿号实测（2026-11-03 用户截图回传）：「N、」与「一、」在 QQ 被动通道 100% 保真，
// 「N.」却被整条消息全局续编（连行内点号数字都会渗染起始值）。所以平面化目标
// 从 N) 升级为 N、——与原生顿号列表视觉一致，编号所见即原文。
// 变换幂等（N、 再进来不匹配行首 N. 模式，原样通过）。
// design §3.7 三层对策之第 3 层「提示词约束」：在 prompt 侧引导模型少用 QQ
// 渲染不稳的 markdown 有序列表/表格（第 1 层=出站平面化 qqListNormalize，第 2 层=
// markdown 发送失败回落纯文本，见下方 sendMarkdown 回退）。随每条用户消息注入。
export const QQ_LIST_FORMAT_HINT =
  "\n\n（输出格式约定：本对话经 QQ 渲染，请用「1、2、3、」顿号或「-」无序列表代替 markdown 有序列表，避免表格；代码块不受影响可正常使用。）"

export function qqListNormalize(text: string): string {
  const lines = text.split("\n")
  let fence: { ch: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    // 围栏识别与出站兜底同源（core/markdown）：支持 ``` 与 ~~~、4+ 标记长度。
    const fm = matchFence(lines[i])
    if (fm) {
      if (!fence) fence = { ch: fm.ch, len: fm.len }
      else if (fm.ch === fence.ch && fm.len >= fence.len && fm.info === "") fence = null
      continue
    }
    if (fence) continue
    lines[i] = lines[i].replace(/^(\s*)(\d+)\. /, "$1$2、")
  }
  return lines.join("\n")
}

export interface DeliveryAttempt {
  text: string
  at: number
}

export const DELIVERY_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000
// P0 同族修复（2026-11-03）：原 const 在模块加载期捕获 QQ_DELIVERY_DEDUPE_FILE，
// .env 运行时才注入——测试/多目录重定向永远不生效。改惰性函数。
function deliveryDedupeFile(): string {
  return process.env.QQ_DELIVERY_DEDUPE_FILE || join(homedir(), ".openqq", "delivery-dedupe.json")
}

function deliveryAttemptKey(userId: string, text: string): string {
  return `${userId}:${createHash("sha256").update(text).digest("hex")}`
}

/** AI 长回复的同文幂等：不同 location/重复回合可产生不同事件 ID，最终统一在出站拦截。 */
export function shouldSuppressDuplicate(
  previous: DeliveryAttempt | undefined,
  text: string,
  now: number,
  ttlMs = DELIVERY_DEDUPE_TTL_MS,
  identity = text,
): boolean {
  // 长度必须看原始正文；identity 可能是较短的 userId:sha256 键，不能拿它做长文门槛。
  return text.length >= 200 && previous?.text === identity && now - previous.at < ttlMs
}

// 仅存用户键+内容哈希，不把回复正文写进运行数据。跨重启也能识别同文回复。
function loadDeliveryAttempts(): Map<string, DeliveryAttempt> {
  const out = new Map<string, DeliveryAttempt>()
  try {
    if (!existsSync(deliveryDedupeFile())) return out
    const raw = JSON.parse(readFileSync(deliveryDedupeFile(), "utf-8")) as Array<{ key: string; at: number }>
    const now = Date.now()
    for (const entry of raw) {
      if (typeof entry?.key === "string" && Number.isFinite(entry.at) && now - entry.at < DELIVERY_DEDUPE_TTL_MS) {
        out.set(entry.key, { text: entry.key, at: entry.at })
      }
    }
  } catch {
    // 损坏则仅本轮无历史去重，不阻塞启动
  }
  return out
}

function saveDeliveryAttempts(entries: ReadonlyMap<string, DeliveryAttempt>): void {
  const raw = [...entries.values()]
    .filter((entry) => Date.now() - entry.at < DELIVERY_DEDUPE_TTL_MS)
    .map((entry) => ({ key: entry.text, at: entry.at }))
  mkdirSync(join(deliveryDedupeFile(), ".."), { recursive: true })
  const tmp = `${deliveryDedupeFile()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 })
    renameSync(tmp, deliveryDedupeFile())
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 已改名或清理失败 */ }
    throw error
  }
}

// 多执行体共用同一把短文件锁：读取→判定→占位必须原子完成，否则不同进程会同时放行同文回复。
const DELIVERY_LOCK_STALE_MS = 30_000
const DELIVERY_LOCK_WAIT_MS = 5_000
const deliverySleepArray = new Int32Array(new SharedArrayBuffer(4))

function withDeliveryLock<T>(fn: () => T): T {
  mkdirSync(join(deliveryDedupeFile(), ".."), { recursive: true })
  const lockPath = `${deliveryDedupeFile()}.lock`
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + DELIVERY_LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600)
      try { writeFileSync(fd, token) } finally { closeSync(fd) }
      break
    } catch (error) {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > DELIVERY_LOCK_STALE_MS) unlinkSync(lockPath)
      } catch { /* 锁不存在/另一进程正在接管 */ }
      if (Date.now() >= deadline) throw new Error(`同文投递锁等待超时: ${error instanceof Error ? error.message : error}`)
      Atomics.wait(deliverySleepArray, 0, 0, 10)
    }
  }
  try {
    return fn()
  } finally {
    try {
      if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath)
    } catch { /* 已被 stale 清理 */ }
  }
}

/** 返回占位键；24h 内同文长回复已占位时返回 null。发送失败必须按原时间戳释放。 */
export function reserveDeliveryAttempt(userId: string, text: string, now = Date.now()): string | null {
  const attemptKey = deliveryAttemptKey(userId, text)
  return withDeliveryLock(() => {
    const entries = loadDeliveryAttempts()
    if (shouldSuppressDuplicate(entries.get(attemptKey), text, now, DELIVERY_DEDUPE_TTL_MS, attemptKey)) return null
    entries.set(attemptKey, { text: attemptKey, at: now })
    saveDeliveryAttempts(entries)
    return attemptKey
  })
}

export function releaseDeliveryAttempt(userId: string, text: string, at: number): void {
  const attemptKey = deliveryAttemptKey(userId, text)
  withDeliveryLock(() => {
    const entries = loadDeliveryAttempts()
    if (entries.get(attemptKey)?.at === at) {
      entries.delete(attemptKey)
      saveDeliveryAttempts(entries)
    }
  })
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
  /** anchorSessionId=该观察行的锚定会话（出站推送门按它校验当前绑定，design §3.4） */
  enqueuePush: (userId: string, line: string, anchorSessionId?: string) => void
  /** 返回 true=实际出站成功；false=24h 去重拦截或推送门拦截（DEF-qqbot-20261110-9：调用方据此刻画销账口径） */
  deliver: (ctx: MessageContext, text: string) => Promise<boolean>
  /** 同 deliver；彻底失败时贴条待下次消化并返回 false */
  safeDeliver: (ctx: MessageContext, text: string) => Promise<boolean>
  sendReply: (ctx: MessageContext, text: string) => Promise<void>
}

// 投递域门面。lastCtx 为跨域共享状态（bridge 拥有写权），本域只读——
// 用于推送/批量行的被动窗口内降级判断与主动通道选择。
// pushGate=出站推送门（owner 2026-11-14）：锚定会话≠用户当前绑定即拦截。
export function createDelivery(
  config: Config,
  lastCtx: ReadonlyMap<string, MessageContext>,
  pushGate?: (userId: string, anchorSessionId: string) => boolean,
): Delivery {
  const PUSH_MIN_GAP_MS = 2000      // 用户级节流：最快 2 秒一批
  const PUSH_MAX_LINES = 6          // 队列上限：洪峰丢最旧，防积压
  // 债务D4（2026-10-13 官方文档查证）：主动消息频控 = 单关系 1000 条/天 + 20/qpm，
  // Bot 维度认证 10/qps（超限报 40034100）。原自设 15/天过度保守 → 默认 100 留
  // 余量，可用 env QQ_ACTIVE_DAILY_LIMIT 覆盖。
  const ACTIVE_DAILY_LIMIT = Number(process.env.QQ_ACTIVE_DAILY_LIMIT ?? 100)

  // B-msgid（2026-10-29，吸收自 dsh-qqbot 的 msgid 缓存机制）：主动降级前尝试让发送
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
  // P 项：彻底投递失败的用户集合（贴条状态），下次成功投递时消化
  const undelivered = new Set<string>()
  const activeQuota = new Map<string, { day: string; count: number; warned: boolean }>()
  // B1（2026-10-29，吸收自 openclaw-qqbot reply-limiter）：被动回复限额预判——
  // 单 msgId 4 次/1h 窗口，耗尽/过期直接转主动，省一次注定被拒的 API 往返。
  // 记账点在 sendReply 成功路径（统一出口，bridge 直调与 deliver 共用）。
  const passiveLimiter = new ReplyLimiter()
  // O5：恢复落盘配额（非当日条目由 deliver 按 day 字段自然重置）
  for (const [uid, q] of Object.entries(loadQuotaMap())) activeQuota.set(uid, q)

  function enqueuePush(userId: string, line: string, anchorSessionId?: string): void {
    let q = pushQueues.get(userId)
    if (!q) {
      q = { lastSent: 0, timer: null, lines: [] }
      pushQueues.set(userId, q)
    }
    if (q.lines.length >= PUSH_MAX_LINES) q.lines.shift()
    q.lines.push({ line, ...(anchorSessionId ? { anchor: anchorSessionId } : {}) })
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
    // 按锚定会话分组：同组行合并投递；锚定≠当前绑定的整组被推送门丢弃（历史可回读）。
    const batches: Array<{ anchor?: string; lines: string[] }> = []
    for (const item of q.lines.splice(0, q.lines.length)) {
      const last = batches[batches.length - 1]
      if (last && last.anchor === item.anchor) last.lines.push(item.line)
      else batches.push({ ...(item.anchor ? { anchor: item.anchor } : {}), lines: [item.line] })
    }
    q.lastSent = Date.now()
    for (const batch of batches) {
      if (batch.anchor && pushGate && !pushGate(userId, batch.anchor)) {
        console.log(
          `[push-gate] 观察推送整组拦截：绑定已切走 anchor=${batch.anchor.slice(0, 12)}… user=${userId.slice(0, 8)}… count=${batch.lines.length}`,
        )
        continue
      }
      const text = batch.lines.map((l) => `· ${l}`).join("\n")
      const outCtx: MessageContext = batch.anchor ? { ...ctx, anchorSessionId: batch.anchor } : ctx
      try {
        await deliver(outCtx, text)
      } catch (error) {
        undelivered.add(userId) // P 项：观察推送彻底失败 → 贴条待下次消化
        console.error("[bridge] 观察推送失败（被动+主动均失败，丢弃本批）:", error)
      }
    }
  }

  // 统一投递：被动回复优先（ctx.msg_id，5 分钟窗口内、无配额消耗）；
  // 窗口过期/失败降级主动消息（计日配额，超限告警一次）。
  // 观察推送与最终回复共用——超长回合（>被动窗口）的答案靠它送达
  //（2026-10-13 实测教训：回合 >5 分钟时旧路径答案永久丢失）。
  // P 项贴条包装：deliver 入口消化贴条状态——有待贴条则前缀拼入正文；
  // 投递失败则把贴条放回（留待下次），成功才算消化。
  async function deliver(ctx: MessageContext, text: string): Promise<boolean> {
    // 出站推送门（design §3.4，owner 2026-11-14 会话隔离裁定）：QQ 窗只呈现当前绑定
    // 会话——锚定会话≠当前绑定即不推（结果已入锚定会话历史，可经历史/桌面端回读）。
    if (ctx.anchorSessionId && pushGate && !pushGate(ctx.userId, ctx.anchorSessionId)) {
      console.log(
        `[push-gate] 出站拦截：绑定已切走 anchor=${ctx.anchorSessionId.slice(0, 12)}… user=${ctx.userId.slice(0, 8)}… chars=${text.length}`,
      )
      return false
    }
    const now = Date.now()
    // 跨进程原子占位：直答/镜像/恢复即使落在不同执行体，同文长回复也只放行一次。
    const attemptKey = reserveDeliveryAttempt(ctx.userId, text, now)
    if (!attemptKey) {
      console.log(`[bridge] 同文长回复已在 24h 内投递，跳过重复出站 user=${ctx.userId}`)
      return false
    }
    const hadNotice = undelivered.delete(ctx.userId)
    // QQ 渲染适配：有序列表改写，防 QQ 端跨段落续编（桌面所见=QQ 所见）
    const body = qqListNormalize(hadNotice ? UNDELIVERED_NOTICE + text : text)
    try {
      await deliverCore(ctx, body)
      return true
    } catch (error) {
      // 发送失败不占去重位，后续恢复/重试仍可送达。
      releaseDeliveryAttempt(ctx.userId, text, now)
      if (hadNotice) undelivered.add(ctx.userId)
      throw error
    }
  }

  async function deliverCore(ctx: MessageContext, text: string): Promise<void> {
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
        const rideIds = await sendActive(ctx, text, rideMsgId)
        passiveLimiter.record(rideMsgId)
        for (const id of rideIds) recordMessage(scopeKeyOf(ctx), id, text)
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
    const activeIds = await sendActive(ctx, text)
    for (const id of activeIds) recordMessage(scopeKeyOf(ctx), id, text)
    q.count++
    saveQuotaMap(activeQuota) // O5：计数落盘，跨重启不归零
  }

  async function safeDeliver(c: MessageContext, text: string): Promise<boolean> {
    try {
      return await deliver(c, text)
    } catch (error) {
      undelivered.add(c.userId) // P 项：最终失败 → 贴条待下次消化
      console.error("[bridge] 消息无法送达（被动+主动均失败）:", error)
      return false
    }
  }

  // 主动消息（不带 msg_id）：markdown 优先，失败回退纯文本。
  // passiveMsgId（B-msgid 2026-10-29）："骑"被动窗口时传入，平台接受则按被动计。
  // 返回服务端回执消息 id 列表（引用解析缓存登记用）。
  async function sendActive(ctx: MessageContext, text: string, passiveMsgId?: string): Promise<string[]> {
    const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    const seq = getNextMsgSeq(passiveMsgId ?? "")
    const isGroup = ctx.type === "group" && ctx.groupId
    // 主动 markdown 同样走围栏归一（与被动回复同口径，防未闭合/空围栏对渲染成空卡片）
    const mdText = normalizeOutboundMarkdown(text)
    try {
      if (isGroup) {
        const r = await sendGroupMessage(token, ctx.groupId!, mdText, passiveMsgId, seq, true)
        return r?.id ? [r.id] : []
      }
      const r = await sendC2CMessage(token, ctx.userId, mdText, passiveMsgId, seq, true)
      return r?.id ? [r.id] : []
    } catch (error) {
      console.error("[bridge] 主动 markdown 发送失败，回退纯文本:", error)
    }
    if (isGroup) {
      const r = await sendGroupMessage(token, ctx.groupId!, text, passiveMsgId, seq, false)
      return r?.id ? [r.id] : []
    }
    const r = await sendC2CMessage(token, ctx.userId, text, passiveMsgId, seq, false)
    return r?.id ? [r.id] : []
  }

  async function sendReply(ctx: MessageContext, text: string): Promise<void> {
    const accessToken = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    // J-轻：伪流式错峰（多片时隔 300ms 逐段到达）；replyToQQ 返回片数与服务端消息 id
    const result = await replyToQQ(accessToken, ctx, text, {
      staggerMs: STREAM_STAGGER_MS,
    })
    // B1：被动回复成功才记额度（失败不计，避免虚耗）；按片记账——平台限额按"条"计，
    // 多片回复此前少计 N-1（J-轻顺手修正）；bridge 直调与 deliver 共用此出口
    if (ctx.msgId) {
      for (let i = 0; i < result.chunks; i++) passiveLimiter.record(ctx.msgId)
    }
    // 缺口 1：我方出站回复登记进上下文缓存（引用解析可命中 AI 答案）
    const scope = scopeKeyOf(ctx)
    for (const id of result.ids) recordMessage(scope, id, text)
  }

  return { enqueuePush, deliver, safeDeliver, sendReply }
}

