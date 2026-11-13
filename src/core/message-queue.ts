// @input:  ../qq/types（MessageContext）
// @output: MessageQueue, QueuedJob, laneKeyOf, userIdOfLane, sessionIdOfLane, previewText, agoLabel
// @pos:    core - 忙碌消息队列（Q1 学习自 pi-qqbot queue.ts 的 UX 语义）
//
// 旧行为：忙碌时直接拒绝"上一条消息还在处理中"。新行为（学习竞品）：
// 忙时消息 FIFO 排队并回执，当前回合结束自动 drain 下一条；/cancel 清队。
// 控制面（/queue、审批作答、表单作答）永远即时处理，不进队列。
//
// 会话隔离（owner 2026-11-14 裁定，DEF-qqbot-20261112-01 修法①）：
// 队列按 (userId, sessionId) 分 lane——官方 per-peer 串行的会话级细腻化。
// 僵尸/长回合只堵所在 lane；入队即锚定 sessionId 快照，drain 按锚定会话派发。
// 票号仍按用户单调递增（#N 是用户可见身份键，跨 lane 不复用）。
import type { MessageContext } from "../qq/types.js"

export interface QueuedJob {
  id: number
  userId: string
  /** 入队锚定的目标会话（owner 2026-11-14：快照于入队时刻；派发/drain 跟锚定不跟漂移绑定） */
  sessionId?: string
  ctx: MessageContext
  text: string
  enqueuedAt: number
}

/** lane 键 = userId|sessionId；无绑定消息落 null lane（sessionId 段为空串）。 */
export function laneKeyOf(userId: string, sessionId: string | null | undefined): string {
  return `${userId}|${sessionId ?? ""}`
}

export function userIdOfLane(laneKey: string): string {
  const i = laneKey.indexOf("|")
  return i < 0 ? laneKey : laneKey.slice(0, i)
}

export function sessionIdOfLane(laneKey: string): string | undefined {
  const i = laneKey.indexOf("|")
  const sid = i < 0 ? "" : laneKey.slice(i + 1)
  return sid || undefined
}

const PREVIEW_MAX = 48

/** 忙碌期间的用户意图键：msgId 不同的重复提问/同图重发仍视为同一意图。 */
export function intentKeyOf(ctx: MessageContext): string {
  const text = ctx.content.replace(/\s+/g, " ").trim()
  const attachments = (ctx.attachments ?? []).map((a) => `${a.content_type}:${a.size}:${a.filename}`).join("|")
  return JSON.stringify({ text: stableIntentText(text), referenced: ctx.referencedMsgId ?? "", attachments })
}

/**
 * design §3.4 K2「稳定尾段随机段」：剥离文本尾部的随机段（nonce/时间戳/消息指纹类
 * 尾巴），使带随机尾巴的同内容消息仍归同一意图。口径保守，只剥两类尾 token——
 * ① 长度 ≥8 且字母数字混杂的连续 token（nonce/hex/base64 形态）；
 * ② 长度 ≥6 的纯数字 token（毫秒/微秒时间戳形态）。
 * 剥后留白即再剥（多层尾巴），剥到非随机 token 或空为止；不影响普通文本。
 */
export function stableIntentText(text: string): string {
  let out = text
  const NOISE = /(?:^|\s)(\S{8,}|\d{6,})$/
  for (;;) {
    const m = NOISE.exec(out)
    if (!m || m[1] === undefined) break
    // ① 混合形态：字母数字混杂（含大小写混合或数字插入）；纯字母词（如"继续"后的
    // 英文单词）或纯数字走 ② 的长度门槛，避免误伤正常结尾词
    const token = m[1]
    const mixedAlnum = /[a-zA-Z]/.test(token) && /\d/.test(token)
    const longDigit = /^\d{6,}$/.test(token)
    if (!mixedAlnum && !longDigit) break
    out = out.slice(0, m.index).trimEnd()
  }
  return out
}

export function previewText(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat || "(空消息)"
}

export function agoLabel(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s 前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m 前`
  return `${Math.floor(minutes / 60)}h 前`
}

export class MessageQueue {
  // lane（= userId|sessionId）-> 该 (用户,会话) 的 FIFO
  private jobs = new Map<string, QueuedJob[]>()
  // 票号按用户独立递增（2026-11-05）：全局计数器会让 A 用户看到 #7 而队列只有 1 条；
  // 票号只增不复用——它是身份/引用键，不是排队位置（位置由视图层单独计算）。
  // 2026-11-14 会话隔离：票号维持 per-user 单调（跨 lane 不复用）。
  private nextIds = new Map<string, number>()

  constructor(private limit = 20) {}

  private issueId(userId: string): number {
    const next = this.nextIds.get(userId) ?? 1
    this.nextIds.set(userId, next + 1)
    return next
  }

  /** 入队到指定 lane；满员返回 null（调用方回绝并提示） */
  push(laneKey: string, userId: string, sessionId: string | undefined, ctx: MessageContext): { job: QueuedJob; ahead: number } | null {
    const list = this.jobs.get(laneKey) ?? []
    if (list.length >= this.limit) return null
    const job: QueuedJob = { id: this.issueId(userId), userId, ctx, text: ctx.content, enqueuedAt: Date.now(), ...(sessionId ? { sessionId } : {}) }
    list.push(job)
    this.jobs.set(laneKey, list)
    return { job, ahead: list.length - 1 }
  }

  hasIntent(laneKey: string, key: string): boolean {
    return (this.jobs.get(laneKey) ?? []).some((job) => intentKeyOf(job.ctx) === key)
  }

  shift(laneKey: string): QueuedJob | undefined {
    const list = this.jobs.get(laneKey)
    const job = list?.shift()
    if (list && list.length === 0) this.jobs.delete(laneKey)
    return job
  }

  list(laneKey: string): readonly QueuedJob[] {
    return this.jobs.get(laneKey) ?? []
  }

  /** 该用户全部 lane 的条目，跨 lane 按入队时刻升序（视图/清场用） */
  listUser(userId: string): readonly QueuedJob[] {
    const out: QueuedJob[] = []
    for (const [laneKey, list] of this.jobs) {
      if (userIdOfLane(laneKey) === userId) out.push(...list)
    }
    return out.sort((a, b) => a.enqueuedAt - b.enqueuedAt)
  }

  /** 该用户在队的全部 lane 键（stopAll 后逐 lane 续排用） */
  laneKeysOf(userId: string): string[] {
    return [...this.jobs.keys()].filter((laneKey) => userIdOfLane(laneKey) === userId)
  }

  /** 按队列编号查单条（跨 lane 搜索；/queue drop 与 /ledger 对账用） */
  find(userId: string, id: number): QueuedJob | undefined {
    return this.listUser(userId).find((job) => job.id === id)
  }

  /** 队首（drain 前预读，不改变队列） */
  peek(laneKey: string): QueuedJob | undefined {
    return this.jobs.get(laneKey)?.[0]
  }

  /**
   * 重启恢复：按给定顺序重建指定 lane。id 缺省时续接该用户票号，
   * 显式 id 时同步推进该用户票号，保证后续入队编号不冲突。
   * 超过上限的部分不恢复，返回实际恢复条数。
   */
  restore(
    laneKey: string,
    userId: string,
    sessionId: string | undefined,
    jobs: Array<{ ctx: MessageContext; text: string; enqueuedAt: number; id?: number }>,
  ): number {
    const list = this.jobs.get(laneKey) ?? []
    let restored = 0
    for (const item of jobs) {
      if (list.length >= this.limit) break
      const explicit = Number.isInteger(item.id) && (item.id ?? 0) > 0 ? (item.id as number) : 0
      const id = explicit > 0 ? explicit : this.issueId(userId)
      if (id >= (this.nextIds.get(userId) ?? 1)) this.nextIds.set(userId, id + 1)
      list.push({ id, userId, ctx: item.ctx, text: item.text, enqueuedAt: item.enqueuedAt, ...(sessionId ? { sessionId } : {}) })
      restored++
    }
    if (list.length > 0) this.jobs.set(laneKey, list)
    return restored
  }

  /** 按票号跨 lane 删除（/queue drop） */
  drop(userId: string, id: number): boolean {
    for (const [laneKey, list] of this.jobs) {
      if (userIdOfLane(laneKey) !== userId) continue
      const idx = list.findIndex((j) => j.id === id)
      if (idx < 0) continue
      list.splice(idx, 1)
      if (list.length === 0) this.jobs.delete(laneKey)
      return true
    }
    return false
  }

  /** 清空该用户全部 lane，返回清掉的条数 */
  clear(userId: string): number {
    let n = 0
    for (const [laneKey, list] of this.jobs) {
      if (userIdOfLane(laneKey) !== userId) continue
      n += list.length
      this.jobs.delete(laneKey)
    }
    return n
  }

  size(laneKey: string): number {
    return this.jobs.get(laneKey)?.length ?? 0
  }

  /** 该用户全部 lane 的总长度（队列完成回执展示用） */
  sizeUser(userId: string): number {
    let n = 0
    for (const [laneKey, list] of this.jobs) {
      if (userIdOfLane(laneKey) === userId) n += list.length
    }
    return n
  }
}
