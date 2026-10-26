// @input:  (none - fetch + env)
// @output: V2Event, EventStream, createEventStream
// @pos:    opencode层 - V2 SSE 事件流客户端（单连接、按 sessionID 分流、自动重连）
//
// V2 事件帧实测（2026-10-13）：GET /api/event 返回 text/event-stream，
// 帧以 \n\n 分隔，每帧形如 `data: {json}`（无 event: 行），JSON 结构：
//   { id, type(事件名), created, location?, data: { sessionID, ... }, durable: { aggregateID, seq } }
// 分流依据 = data.sessionID（每帧必有）。断线自动重连（指数退避，无订阅者时退出）。

export interface V2Event {
  id?: string
  type: string
  created?: number
  data?: Record<string, unknown> & { sessionID?: string }
}

type EventCallback = (event: V2Event) => void

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000
const MAX_BUF_BYTES = 200_000 // 防御性上限（事件洪峰时丢弃积压而非撑爆内存）

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class EventStream {
  private base: string
  private headers: Record<string, string>
  private listeners = new Map<string, Set<EventCallback>>()
  private running = false
  private backoffMs = RECONNECT_MIN_MS

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, "")
    this.headers = { Accept: "text/event-stream" }
    const password = process.env.OPENCODE_PASSWORD
    if (password) {
      this.headers.Authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    }
  }

  // 订阅指定会话的事件；返回取消订阅函数。首个订阅者触发连接。
  subscribe(sessionID: string, callback: EventCallback): () => void {
    let set = this.listeners.get(sessionID)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionID, set)
    }
    set.add(callback)
    if (!this.running) void this.consume()
    return () => {
      const s = this.listeners.get(sessionID)
      if (!s) return
      s.delete(callback)
      if (s.size === 0) {
        this.listeners.delete(sessionID)
      }
    }
  }

  get activeSessions(): number {
    return this.listeners.size
  }

  // HC2（2026-10-26）：运行中热换基（端口漂移自愈）。不影响当前连接；
  // 断线重连的下一轮 fetch 即走新址。复盘3-F 的单引号日志 bug 顺手修复。
  rebase(nextUrl: string): void {
    const next = nextUrl.replace(/\/+$/, "")
    if (next !== this.base) {
      console.log(`[eventstream] 热换基：${this.base} → ${next}`)
      this.base = next
    }
  }

  private async consume(): Promise<void> {
    this.running = true
    while (this.listeners.size > 0) {
      try {
        const res = await fetch(`${this.base}/event`, { headers: this.headers })
        if (!res.ok || !res.body) {
          throw new Error(`SSE 连接失败: HTTP ${res.status}`)
        }
        this.backoffMs = RECONNECT_MIN_MS // 连接成功才重置退避
        console.log("[eventstream] 已连接 /api/event")
        const dec = new TextDecoder()
        let buf = ""
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true })
          const frames = buf.split("\n\n")
          buf = frames.pop() ?? "" // 最后一段可能不完整，留待下一块
          for (const frame of frames) this.handleFrame(frame)
          if (buf.length > MAX_BUF_BYTES) {
            console.error("[eventstream] 缓冲超限，丢弃积压数据")
            buf = ""
          }
        }
        throw new Error("SSE 流意外结束")
      } catch (error) {
        if (this.listeners.size === 0) break
        console.error(
          `[eventstream] 连接中断，${this.backoffMs}ms 后重连:`,
          error instanceof Error ? error.message : String(error),
        )
        await sleep(this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS)
      }
    }
    this.running = false
    console.log("[eventstream] 无订阅者，连接关闭")
  }

  private handleFrame(frame: string): void {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue
      try {
        const ev = JSON.parse(line.slice(5).trim()) as V2Event
        const sid = ev.data?.sessionID
        if (!sid) continue
        const set = this.listeners.get(sid)
        if (!set) continue
        for (const cb of set) {
          try {
            cb(ev)
          } catch (error) {
            console.error("[eventstream] 订阅回调异常:", error)
          }
        }
      } catch {
        // 坏帧忽略（保持流存活）
      }
    }
  }
}

export function createEventStream(baseUrl: string): EventStream {
  return new EventStream(baseUrl)
}
