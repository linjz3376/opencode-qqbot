// @input:  ws, ./api (getAccessToken, getGatewayUrl, acknowledgeInteraction), ./types (MessageContext, InteractionEvent)
// @output: startGateway, MessageHandler
// @pos:    qq层 - QQ Bot WebSocket Gateway 状态机 (心跳/重连/消息分发)
import WebSocket from "ws"
import { acknowledgeInteraction, clearTokenCache, getAccessToken, getGatewayUrl } from "./api.js"
import { clearGatewayState, loadGatewayState, saveGatewayState } from "../core/gateway-state.js"
import type {
  C2CMessageEvent,
  GatewayHelloData,
  GatewayReadyData,
  GroupMessageEvent,
  InteractionEvent,
  MessageAttachment,
  MessageContext,
  WSPayload,
} from "./types.js"

const GROUP_AND_C2C_EVENT_INTENT = 1 << 25
// A 项（2026-10-29）：按钮互动回调 intent，P0 实证（qqbot-nodejs constants.ts INTERACTION = 1<<26）
const INTERACTION_INTENT = 1 << 26
const MAX_RECONNECT_DELAY_MS = 30_000
const BASE_RECONNECT_DELAY_MS = 1_000
const INVALID_SESSION_DELAY_MS = 3_000
// B2（2026-10-29，对齐官方 qqbot-nodejs protocol/gateway/constants.ts）：
// 4008 = 被平台限流，官方语义须长退避 60s（RATE_LIMIT_DELAY），否则重连风暴加重限流
const RATE_LIMITED_CLOSE_CODE = 4008
const RATE_LIMITED_RECONNECT_DELAY_MS = 60_000
const RESUME_RESET_CLOSE_CODES = new Set([4006, 4007, 4009])
const FATAL_CLOSE_CODES = new Set([4914, 4915])

export type MessageHandler = (msg: MessageContext) => Promise<void>

export interface GatewayOptions {
  appId: string
  clientSecret: string
  onMessage: MessageHandler
  onReady?: () => void
  /** A 项（2026-10-29）：按钮互动回调（INTERACTION_CREATE）——卡片审批的入口 */
  onInteraction?: (event: InteractionEvent) => void | Promise<void>
}

interface GatewayState {
  ws: WebSocket | null
  stopped: boolean
  connecting: boolean
  reconnectAttempt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  accessToken: string | null
  sessionId: string | null
  seq: number | null
  heartbeatAcked: boolean
  /** 仅拦截活跃并发/重入；处理完成后释放，同 msgId 可显式重投 */
  activeMsgIds: Set<string>
}

interface GatewayControl {
  stop: () => void
}

function createInitialState(): GatewayState {
  const state: GatewayState = {
    ws: null,
    stopped: false,
    connecting: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    accessToken: null,
    sessionId: null,
    seq: null,
    heartbeatAcked: true,
    activeMsgIds: new Set(),
  }
  // 修复②：从磁盘恢复 session/seq——重启优先 RESUME（服务端只补断线窗口的
  // 事件），不再 IDENTIFY 从零重放 backlog。超龄/缺损/RESUME 被拒（op9）时
  // 自动回退 IDENTIFY，无死循环。加载失败静默走老路径，不阻塞启动。
  const saved = loadGatewayState()
  if (saved) {
    state.sessionId = saved.session_id
    state.seq = saved.seq
    const agoSec = Math.max(0, Math.round((Date.now() - saved.savedAt) / 1000))
    console.log(`[gateway] 已从磁盘恢复网关状态（${agoSec}s 前），将尝试 RESUME session=${saved.session_id} seq=${saved.seq}`)
  }
  return state
}

// msgId 防重改为「活跃期保护」：占位→处理→finally 释放，
// 同 msgId 并发/重入丢弃（resume 重回补防御）；处理完成后可显式重投。
// 持久兜底（跨重启、排队中）由 bridge 的 inflight 台账负责。
function tryClaimActive(active: Set<string>, msgId: string): boolean {
  if (active.has(msgId)) return false
  // 防御性上限：正常路径靠 finally 释放不会积累；到达上限说明出现泄漏式积压，
  // 此时放弃新增保护（宁可接受极小概率重投，也不无限吞掉新消息）
  if (active.size >= 1000) return true
  active.add(msgId)
  return true
}

function releaseActive(active: Set<string>, msgId: string): void {
  active.delete(msgId)
}

function cleanupSocket(state: GatewayState): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer)
    state.heartbeatTimer = null
  }

  const ws = state.ws
  state.ws = null

  if (!ws) {
    return
  }

  ws.removeAllListeners()

  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close()
  }
}

function scheduleReconnect(state: GatewayState, connect: () => Promise<void>, customDelayMs?: number): void {
  if (state.stopped || state.reconnectTimer) {
    return
  }

  const attempt = state.reconnectAttempt
  const delayMs = customDelayMs ?? Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS)
  state.reconnectAttempt += 1

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    void connect()
  }, delayMs)
}

function startHeartbeat(state: GatewayState, intervalMs: number): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer)
  }

  state.heartbeatAcked = true
  state.heartbeatTimer = setInterval(() => {
    const ws = state.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return
    }

    // 如果上一个心跳一直没收到 ACK，直接断线重连
    if (!state.heartbeatAcked) {
      ws.terminate()
      return
    }

    state.heartbeatAcked = false
    ws.send(JSON.stringify({ op: 1, d: state.seq }))
  }, intervalMs)
}

function resetResumeState(state: GatewayState): void {
  state.sessionId = null
  state.seq = null
  // 修复②：服务端明确作废会话（op9 不可恢复/Resume 失效码）→ 持久化状态同步清账，
  // 下次启动不得再拿已作废的 session 去 RESUME。
  clearGatewayState()
}

// QQ 表情实体剥离（2026-11-06 UAT 实证 DEF-P1）：`<faceType=1,faceId="0",ext="…">`
// 形式的内嵌表情若不去除，会让「[表情]/model …」整体落入聊天分支（命令失效），
// 且原始实体标签进入 prompt/台账。剥离后纯表情消息为空文本，按空白消息规则吞掉。
// 2026-11-10 夜间 UAT 实证补充：PC 端真实表情以 emoji 字符形态（非 faceType 实体）
// 到达（135 实测「😀/status」原样进聊天分支）——命令门判定前需剥扩展象形字符，
// 否则 P1 修复对真实链路无效。仅作用于「含斜杠命令」的消息，普通聊天表情不受影响。
const EMOJI_GLYPH_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu

function stripFaceEntities(content: string): string {
  return content.replace(/<faceType=\d+,[^>]*>/g, "")
}

/** 命令门判定时使用的规范化文本：实体+emoji 字符都剥，剥后若形似命令则以命令受理 */
export function normalizeForCommandGate(content: string): string {
  const base = stripFaceEntities(content.replace(/\r\n/g, "\n"))
  return base.includes("/") ? base.replace(EMOJI_GLYPH_RE, "").trim() : base.trim()
}

export function normalizeMessageContent(content: string): string {
  const stripped = stripFaceEntities(content.replace(/\r\n/g, "\n")).trim()
  // 纯 emoji（无文字无斜杠）视为空白消息吞掉——DEF-P1 意图的字符形态补全
  if (stripped && !stripped.includes("/") && stripped.replace(EMOJI_GLYPH_RE, "").trim() === "") return ""
  return stripped
}

/**
 * 纯表情原始判定（DEF-qqbot-20261111-P2，owner 2026-11-12 裁定=应回有据提示）：
 * 原始内容非空但规范化后为空 = 纯表情被剥。用于在丢弃点回提示，避免「发了像没发」。
 */
export function isEmojiOnlyContent(content: string): boolean {
  const raw = content.replace(/\r\n/g, "\n").trim()
  return raw.length > 0 && normalizeMessageContent(content) === ""
}

function stripGroupAtPrefix(content: string): string {
  const normalized = normalizeMessageContent(content)
  return normalized.replace(/^<@!?.+?>\s*/u, "").trim()
}

/** 载荷日志打码（R2-P2-1）：签名 URL 是短时效凭据不入日志，只留校准
 *  所需的 host/类型/大小/文件名 */
function briefAttachments(atts: MessageAttachment[]): unknown[] {
  return atts.map((a) => {
    let host = "?"
    try {
      host = new URL(a.url).hostname
    } catch {
      /* 保留 ? */
    }
    return { host, content_type: a.content_type, size: a.size, filename: a.filename, asr: a.asr_refer_text ? 1 : 0 }
  })
}

function toC2CMessageContext(event: C2CMessageEvent): MessageContext {
  return {
    type: "c2c",
    userId: event.author.user_openid,
    msgId: event.id,
    content: normalizeMessageContent(event.content),
    // DEF-qqbot-20261111-P2：纯表情标记随 ctx 传递，bridge 丢弃点据此刻回有据提示（不再静默吞）
    ...(isEmojiOnlyContent(event.content) ? { emojiOnly: true } : {}),
    referencedMsgId: event.message_reference?.message_id,
    attachments: event.attachments,
    timestamp: event.timestamp,
    rawEvent: event,
  }
}

function toGroupMessageContext(event: GroupMessageEvent): MessageContext {
  return {
    type: "group",
    userId: event.author.member_openid,
    groupId: event.group_openid,
    msgId: event.id,
    content: stripGroupAtPrefix(event.content),
    // DEF-qqbot-20261111-P2：群聊同口径（纯表情有据提示不静默）
    ...(isEmojiOnlyContent(event.content) ? { emojiOnly: true } : {}),
    referencedMsgId: event.message_reference?.message_id,
    attachments: event.attachments,
    timestamp: event.timestamp,
    rawEvent: event,
  }
}

async function refreshGatewayAuth(options: GatewayOptions, state: GatewayState): Promise<{ accessToken: string; gatewayUrl: string }> {
  const accessToken = await getAccessToken(options.appId, options.clientSecret)
  const gatewayUrl = await getGatewayUrl(accessToken)
  state.accessToken = accessToken
  return { accessToken, gatewayUrl }
}

function sendIdentify(ws: WebSocket, accessToken: string): void {
  const payload: WSPayload<{
    token: string
    intents: number
    shard: [number, number]
    properties: Record<string, string>
  }> = {
    op: 2,
    d: {
      token: `QQBot ${accessToken}`,
      intents: GROUP_AND_C2C_EVENT_INTENT | INTERACTION_INTENT,
      shard: [0, 1],
      properties: {
        os: process.platform,
        browser: "opencode_qq_bot",
        device: "opencode_qq_bot",
      },
    },
  }

  ws.send(JSON.stringify(payload))
}

function sendResume(ws: WebSocket, accessToken: string, sessionId: string, seq: number): void {
  const payload: WSPayload<{
    token: string
    session_id: string
    seq: number
  }> = {
    op: 6,
    d: {
      token: `QQBot ${accessToken}`,
      session_id: sessionId,
      seq,
    },
  }

  ws.send(JSON.stringify(payload))
}

async function handleDispatchEvent(
  payload: WSPayload,
  options: GatewayOptions,
  state: GatewayState,
): Promise<void> {
  switch (payload.t) {
    case "READY": {
      const readyData = payload.d as GatewayReadyData
      state.sessionId = readyData.session_id
      // 修复②：新会话确立即落盘（含 RESUME 失败回退 IDENTIFY 后的新会话）
      if (state.seq !== null) saveGatewayState(state.sessionId, state.seq)
      // R 项诊断增强（2026-10-30）：首连/重连分界可见——重连后的 READY 打日志，
      // 下次"消息静默丢失"类事故可直接从日志定位断链窗口
      if (state.reconnectAttempt > 0) {
        console.log(`[gateway] 重连已就绪（READY，第 ${state.reconnectAttempt} 次尝试）session=${state.sessionId}`)
      }
      state.reconnectAttempt = 0
      options.onReady?.()
      return
    }

    case "RESUMED": {
      console.log("[gateway] 会话已恢复（RESUMED，断线期间事件已回补）")
      // 修复②：心跳延续，落盘一次刷新 savedAt（防窗口使用过期源）
      if (state.sessionId && state.seq !== null) saveGatewayState(state.sessionId, state.seq)
      state.reconnectAttempt = 0
      return
    }

    case "C2C_MESSAGE_CREATE": {
      const event = payload.d as C2CMessageEvent
      // 活跃期防重：同 id 并发/重入丢弃；处理完成后 finally 释放，可显式重投
      if (!tryClaimActive(state.activeMsgIds, event.id)) return
      const message = toC2CMessageContext(event)
      if (message.attachments?.length) {
        // R2-P2-1：打码载荷（签名 URL 不入日志），host/类型/大小够 B7 校准
        console.log("[gateway] 附件载荷:", JSON.stringify(briefAttachments(message.attachments)))
      }
      if (!message.content && !message.attachments?.length) {
        releaseActive(state.activeMsgIds, event.id)
        return
      }
      try {
        await options.onMessage(message)
      } finally {
        releaseActive(state.activeMsgIds, event.id)
      }
      return
    }

    case "GROUP_AT_MESSAGE_CREATE": {
      const event = payload.d as GroupMessageEvent
      if (!tryClaimActive(state.activeMsgIds, event.id)) return
      const message = toGroupMessageContext(event)
      if (message.attachments?.length) {
        // R2-P2-1：打码载荷（签名 URL 不入日志）
        console.log("[gateway] 附件载荷:", JSON.stringify(briefAttachments(message.attachments)))
      }
      if (!message.content && !message.attachments?.length) {
        releaseActive(state.activeMsgIds, event.id)
        return
      }
      try {
        await options.onMessage(message)
      } finally {
        releaseActive(state.activeMsgIds, event.id)
      }
      return
    }

    case "INTERACTION_CREATE": {
      // A 项（2026-10-29）：按钮互动回调。平台要求 3 秒内响应且同 id 只能
      // 响应一次。分发先于 ACK：业务的同步前缀（表单点击持久化落盘等）
      // 必须在 ACK 之前完成，否则「ACK 后进程崩溃」可能丢掉这次点击。
      // 不等待其异步结果；同步抛出的异常进入被捕获的 Promise 链：
      // ① 同步分发仍已执行，② ACK 照常发出。
      const interaction = payload.d as InteractionEvent
      void Promise.resolve()
        .then(() => options.onInteraction?.(interaction))
        .catch((error) => {
          console.error("[qq-gateway] 互动业务分发失败:", error instanceof Error ? error.message : error)
        })
      if (interaction?.id) {
        // 2026-11-08 根因修复：ACK 必须现取 token，禁止使用连接期快照 state.accessToken。
        // 快照只在 connect() 时刷新，WS 长连跨过 7200s 后即失效 → 401 →「请求第三方失败」。
        void acknowledgeInteraction(options.appId, options.clientSecret, interaction.id).catch((error) => {
          console.error("[qq-gateway] 互动响应失败:", error instanceof Error ? error.message : error)
        })
      }
      return
    }

    default:
      return
  }
}

async function handlePayload(
  payload: WSPayload,
  ws: WebSocket,
  options: GatewayOptions,
  state: GatewayState,
  connect: () => Promise<void>,
): Promise<void> {
  if (typeof payload.s === "number") {
    const prevSeq = state.seq
    state.seq = payload.s
    // 修复②：session 已确立时把 seq 推进原子落盘（重启恢复窗口的基石）。
    // 跳号>1 经验上=断线窗口被服务端回补（重放可见性，2026-11-03 定案要求观测日志）。
    if (state.sessionId && payload.s !== prevSeq) {
      if (prevSeq !== null && payload.s > prevSeq + 1) {
        console.log(`[gateway] seq 回补 ${payload.s - prevSeq - 1} 帧（${prevSeq} → ${payload.s}）——断线期间载荷已重放`)
      }
      saveGatewayState(state.sessionId, payload.s)
    }
  }

  switch (payload.op) {
    case 10: {
      // Hello：建立心跳，并根据有无 session 决定 Identify/Resume
      const hello = payload.d as GatewayHelloData
      startHeartbeat(state, hello.heartbeat_interval)

      if (state.accessToken && state.sessionId && state.seq !== null) {
        sendResume(ws, state.accessToken, state.sessionId, state.seq)
      } else if (state.accessToken) {
        sendIdentify(ws, state.accessToken)
      }
      return
    }

    case 0:
      await handleDispatchEvent(payload, options, state)
      return

    case 1:
      // 服务端要求立即心跳
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: 1, d: state.seq }))
      }
      return

    case 7:
      // 服务端要求重连，尽量保留 session 走 Resume
      cleanupSocket(state)
      scheduleReconnect(state, connect)
      return

    case 9: {
      // InvalidSession：不可恢复时清空会话，稍后重新 Identify
      const canResume = Boolean(payload.d)
      if (!canResume) {
        resetResumeState(state)
      }
      cleanupSocket(state)
      scheduleReconnect(state, connect, INVALID_SESSION_DELAY_MS)
      return
    }

    case 11:
      state.heartbeatAcked = true
      return

    default:
      return
  }
}

export async function startGateway(options: GatewayOptions): Promise<GatewayControl> {
  const state = createInitialState()

  const stop = (): void => {
    state.stopped = true

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }

    cleanupSocket(state)
  }

  const connect = async (): Promise<void> => {
    if (state.stopped || state.connecting) {
      return
    }

    state.connecting = true

    try {
      cleanupSocket(state)

      const { gatewayUrl } = await refreshGatewayAuth(options, state)
      // 握手超时：若建连握手一直挂着（休眠/断网/NAT 超时），ws 会触发 error，
      // 从而把 connecting 重置并走重连；否则 connecting 会永久卡 true 导致再也不重连。
      const ws = new WebSocket(gatewayUrl, { handshakeTimeout: 15_000 })
      state.ws = ws

      // 兜底：无论如何 20s 后必须解除 connecting 卡死状态
      const connectGuard = setTimeout(() => {
        if (state.ws === ws && ws.readyState === WebSocket.CONNECTING) {
          console.error("[qq-gateway] 建连超时（20s 未就绪），强制终止")
          ws.terminate()
        }
        if (state.connecting) {
          state.connecting = false
        }
      }, 20_000)

      ws.on("open", () => {
        clearTimeout(connectGuard)
        state.connecting = false
      })

      ws.on("message", (data) => {
        void (async () => {
          try {
            const payload = JSON.parse(data.toString()) as WSPayload
            await handlePayload(payload, ws, options, state, connect)
          } catch (error) {
            console.error("[qq-gateway] 处理网关消息失败:", error)
          }
        })()
      })

      ws.on("close", (code) => {
        clearTimeout(connectGuard)
        state.connecting = false
        cleanupSocket(state)

        if (state.stopped || code === 1000) {
          return
        }

        // 这些错误码说明 Resume 已经没意义，直接清空会话重来
        if (RESUME_RESET_CLOSE_CODES.has(code)) {
          resetResumeState(state)
        }

        // token 失效时强制刷新，避免死循环拿旧 token
        if (code === 4004) {
          clearTokenCache()
          state.accessToken = null
        }

        // B2：4008 平台限流 → 官方语义 60s 长退避（对齐 qqbot-nodejs RATE_LIMIT_DELAY），
        // 与指数退避（1s 起步 30s 封顶，等价收敛于官方阶梯 [1,2,5,10,30,60]）互补
        if (code === RATE_LIMITED_CLOSE_CODE) {
          scheduleReconnect(state, connect, RATE_LIMITED_RECONNECT_DELAY_MS)
          return
        }

        if (FATAL_CLOSE_CODES.has(code)) {
          return
        }

        scheduleReconnect(state, connect)
      })

      ws.on("error", (error) => {
        clearTimeout(connectGuard)
        state.connecting = false
        console.error("[qq-gateway] WebSocket 错误:", error)
      })
    } catch (error) {
      state.connecting = false
      console.error("[qq-gateway] 建连失败:", error)
      clearTokenCache()
      state.accessToken = null
      scheduleReconnect(state, connect)
    }
  }

  await connect()

  return { stop }
}
