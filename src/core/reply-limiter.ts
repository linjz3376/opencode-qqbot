// @input:  （无外部依赖，纯内存状态机）
// @output: ReplyLimiter, ReplyLimitResult, ReplyLimiterConfig
// @pos:    core - 被动回复限额器（B1，2026-10-29）
//
// 背景：QQ 官方规则 = 同一条消息（msgId）被动回复最多 4 次、窗口 1 小时。
// 限额耗尽或窗口过期后继续"被动回复"必然被平台拒绝，白白浪费一次 API 往返
// 且推迟送达。本模块在被动尝试前预判：不可被动 → 直接走主动通道（调用方
// 负责主动配额记账），可被动 → 放行并在发送成功后记账。
// 设计吸收自 tencent-connect/openclaw-qqbot（MIT）
// src/outbound/reply-limiter.ts——P0 官方实现，语义与默认参数照抄。
export interface ReplyLimiterConfig {
  /** 每条消息最大被动回复次数（官方规则 4） */
  limit?: number
  /** 消息 ID 被动窗口 TTL（官方规则 1 小时） */
  ttlMs?: number
  /** 最大跟踪消息数（FIFO 驱逐，防内存膨胀） */
  maxTrackedMessages?: number
}

export interface ReplyLimitResult {
  allowed: boolean
  remaining: number
  shouldFallbackToProactive: boolean
  fallbackReason?: "expired" | "limit_exceeded"
}

interface TrackedMessage {
  count: number
  firstSeenAt: number
}

export class ReplyLimiter {
  private readonly limit: number
  private readonly ttlMs: number
  private readonly maxTracked: number
  private readonly messages = new Map<string, TrackedMessage>()

  constructor(config?: ReplyLimiterConfig) {
    this.limit = config?.limit ?? 4
    this.ttlMs = config?.ttlMs ?? 3_600_000 // 1 小时（官方被动窗口）
    this.maxTracked = config?.maxTrackedMessages ?? 10_000
  }

  /** 被动尝试前预判：allowed=false 时应改走主动通道 */
  checkLimit(messageId: string): ReplyLimitResult {
    const now = Date.now()
    const tracked = this.messages.get(messageId)

    if (!tracked) {
      return { allowed: true, remaining: this.limit, shouldFallbackToProactive: false }
    }

    // 窗口过期：清记录并标记转主动（过期后挂 msg_id 平台会拒）
    if (now - tracked.firstSeenAt > this.ttlMs) {
      this.messages.delete(messageId)
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: "expired",
      }
    }

    const remaining = Math.max(0, this.limit - tracked.count)
    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: "limit_exceeded",
      }
    }

    return { allowed: true, remaining, shouldFallbackToProactive: false }
  }

  /** 被动回复发送成功后记账（失败不计，避免虚耗额度） */
  record(messageId: string): void {
    const now = Date.now()
    const tracked = this.messages.get(messageId)

    if (tracked) {
      tracked.count += 1
      return
    }

    // FIFO 驱逐（Map 迭代序=插入序）
    if (this.messages.size >= this.maxTracked) {
      const firstKey = this.messages.keys().next().value
      if (firstKey !== undefined) this.messages.delete(firstKey)
    }
    this.messages.set(messageId, { count: 1, firstSeenAt: now })
  }

  getStats(): { trackedMessages: number; totalReplies: number } {
    let totalReplies = 0
    for (const [, v] of this.messages) {
      totalReplies += v.count
    }
    return { trackedMessages: this.messages.size, totalReplies }
  }

  clear(): void {
    this.messages.clear()
  }
}
