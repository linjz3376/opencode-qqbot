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
// DEF-20261119-P8：SSE 静默死亡阈值。对端断连在部分路径下迭代器不抛错（注入实证），
// 以「N 秒零字节」判死。120s 是权衡值：远小于「断线无感」的失效时长，闲置期即便
// 引擎零 keepalive 导致的周期性重连也无副作用（监听器内存映射复用，无需重订阅）。
// 可用 QQ_SSE_SILENCE_MS 覆盖（测试注入小值验证重连链，生产调大容忍更闲的引擎）。
const SSE_SILENCE_MS = Number(process.env.QQ_SSE_SILENCE_MS ?? 120_000)
const MAX_BUF_BYTES = 200_000 // 防御性上限（事件洪峰时丢弃积压而非撑爆内存）

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class EventStream {
  private base: string
  private headers: Record<string, string>
  private listeners = new Map<string, Set<EventCallback>>()
  private allListeners = new Set<EventCallback>()
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

  // 全量订阅（2026-11-08）：不按 sessionID 过滤，供权限/表单等全局事件使用。
  // 权限请求必须在事件到达时即时推送——实测桌面端走同源 SSE，引擎会停在裁决前；
  // bot 若只靠 12s 轮询，取到时请求往往已被引擎自行放行。
  subscribeAll(callback: EventCallback): () => void {
    this.allListeners.add(callback)
    if (!this.running) void this.consume()
    return () => {
      this.allListeners.delete(callback)
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
    while (this.listeners.size > 0 || this.allListeners.size > 0) {
      try {
        const res = await fetch(`${this.base}/event`, { headers: this.headers })
        if (!res.ok || !res.body) {
          throw new Error(`SSE 连接失败: HTTP ${res.status}`)
        }
        this.backoffMs = RECONNECT_MIN_MS // 连接成功才重置退避
        console.log("[eventstream] 已连接 /api/event")
        const dec = new TextDecoder()
        let buf = ""
        // DEF-20261119-P8：静默看门狗——SSE 是长连接，对端 FIN/RST 在某些路径下
        // body 迭代器不抛出也不结束（06:11 注入实证：掐断后 43 分钟零感知零重连）。
        // 不依赖「迭代器会不会醒」，以「N 秒无任何字节到达」为死亡定义：到点主动
        // 掐掉本地流并抛错，走既有指数退避重连。心跳间隔大于 45s 的环境可调大。
        let lastChunkAt = Date.now()
        const silenceTimer = setInterval(() => {
          if (Date.now() - lastChunkAt > SSE_SILENCE_MS) {
            console.error(`[eventstream] ${SSE_SILENCE_MS}ms 无数据，判定连接已死，掐线重连`)
            res.body?.cancel().catch(() => {})
          }
        }, 10_000)
        silenceTimer.unref?.()
        try {
          for await (const chunk of res.body) {
            lastChunkAt = Date.now()
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
        } finally {
          clearInterval(silenceTimer)
        }
      } catch (error) {
        if (this.listeners.size === 0 && this.allListeners.size === 0) break
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
        for (const cb of this.allListeners) {
          try {
            cb(ev)
          } catch (error) {
            console.error("[eventstream] 全局订阅回调异常:", error)
          }
        }
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
