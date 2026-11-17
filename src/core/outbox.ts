// @input:  fs/path/os/crypto + ../qq/types（MessageContext）
// @output: createOutbox 及 Outbox 公共类型、保留/退避常量、pruneOutboxEntries
// @pos:    core - 独立持久化出站 Outbox（先落账后发送，至少一次恢复）
//
// 文件格式：{ "version": 1, "entries": OutboxEntry[] }。所有 mutation 都在
// <outbox>.lock 短文件锁内重新读盘，再经临时文件 + rename 原子替换。
// 网络 handler 不持文件锁；sending + leaseOwner/leaseUntil 防跨进程并发双发。
import { storageFile } from "./storage.js"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import type { MessageContext } from "../qq/types.js"

export type OutboxState = "pending" | "sending" | "sent" | "failed"
export type { MessageContext }

export interface OutboxEntry<Payload = unknown, Receipt = unknown> {
  id: string
  kind: string
  ctx: MessageContext
  /** 调用方负责提供可 JSON 序列化的数据；入队时会做 JSON 快照。 */
  payload: Payload
  sessionId?: string
  turnId?: string
  state: OutboxState
  /** 已开始的网络发送次数（claim sending 时递增）。 */
  attempts: number
  createdAt: number
  updatedAt: number
  nextAttemptAt: number
  lastError?: string
  receipt?: Receipt
  /** sending 的执行体与租约；其他进程在租约有效时不得再次发送。 */
  leaseOwner?: string
  leaseUntil?: number
}

export interface OutboxEnqueueInput<Payload = unknown> {
  /** 缺省时随机生成；显式 id 在 pending/sending/failed 活跃期用于重入去重。 */
  id?: string
  kind: string
  ctx: MessageContext
  payload: Payload
  sessionId?: string
  turnId?: string
  /** 首次可发送时间，缺省立即。 */
  nextAttemptAt?: number
}

/** handler 必须使用 entry.payload/entry.ctx，返回值原样作为 JSON receipt 落盘。 */
export type OutboxHandler = (entry: OutboxEntry) => unknown | Promise<unknown>

export interface OutboxOptions {
  /** 默认 QQ_OUTBOX_FILE，再默认 ~/.openqq/outbox.json；创建实例时读取环境变量。 */
  filePath?: string
  /** start 的轮询间隔；0 表示禁用定时轮询，便于测试。默认 1000ms。 */
  pollIntervalMs?: number
  /** 首次失败退避，后续指数增长。默认 1000ms。 */
  retryBaseMs?: number
  /** 退避上限，默认 60000ms；0 表示不等待，便于立即重试测试。 */
  retryMaxMs?: number
  /** sending 租约，默认 30000ms。超时接管代表结果未知，允许至少一次重发。 */
  leaseMs?: number
  /** 短文件锁参数；通常无需修改。 */
  lockWaitMs?: number
  lockStaleMs?: number
}

export interface OutboxRecoverResult {
  /** 启动/恢复扫描中，从 sending 转回可重试 pending 的条目。 */
  recovered: OutboxEntry[]
  /** 恢复时已重试耗尽的条目（仅在设置 maxAttempts 时出现）。 */
  exhausted: OutboxEntry[]
}

export interface OutboxDispatchOptions {
  /** 忽略 nextAttemptAt，供人工重试；不影响 sent 的去重与活跃 lease。 */
  force?: boolean
  /** >0 时，失败达到该次数后保持 failed；recover 不会自动重投。 */
  maxAttempts?: number
}

export interface OutboxFlushOptions extends OutboxDispatchOptions {
  /** true 时持续等待退避到期，直到没有本实例可推进的活跃项。默认 false。 */
  wait?: boolean
}

export interface Outbox {
  readonly filePath: string
  register(kind: string, handler: OutboxHandler): () => void
  /** 先持久化 pending，再触发后台 dispatch；返回的是入队时的 pending 快照。 */
  enqueue<Payload = unknown>(input: OutboxEnqueueInput<Payload>): Promise<OutboxEntry<Payload>>
  /** 同进程同 id 复用 Promise；sent 直接返回，活跃 lease 返回 null。 */
  dispatch(id: string, options?: OutboxDispatchOptions): Promise<OutboxEntry | null>
  /** sending 结果未知：租约过期（或 ignoreLeases）转 pending/failed，不处理 sent。 */
  recover(options?: { ignoreLeases?: boolean; maxAttempts?: number }): Promise<OutboxRecoverResult>
  /** 扫描 pending/failed；默认只处理 nextAttemptAt 已到期的项。 */
  flush(options?: OutboxFlushOptions): Promise<OutboxEntry[]>
  /** start 的 maxAttempts 会透传 recover/flush：失败达到该次数后保持 failed，不再无限重试。 */
  start(options?: { recover?: boolean; maxAttempts?: number }): Promise<void>
  /** 停止定时器，不等待正在发送的 handler；需要等待时调用 drain。 */
  stop(): void
  /** 等待当前及等待期间新启动的本实例发送全部结束。 */
  drain(): Promise<void>
  list(): Promise<OutboxEntry[]>
  get(id: string): Promise<OutboxEntry | undefined>
}

interface OutboxDocument {
  version: 1
  entries: OutboxEntry[]
}

export const OUTBOX_SENT_RETENTION_MS = 24 * 60 * 60 * 1000
export const OUTBOX_SENT_RETENTION_LIMIT = 20
export const OUTBOX_DEFAULT_RETRY_BASE_MS = 1_000
export const OUTBOX_DEFAULT_RETRY_MAX_MS = 60_000

const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_LOCK_WAIT_MS = 5_000
const DEFAULT_LOCK_STALE_MS = 30_000
const sleepArray = new Int32Array(new SharedArrayBuffer(4))

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${name} 必须是 >= 0 的有限数`)
  return resolved
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = nonNegative(value, fallback, name)
  if (resolved === 0) throw new Error(`${name} 必须 > 0`)
  return resolved
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonSnapshot<T>(value: T, label: string): T {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error(`Outbox ${label} 必须是可 JSON 序列化的值`)
  return JSON.parse(encoded) as T
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function atomicWrite(filePath: string, document: OutboxDocument): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 })
    renameSync(temporary, filePath)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* 已 rename 或清理失败 */ }
    throw error
  }
}

function readDocument(filePath: string, now: number): OutboxDocument {
  if (!existsSync(filePath)) return { version: 1, entries: [] }
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown
  // 只接受本模块明确的文档形状；损坏文件不得被静默当空台账覆盖。
  if (Array.isArray(raw)) {
    return { version: 1, entries: pruneOutboxEntries(raw as OutboxEntry[], now) }
  }
  if (
    typeof raw !== "object" || raw === null ||
    (raw as { version?: unknown }).version !== 1 ||
    !Array.isArray((raw as { entries?: unknown }).entries)
  ) {
    throw new Error(`Outbox 文件格式无效: ${filePath}`)
  }
  const entries = (raw as { entries: OutboxEntry[] }).entries
  return { version: 1, entries: pruneOutboxEntries(entries, now) }
}

/**
 * sent 先按 24h 年龄过滤，再取 updatedAt 最新 20 条；非 sent 全量保留。
 * 输出按 createdAt 升序，createdAt 相同保持原相对顺序，避免活跃项被修剪或重排。
 */
export function pruneOutboxEntries(entries: OutboxEntry[], now = Date.now()): OutboxEntry[] {
  const indexed = entries.map((entry, index) => ({ entry, index }))
  const retainedSent = new Set(
    indexed
      .filter(({ entry }) => entry.state === "sent" && now - entry.updatedAt <= OUTBOX_SENT_RETENTION_MS)
      .sort((a, b) => b.entry.updatedAt - a.entry.updatedAt || b.index - a.index)
      .slice(0, OUTBOX_SENT_RETENTION_LIMIT)
      .map(({ index }) => index),
  )
  return indexed
    .filter(({ entry, index }) => entry.state !== "sent" || retainedSent.has(index))
    .sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.index - b.index)
    .map(({ entry }) => entry)
}

export function createOutbox(options: OutboxOptions = {}): Outbox {
  const filePath = options.filePath ?? process.env.QQ_OUTBOX_FILE ?? storageFile("outbox.json")
  const pollIntervalMs = nonNegative(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs")
  const retryBaseMs = nonNegative(options.retryBaseMs, OUTBOX_DEFAULT_RETRY_BASE_MS, "retryBaseMs")
  const retryMaxMs = nonNegative(options.retryMaxMs, OUTBOX_DEFAULT_RETRY_MAX_MS, "retryMaxMs")
  const leaseMs = positive(options.leaseMs, DEFAULT_LEASE_MS, "leaseMs")
  const lockWaitMs = positive(options.lockWaitMs, DEFAULT_LOCK_WAIT_MS, "lockWaitMs")
  const lockStaleMs = positive(options.lockStaleMs, DEFAULT_LOCK_STALE_MS, "lockStaleMs")
  const owner = `${process.pid}:${randomUUID()}`
  const handlers = new Map<string, OutboxHandler>()
  const inFlight = new Map<string, Promise<OutboxEntry | null>>()
  const automatic = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let flushing: Promise<OutboxEntry[]> | undefined

  function withLock<T>(fn: () => T): T {
    mkdirSync(dirname(filePath), { recursive: true })
    const lockPath = `${filePath}.lock`
    const token = `${owner}:${Date.now()}:${randomUUID()}`
    const deadline = Date.now() + lockWaitMs
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx", 0o600)
        try { writeFileSync(fd, token) } finally { closeSync(fd) }
        break
      } catch (error) {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > lockStaleMs) unlinkSync(lockPath)
        } catch { /* 锁已被释放或其他进程正在接管 */ }
        if (Date.now() >= deadline) throw new Error(`Outbox 锁等待超时: ${errorText(error)}`)
        Atomics.wait(sleepArray, 0, 0, 10)
      }
    }
    try {
      return fn()
    } finally {
      try {
        if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath)
      } catch { /* 锁已被 stale 清理 */ }
    }
  }

  function mutate<T>(fn: (entries: OutboxEntry[]) => T): T {
    return withLock(() => {
      const document = readDocument(filePath, Date.now())
      const result = fn(document.entries)
      document.entries = pruneOutboxEntries(document.entries)
      atomicWrite(filePath, document)
      return result
    })
  }

  function clone<Payload>(entry: OutboxEntry<Payload>): OutboxEntry<Payload> {
    return JSON.parse(JSON.stringify(entry)) as OutboxEntry<Payload>
  }

  function clearLease(entry: OutboxEntry): void {
    delete entry.leaseOwner
    delete entry.leaseUntil
  }

  function transitionRecovered(entry: OutboxEntry, now: number, maxAttempts?: number): boolean {
    if (entry.state !== "sending") return false
    const exhausted = maxAttempts !== undefined && entry.attempts >= maxAttempts
    entry.state = exhausted ? "failed" : "pending"
    entry.updatedAt = now
    entry.nextAttemptAt = now
    entry.lastError = exhausted
      ? `${entry.lastError ? `${entry.lastError}; ` : ""}崩溃恢复后已达到 maxAttempts=${maxAttempts}`
      : "进程在 sending 期间退出，发送结果未知；按至少一次语义恢复"
    clearLease(entry)
    return true
  }

  async function recover(recoverOptions: { ignoreLeases?: boolean; maxAttempts?: number } = {}): Promise<OutboxRecoverResult> {
    const now = Date.now()
    return mutate((entries) => {
      const recovered: OutboxEntry[] = []
      const exhausted: OutboxEntry[] = []
      for (const entry of entries) {
        if (entry.state !== "sending") continue
        // recover 用于进程重启；同进程调用时不得把仍在运行的 lease 抢走。
        if (inFlight.has(entry.id) && entry.leaseOwner?.startsWith(`${owner}:`)) continue
        const expired = entry.leaseUntil === undefined || entry.leaseUntil <= now
        if (!recoverOptions.ignoreLeases && !expired) continue
        transitionRecovered(entry, now, recoverOptions.maxAttempts)
        const snapshot = clone(entry)
        if (snapshot.state === "failed") exhausted.push(snapshot)
        else recovered.push(snapshot)
      }
      return { recovered, exhausted }
    })
  }

  async function dispatchInternal(id: string, dispatchOptions: OutboxDispatchOptions): Promise<OutboxEntry | null> {
    const handlerlessSnapshot = readDocument(filePath, Date.now()).entries.find((entry) => entry.id === id)
    if (!handlerlessSnapshot) return null
    const handler = handlers.get(handlerlessSnapshot.kind)
    if (!handler) return clone(handlerlessSnapshot)

    const now = Date.now()
    const token = `${owner}:${randomUUID()}`
    const claimed = withLock(() => {
      const document = readDocument(filePath, now)
      const entry = document.entries.find((candidate) => candidate.id === id)
      if (!entry) return { entry: null } as const
      if (entry.state === "sent") return { entry: clone(entry) } as const
      if (entry.state === "sending" && entry.leaseUntil !== undefined && entry.leaseUntil > now) {
        return { entry: null } as const
      }
      if (
        (entry.state === "pending" || entry.state === "failed" || entry.state === "sending") &&
        !dispatchOptions.force && entry.nextAttemptAt > now
      ) {
        return { entry: clone(entry) } as const
      }
      const maxAttempts = dispatchOptions.maxAttempts
      if (maxAttempts !== undefined && entry.attempts >= maxAttempts) {
        if (entry.state !== "failed") {
          entry.state = "failed"
          entry.updatedAt = now
          clearLease(entry)
          atomicWrite(filePath, document)
        }
        return { entry: clone(entry) } as const
      }
      entry.state = "sending"
      entry.attempts += 1
      entry.updatedAt = now
      entry.leaseOwner = token
      entry.leaseUntil = now + leaseMs
      delete entry.lastError
      // 状态必须先原子落盘，函数返回后才允许调用 handler。
      atomicWrite(filePath, document)
      return { entry: clone(entry), token } as const
    })

    if (!claimed.entry || !("token" in claimed)) return claimed.entry
    try {
      // handler 从持久化 claim 快照取数据，不能用 enqueue 的内存引用代替。
      const receipt = await handler(clone(claimed.entry))
      const persistedReceipt = receipt === undefined ? null : jsonSnapshot(receipt, "receipt")
      return mutate((entries) => {
        const current = entries.find((entry) => entry.id === id)
        // lease 被接管后，旧执行体不得把新执行体的状态覆盖为 sent。
        if (!current || current.leaseOwner !== token) return current ? clone(current) : null
        const completedAt = Date.now()
        current.state = "sent"
        current.updatedAt = completedAt
        current.receipt = persistedReceipt
        delete current.lastError
        clearLease(current)
        return clone(current)
      })
    } catch (error) {
      const failed = mutate((entries) => {
        const current = entries.find((entry) => entry.id === id)
        if (!current || current.leaseOwner !== token) return current ? clone(current) : null
        const failedAt = Date.now()
        current.state = "failed"
        current.updatedAt = failedAt
        current.lastError = errorText(error)
        current.nextAttemptAt = failedAt + Math.min(
          retryMaxMs,
          retryBaseMs * 2 ** Math.max(0, current.attempts - 1),
        )
        clearLease(current)
        return clone(current)
      })
      // 后台自动派发由轮询继续重试；显式 dispatch/flush 能看到发送异常。
      if (automatic.has(id)) return failed
      throw error
    }
  }

  function dispatch(id: string, dispatchOptions: OutboxDispatchOptions = {}): Promise<OutboxEntry | null> {
    const existing = inFlight.get(id)
    if (existing) return existing
    const promise = dispatchInternal(id, dispatchOptions).finally(() => {
      if (inFlight.get(id) === promise) inFlight.delete(id)
    })
    inFlight.set(id, promise)
    return promise
  }

  async function flush(flushOptions: OutboxFlushOptions = {}): Promise<OutboxEntry[]> {
    if (flushing) return flushing
    const run = (async () => {
      const results = new Map<string, OutboxEntry>()
      for (;;) {
        // 启动时未过期的崩溃 lease 之后也会在这里被接管；活跃 lease 仍由 recover 尊重。
        await recover({ maxAttempts: flushOptions.maxAttempts })
        const entries = readDocument(filePath, Date.now()).entries
        const candidates = entries.filter((entry) => {
          if (entry.state !== "pending" && entry.state !== "failed") return false
          if (!handlers.has(entry.kind)) return false
          if (flushOptions.maxAttempts !== undefined && entry.attempts >= flushOptions.maxAttempts) return false
          return flushOptions.force || flushOptions.wait || entry.nextAttemptAt <= Date.now()
        })
        const settled = await Promise.all(candidates.map(async (entry) => {
          const result = await dispatch(entry.id, flushOptions)
          if (result) results.set(entry.id, result)
          return result
        }))
        if (!flushOptions.wait) break
        const after = readDocument(filePath, Date.now()).entries
        const active = after.filter((entry) =>
          (entry.state === "pending" || entry.state === "failed") && handlers.has(entry.kind) &&
          (flushOptions.maxAttempts === undefined || entry.attempts < flushOptions.maxAttempts)
        )
        const waitingLocal = after.some((entry) => entry.state === "sending" && inFlight.has(entry.id))
        if (active.length === 0 && !waitingLocal) break
        if (settled.length === 0 && !waitingLocal) {
          const next = active.reduce((minimum, entry) => Math.min(minimum, entry.nextAttemptAt), Number.POSITIVE_INFINITY)
          if (Number.isFinite(next)) await delay(Math.max(1, next - Date.now()))
          else break
        } else {
          await delay(1)
        }
      }
      return [...results.values()]
    })()
    flushing = run
    try {
      return await run
    } finally {
      if (flushing === run) flushing = undefined
    }
  }

  async function drain(): Promise<void> {
    // 新 dispatch 可能在 await 间隙启动，因此循环到 inFlight 真正为空。
    while (inFlight.size > 0) {
      const pending = [...inFlight.values()]
      const outcomes = await Promise.allSettled(pending)
      const rejection = outcomes.find((outcome) => outcome.status === "rejected")
      if (rejection) throw (rejection as PromiseRejectedResult).reason
    }
  }

  return {
    filePath,
    register(kind, handler) {
      if (!kind) throw new Error("Outbox kind 不能为空")
      handlers.set(kind, handler)
      return () => {
        if (handlers.get(kind) === handler) handlers.delete(kind)
      }
    },
    async enqueue<Payload = unknown>(input: OutboxEnqueueInput<Payload>): Promise<OutboxEntry<Payload>> {
      if (!input.kind) throw new Error("Outbox kind 不能为空")
      if (input.payload === undefined) throw new Error("Outbox payload 必须是 JSON 值，不能为 undefined")
      if (input.nextAttemptAt !== undefined && !Number.isFinite(input.nextAttemptAt)) {
        throw new Error("Outbox nextAttemptAt 必须是有限时间戳")
      }
      const persistedCtx = jsonSnapshot(input.ctx, "ctx")
      const persistedPayload = jsonSnapshot(input.payload, "payload")
      const now = Date.now()
      const id = input.id ?? randomUUID()
      const entry = mutate((entries) => {
        const existing = entries.find((candidate) => candidate.id === id)
        // 同 id 重入（含 sent）复用原条目；显式无 id enqueue 永远生成新条目，不看 user/正文。
        if (existing) return clone(existing) as OutboxEntry<Payload>
        const created: OutboxEntry = {
          id,
          kind: input.kind,
          ctx: persistedCtx,
          payload: persistedPayload,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          state: "pending",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: input.nextAttemptAt ?? now,
        }
        entries.push(created)
        return clone(created) as OutboxEntry<Payload>
      })
      // mutate 已完成原子落盘；从这里之后才可能出现任何网络发送。
      automatic.add(id)
      void dispatch(id).finally(() => automatic.delete(id)).catch(() => { /* 自动路径在内部转为 failed */ })
      return entry
    },
    dispatch,
    recover,
    flush,
    async start(startOptions: { recover?: boolean; maxAttempts?: number } = {}) {
      stopped = false
      if (startOptions.recover !== false) await recover({ maxAttempts: startOptions.maxAttempts })
      if (pollIntervalMs === 0 || timer) return
      timer = setInterval(() => {
        if (stopped) return
        void flush({ maxAttempts: startOptions.maxAttempts }).catch(() => { /* 下轮继续；失败已持久化 */ })
      }, pollIntervalMs)
      timer.unref?.()
      void flush({ maxAttempts: startOptions.maxAttempts }).catch(() => { /* 下轮继续 */ })
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
    },
    drain,
    async list() {
      return readDocument(filePath, Date.now()).entries.map((entry) => clone(entry))
    },
    async get(id) {
      const entry = readDocument(filePath, Date.now()).entries.find((candidate) => candidate.id === id)
      return entry ? clone(entry) : undefined
    },
  }
}
