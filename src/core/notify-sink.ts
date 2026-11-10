// @input:  node:os/node:path（路径）、./outbox.ts、../config（Config 类型）
// @output: createNotifySink / resolveNotifyRecipients / defaultOutboxPath / 常量
// @pos:    core - openqq notify 外部入队通道的消费端：bot 进程注册 'notify'
//          outbox handler，把 outbox.json 里积压的通知用 delivery 投给 QQ 用户。
// @note:   入队端在 src/cli/notify.ts（只入队，不发送）；本文件只负责消费——
//          TTL 过期丢弃 / maxAttempts 重试上限 / 失败由 outbox 退避重试。
//          设计文档：Desktop `opencode-qqbot-feature-request.md` Part 1（0.3.14 现存缺口：
//          `opencode run` 新会话无 QQ 映射 → 镜像「无映射主人」跳过 → 结果推不到 QQ）。
//          交付层不换实现：deliver 内含配额记账/被动→主动降级/分条/24h 同文去重。
import { homedir } from "node:os"
import { join } from "node:path"
import type { Config } from "../config.js"
import type { MessageContext } from "../qq/types.js"
import { createOutbox } from "./outbox.js"

/** 默认 TTL：bot 长期不在线时积压不会在重启后集中刷屏。 */
export const DEFAULT_NOTIFY_TTL_HOURS = 24
/** 单条最大投递尝试次数：配额耗尽等永久失败不无限退避。 */
export const DEFAULT_NOTIFY_MAX_ATTEMPTS = 8

export type DeliverLike = (ctx: MessageContext, text: string) => Promise<boolean>

export interface NotifySinkOptions {
  config: Config
  deliver: DeliverLike
  /** 队列文件；缺省 QQ_OUTBOX_FILE → ~/.openqq/outbox.json（bot 与 CLI 必须一致）。 */
  filePath?: string
  ttlHours?: number
  maxAttempts?: number
}

export interface NotifySink {
  outbox: ReturnType<typeof createOutbox>
  /** 停止轮询；挂起的发送交由 outbox.drain 语义接管。 */
  stop: () => void
}

/**
 * 创建并启动 notify 消费端。handler 语义：
 * - payload.text 投给 entry.ctx（c2c 主动消息；delivery 内含配额/降级/分条/24h 去重）；
 * - TTL 过期 → 返回 skipped 说明（outbox 记为 sent，不发送）——积压不刷屏；
 * - 投递抛错 → outbox 记 failed 并退避重试，到 maxAttempts 保持 failed。
 * start() 已含 recover（崩溃 sending→pending/failed，至少一次语义）。
 */
export function createNotifySink(options: NotifySinkOptions): NotifySink {
  const ttlHours = Number(
    options.ttlHours ?? process.env.QQ_NOTIFY_TTL_HOURS ?? DEFAULT_NOTIFY_TTL_HOURS,
  )
  const ttlMs =
    (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_NOTIFY_TTL_HOURS) *
    60 * 60 * 1000
  const maxRaw = Number(
    options.maxAttempts ?? process.env.QQ_NOTIFY_MAX_ATTEMPTS ?? DEFAULT_NOTIFY_MAX_ATTEMPTS,
  )
  const maxAttempts = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : DEFAULT_NOTIFY_MAX_ATTEMPTS
  const outbox = createOutbox({ ...(options.filePath ? { filePath: options.filePath } : {}) })
  outbox.register("notify", (entry) => {
    if (Date.now() - entry.createdAt > ttlMs) {
      return { skipped: "ttl-expired" }
    }
    const text = (entry.payload as { text?: unknown } | null)?.text
    if (typeof text !== "string" || !text.trim()) {
      return { skipped: "no-text" }
    }
    const ctx = entry.ctx as MessageContext
    // fail-closed 校验在入队端（CLI）完成；消费端不再重复校验，outbox 快照不可篡改。
    // maxAttempts 由 start 透传到 recover/flush：失败达到上限后保持 failed，不再无限退避。
    return options.deliver(ctx, text).then(() => ({ delivered: true, text: text.slice(0, 120) }))
  })
  outbox.start({ recover: true, maxAttempts }).catch((error) => {
    console.error("[notify-sink] 启动恢复失败:", error instanceof Error ? error.message : error)
  })
  return {
    outbox,
    stop() {
      outbox.stop()
    },
  }
}

/** CLI 端收件人解析：ALLOWED_USERS 唯一项缺省生效；显式 user 必须命中名单（fail-closed）。 */
export function resolveNotifyRecipients(
  configured: readonly string[],
  explicit?: string,
): string {
  const users = [...configured]
  if (explicit) return users.includes(explicit) ? explicit : ""
  return users.length === 1 ? users[0] : ""
}

/** 默认 outbox 文件路径（CLI 与 bot 共用；env 已由 createOutbox 内处理，这里供 CLI dry-judge）。 */
export function defaultOutboxPath(): string {
  return join(homedir(), ".openqq", "outbox.json")
}
