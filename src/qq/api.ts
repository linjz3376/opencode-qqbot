// @input:  (none - raw HTTP to QQ Bot REST API)
// @output: getAccessToken, apiRequest, sendC2CMessage, sendGroupMessage, getGatewayUrl, startBackgroundTokenRefresh,
//          acknowledgeInteraction, isTokenFresh, isAuthFailure, clearTokenCache, getTokenStatus
// @pos:    qq层 - QQ Bot REST API 鉴权+请求封装 (Token singleflight + 后台刷新)
import type { MessageContext } from "./types.js"

const API_BASE = "https://api.sgroup.qq.com"
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
// 沙箱模式（QQ_SANDBOX=true）：API 底座切沙箱域（QQ 官方文档约定
// sandbox.api.sgroup.qq.com）；token 端点两环境共用 bots.qq.com。
// 注意：沙箱 bot 在非沙箱场景会被网关以 4914（offline/sandbox-only）拒绝。
// ★ P0 修复（2026-11-03，外部复盘核验实证）：原 `const API_BASE_EFFECTIVE = …`
//    在模块加载期求值，而 .env 由 ensureConfig() 在运行时才注入 process.env——
//    发布包（shell 未预置 QQ_SANDBOX）永远赶不上取值，沙箱开关形同虚设。
//    改为惰性函数：每次构造请求 URL 时现场读取 env，不再依赖加载顺序。
const API_BASE_SANDBOX = "https://sandbox.api.sgroup.qq.com"

// ── 多角色（2026-11-17）：API 底座/Token 缓存按 appId 分桶 ──
// 单进程挂多个 QQ bot 身份时，各角色的 API 底座（沙箱/生产）与 token 互相独立。
// legacy 单角色：registry 无条目 → 全部回退读全局 env（行为与旧版一致）。
const appSandboxRegistry = new Map<string, boolean>()

/** 角色启动时登记沙箱开关；同 appId 重复登记覆盖（重启换代）。 */
export function registerAppEnv(appId: string, sandbox: boolean): void {
  appSandboxRegistry.set(appId, sandbox)
}

export function apiBase(appId?: string): string {
  const reg = appId ? appSandboxRegistry.get(appId) : undefined
  const sandbox = reg ?? process.env.QQ_SANDBOX === "true"
  return sandbox ? API_BASE_SANDBOX : API_BASE
}

// Token 缓存按 appId 分槽（多角色：两角色交替发消息不再互相清缓存）。
// token→appId 反查表：发消息类函数只持有 token，由它解析底座，免去全调用链穿参。
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const tokenFetchByApp = new Map<string, Promise<string>>()
const appIdByToken = new Map<string, string>()
const MAX_TOKEN_REVERSE_INDEX = 64

function indexToken(appId: string, token: string): void {
  appIdByToken.set(token, appId)
  if (appIdByToken.size > MAX_TOKEN_REVERSE_INDEX) {
    const oldest = appIdByToken.keys().next().value
    if (oldest) appIdByToken.delete(oldest)
  }
}

// ★ P0 对齐（2026-11-08，官方鉴权文档）：
//   「access_token 生命周期默认 7200 秒，**每次请求不会刷新新的 access_token**…
//    在上一个 access_token 接近过期时间 **60 秒内**获取时，会获得新的 access_token，
//    老的 access_token 在这 60 秒内仍然有效。」
//   ⇒ 提前量固定 5 分钟是错的：T-5min 内反复请求拿到的仍是同一个 token，
//     却让「缓存判定为已过期」永久为真 → 每次 API 调用都去取一次票
//     （11-08 10:19~10:23 实测 4 分钟内取了 7 次）。改为对齐官方 60s 换发窗口。
const TOKEN_REFRESH_AHEAD_MS = 60_000
/** 取票超时（对齐官方 SDK 10s）——ACK 现取 token 依赖它兜底，防止把互动响应拖过 3 秒窗口。 */
const TOKEN_FETCH_TIMEOUT_MS = 10_000

/** 纯函数：缓存 token 是否仍可直接使用（now < expiresAt - 提前量）。 */
export function isTokenFresh(expiresAt: number, now: number, aheadMs = TOKEN_REFRESH_AHEAD_MS): boolean {
  return now < expiresAt - aheadMs
}

/**
 * 纯函数：判定「鉴权失败」——ACK 遇到这类错误说明 token 在取用之间失效，
 * 清缓存重取后重试是安全的（失败的 ACK 未被平台受理，不违反「同 id 只响应一次」）。
 */
export function isAuthFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /AccessToken无效或过期|AccessToken invalid|401 Unauthorized/i.test(msg)
}

// 债务D3：日志脱敏——Authorization/cookie/token 头含凭证，打印前掩码
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /authorization|cookie|token|secret/i.test(k) ? "***" : v
  }
  return out
}

/**
 * 获取 AccessToken，内置缓存与 singleflight 并发保护。
 * 当多个请求同时发现 Token 过期时，只会发起一次真实刷新请求。
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(appId)
  if (cached && isTokenFresh(cached.expiresAt, Date.now())) {
    return cached.token
  }

  const inflight = tokenFetchByApp.get(appId)
  if (inflight) {
    console.log(`[qqbot-api] Token fetch in progress (appId=${appId}), waiting for existing request...`)
    return inflight
  }

  const fetchPromise = (async () => {
    try {
      return await doFetchToken(appId, clientSecret)
    } finally {
      tokenFetchByApp.delete(appId)
    }
  })()
  tokenFetchByApp.set(appId, fetchPromise)

  return fetchPromise
}

/**
 * 真正执行 Token 获取的内部函数。
 */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  const requestBody = { appId, clientSecret }
  const requestHeaders = { "Content-Type": "application/json" }

  console.log(`[qqbot-api] >>> POST ${TOKEN_URL}`)
  console.log("[qqbot-api] >>> Headers:", JSON.stringify(maskHeaders(requestHeaders), null, 2))
  console.log("[qqbot-api] >>> Body:", JSON.stringify({ appId, clientSecret: "***" }, null, 2))

  // 取票必须有超时（P0 官方 SDK DEFAULT_TOKEN_TIMEOUT_MS=10s）：ACK 现取 token 后，
  // 取票若无限挂起会把互动响应拖过平台 3 秒窗口 → 客户端「请求第三方失败」。
  const controller = new AbortController()
  const timeoutMs = TOKEN_FETCH_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError"
    console.error("[qqbot-api] <<< Network error:", err)
    throw new Error(
      aborted
        ? `Token fetch timeout after ${timeoutMs}ms`
        : `Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  console.log(`[qqbot-api] <<< Status: ${response.status} ${response.statusText}`)
  console.log("[qqbot-api] <<< Headers:", JSON.stringify(maskHeaders(responseHeaders), null, 2))

  let data: { access_token?: string; expires_in?: number }
  let rawBody: string
  try {
    rawBody = await response.text()
    const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"')
    console.log("[qqbot-api] <<< Body:", logBody)
    data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number }
  } catch (err) {
    console.error("[qqbot-api] <<< Parse error:", err)
    throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`)
  }

  tokenCache.set(appId, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  })
  indexToken(appId, data.access_token)

  const cached = tokenCache.get(appId)!
  console.log(`[qqbot-api] Token cached for appId=${appId}, expires at: ${new Date(cached.expiresAt).toISOString()}`)
  return cached.token
}

/**
 * 清空 Token 缓存。传 appId 只清该角色（互动 ACK 鉴权重试场景）；
 * 不传清空全部（关停/测试场景）。
 */
export function clearTokenCache(appId?: string): void {
  if (appId) {
    const cached = tokenCache.get(appId)
    if (cached) appIdByToken.delete(cached.token)
    tokenCache.delete(appId)
    return
  }
  tokenCache.clear()
  appIdByToken.clear()
}

/**
 * 由 token 反查 appId（多角色下发消息按各自底座路由；查不到回退 legacy env）。
 */
export function resolveAppIdByToken(token: string): string | undefined {
  return appIdByToken.get(token)
}

/**
 * 获取当前 Token 缓存状态（监控/启动打印；多角色时合并各槽位最紧迫状态）。
 */
export function getTokenStatus(): { status: "valid" | "expired" | "refreshing" | "none"; expiresAt: number | null } {
  if (tokenFetchByApp.size > 0) {
    let nearest: number | null = null
    for (const c of tokenCache.values()) nearest = nearest === null ? c.expiresAt : Math.min(nearest, c.expiresAt)
    return { status: "refreshing", expiresAt: nearest }
  }
  if (tokenCache.size === 0) {
    return { status: "none", expiresAt: null }
  }
  let nearest: number | null = null
  for (const c of tokenCache.values()) nearest = nearest === null ? c.expiresAt : Math.min(nearest, c.expiresAt)
  const isValid = nearest !== null && isTokenFresh(nearest, Date.now())
  return { status: isValid ? "valid" : "expired", expiresAt: nearest }
}

/**
 * 生成消息序号，范围固定为 0~65535。
 * 用时间戳低位与随机数混合，避免进程内碰撞。
 */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100000000
  const random = Math.floor(Math.random() * 65536)
  return (timePart ^ random) % 65536
}

const DEFAULT_API_TIMEOUT = 30000
const FILE_UPLOAD_TIMEOUT = 120000

/**
 * 统一封装 QQ Bot REST 请求。
 * 保留源实现的超时、日志、错误处理和 JSON 解析行为。
 */
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  // 多角色：按 token 反查 appId 选 API 底座；查不到（legacy/外源 token）回退 env 开关
  const url = `${apiBase(resolveAppIdByToken(accessToken))}${path}`
  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    "Content-Type": "application/json",
  }

  const isFileUpload = path.includes("/files")
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT)

  console.log(`[qqbot-api] >>> ${method} ${url} (timeout: ${timeout}ms)`)
  console.log("[qqbot-api] >>> Headers:", JSON.stringify(maskHeaders(headers), null, 2))
  if (body) {
    const logBody = { ...(body as Record<string, unknown>) }
    if (typeof logBody.file_data === "string") {
      logBody.file_data = `<base64 ${logBody.file_data.length} chars>`
    }
    console.log("[qqbot-api] >>> Body:", JSON.stringify(logBody, null, 2))
  }

  // O 项（2026-10-30，吸收竞品 opencode-qq-v2 postWithRetry）：HTTP 429 限流时
  // 尊重 Retry-After 退避重试（最多再试 2 次，单次等待封顶 30s）；其余错误不重试。
  // 429 语义=请求被拒绝未生效，重试无副作用。
  let res: Response | undefined
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort()
    }, timeout)

    const options: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    }

    if (body) {
      options.body = JSON.stringify(body)
    }

    try {
      res = await fetch(url, options)
    } catch (err) {
      clearTimeout(timeoutId)
      if (err instanceof Error && err.name === "AbortError") {
        console.error(`[qqbot-api] <<< Request timeout after ${timeout}ms`)
        throw new Error(`Request timeout [${path}]: exceeded ${timeout}ms`)
      }
      console.error("[qqbot-api] <<< Network error:", err)
      throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timeoutId)
    }

    if (res.status === 429 && attempt < 2) {
      const retryAfterSec = Number(res.headers.get("Retry-After") ?? "1")
      const waitMs = Math.min(Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 1, 30) * 1000
      console.warn(`[qqbot-api] 429 限流，${waitMs}ms 后重试（第 ${attempt + 1}/2 次）: ${path}`)
      await new Promise((r) => setTimeout(r, waitMs))
      continue
    }
    break
  }
  const response = res as Response

  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  console.log(`[qqbot-api] <<< Status: ${response.status} ${response.statusText}`)
  console.log("[qqbot-api] <<< Headers:", JSON.stringify(maskHeaders(responseHeaders), null, 2))

  let data: T
  let rawBody: string
  try {
    rawBody = await response.text()
    console.log("[qqbot-api] <<< Body:", rawBody)
    data = JSON.parse(rawBody) as T
  } catch (err) {
    console.error("[qqbot-api] <<< Parse error:", err)
    throw new Error(`Failed to parse response [${path}]: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) {
    const error = data as { message?: string; code?: number }
    throw new Error(`API Error [${path}]: ${error.message ?? JSON.stringify(data)}`)
  }

  return data
}

/**
 * 获取 WebSocket Gateway 地址。
 */
export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway")
  return data.url
}

/**
 * QQ 发消息成功后的通用响应结构。
 */
export interface MessageResponse {
  id: string
  timestamp: number | string
}

/**
 * 构建消息体。
 * markdown=true 时用 msg_type=2（markdown 消息），content 放 markdown 原文；
 * 否则用 msg_type=0（纯文本）。注意: 传 markdown 时 content 字段必须为空。
 * keyboard 仅 markdown 卡片可携带（A 项 2026-10-29，形状对齐 P0 官方 SDK）。
 */
export interface KeyboardButton {
  id: string
  render_data: { label: string; visited_label: string; style: number }
  action: {
    type: number
    permission: { type: number; specify_user_ids?: string[] }
    data: string
    click_limit?: number
  }
}

export interface InlineKeyboard {
  content: { rows: Array<{ buttons: KeyboardButton[] }> }
}

function buildMessageBody(
  content: string,
  msgId: string | undefined,
  msgSeq: number,
  markdown = false,
  keyboard?: InlineKeyboard,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    msg_seq: msgSeq,
  }

  if (markdown) {
    body.msg_type = 2
    body.markdown = { content }
  } else {
    body.msg_type = 0
    body.content = content
  }

  if (msgId) {
    body.msg_id = msgId
  }

  if (keyboard) {
    body.keyboard = keyboard
  }

  return body
}

/**
 * 发送 C2C 单聊消息。
 * msgSeq 可选，传入时优先使用，便于上层做分片发送。
 * markdown=true 时以 markdown 消息发送（msg_type=2）。
 */
export async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
  msgSeq?: number,
  markdown = false,
  keyboard?: InlineKeyboard,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body = buildMessageBody(content, msgId, resolvedMsgSeq, markdown, keyboard)
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body)
}

/**
 * 发送 C2C 输入状态提示，告诉用户机器人正在输入。
 */
export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60,
): Promise<void> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: inputSecond,
    },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  }

  await apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body)
}

/**
 * 发送群聊消息。
 * msgSeq 可选，传入时优先使用，便于上层做分片发送。
 * markdown=true 时以 markdown 消息发送（msg_type=2）。
 */
export async function sendGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
  msgSeq?: number,
  markdown = false,
  keyboard?: InlineKeyboard,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body = buildMessageBody(content, msgId, resolvedMsgSeq, markdown, keyboard)
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body)
}

/**
 * 响应按钮互动回调（A 项 2026-10-29，端点对齐 P0 官方 SDK acknowledgeInteraction）。
 * QQ 平台要求收到 INTERACTION_CREATE 后 3 秒内响应，同 id 只能响应一次——
 * 调用方必须先 ack 再执行业务处理。
 *
 * ★ 2026-11-08 根因修复（「请求第三方失败」高频复现）：
 *   ① 每次**现取** token（对齐官方 SDK `acknowledgeInteraction` 里
 *      `tokenManager.getAccessToken(creds)` 的写法），不再传入连接期的快照；
 *      快照会随 7200s 过期而失效——WS 长连不断时，网关侧快照永远不会被更新，
 *      于是「消息发得出去（现取）、互动 ACK 全 401」。
 *   ② 401/11244 时清缓存重取后**重试一次**（失败的 ACK 未被平台受理，可安全重试）。
 */
export async function acknowledgeInteraction(
  appId: string,
  clientSecret: string,
  interactionId: string,
  code = 0,
): Promise<void> {
  const send = async (): Promise<void> => {
    const accessToken = await getAccessToken(appId, clientSecret)
    await apiRequest(accessToken, "PUT", `/interactions/${interactionId}`, { code })
  }
  try {
    await send()
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    console.warn(`[qqbot-api] 互动 ACK 鉴权失败，清缓存重取后重试一次: /interactions/${interactionId}`)
    clearTokenCache(appId)
    await send()
  }
}

// ── 媒体发送（生态观察缺口 4：bot→QQ 发图/文件，P0 参照 qqbot-nodejs protocol/api/media.ts）──
export const MediaFileType = { IMAGE: 1, VIDEO: 2, VOICE: 3, FILE: 4 } as const

/** 上传媒体到 QQ 拿 file_info（单次上限 20MB；base64 体由调用方给） */
export async function uploadQQMedia(
  accessToken: string,
  ctx: MessageContext,
  opts: { fileType: number; fileData?: string; url?: string; fileName?: string },
): Promise<{ file_uuid?: string; file_info: string; ttl?: number }> {
  const isGroup = ctx.type === "group" && ctx.groupId
  const body: Record<string, unknown> = { file_type: opts.fileType, srv_send_msg: false }
  if (opts.url) body.url = opts.url
  else if (opts.fileData) body.file_data = opts.fileData
  if (opts.fileType === MediaFileType.FILE && opts.fileName) body.file_name = opts.fileName
  const path = isGroup ? `/v2/groups/${ctx.groupId}/files` : `/v2/users/${ctx.userId}/files`
  return apiRequest(accessToken, "POST", path, body)
}

/** 发送媒体消息（msg_type=7，media.file_info 引用上传结果） */
export async function sendQQMediaMessage(
  accessToken: string,
  ctx: MessageContext,
  fileInfo: string,
  content?: string,
): Promise<MessageResponse> {
  const isGroup = ctx.type === "group" && ctx.groupId
  const body: Record<string, unknown> = {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: ctx.msgId ? getNextMsgSeq(ctx.msgId) : 1,
    ...(content ? { content } : {}),
    ...(ctx.msgId ? { msg_id: ctx.msgId } : {}),
  }
  const path = isGroup ? `/v2/groups/${ctx.groupId}/messages` : `/v2/users/${ctx.userId}/messages`
  return apiRequest(accessToken, "POST", path, body)
}

interface BackgroundTokenRefreshOptions {
  refreshAheadMs?: number
  randomOffsetMs?: number
  minRefreshIntervalMs?: number
  retryDelayMs?: number
  log?: {
    info: (msg: string) => void
    error: (msg: string) => void
    debug?: (msg: string) => void
  }
}

let backgroundRefreshAbort: AbortController | null = null
const backgroundRefreshApps = new Set<string>()

/**
 * 启动后台 Token 刷新循环（每角色一条独立循环；同 appId 重复调用幂等）。
 * 它会在 Token 过期前提前刷新，避免真正发消息时才发现 Token 已失效。
 */
export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: BackgroundTokenRefreshOptions,
): void {
  if (backgroundRefreshApps.has(appId)) {
    console.log(`[qqbot-api] Background token refresh already running (appId=${appId})`)
    return
  }

  const {
    refreshAheadMs = 5 * 60 * 1000,
    randomOffsetMs = 30 * 1000,
    minRefreshIntervalMs = 60 * 1000,
    retryDelayMs = 5 * 1000,
    log,
  } = options ?? {}

  backgroundRefreshApps.add(appId)
  if (!backgroundRefreshAbort) backgroundRefreshAbort = new AbortController()
  const signal = backgroundRefreshAbort.signal

  const refreshLoop = async () => {
    log?.info?.(`[qqbot-api] Background token refresh started (appId=${appId})`)

    while (!signal.aborted && backgroundRefreshApps.has(appId)) {
      try {
        await getAccessToken(appId, clientSecret)

        const cached = tokenCache.get(appId)
        if (cached) {
          const expiresIn = cached.expiresAt - Date.now()
          const randomOffset = Math.random() * randomOffsetMs
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs,
          )

          log?.debug?.(`[qqbot-api] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`)
          await sleep(refreshIn, signal)
        } else {
          log?.debug?.("[qqbot-api] No cached token, retrying soon")
          await sleep(minRefreshIntervalMs, signal)
        }
      } catch (err) {
        if (signal.aborted) break

        log?.error?.(`[qqbot-api] Background token refresh failed (appId=${appId}): ${err}`)
        await sleep(retryDelayMs, signal)
      }
    }

    backgroundRefreshApps.delete(appId)
    log?.info?.(`[qqbot-api] Background token refresh stopped (appId=${appId})`)
  }

  refreshLoop().catch((err) => {
    backgroundRefreshApps.delete(appId)
    log?.error?.(`[qqbot-api] Background token refresh crashed (appId=${appId}): ${err}`)
  })
}

/**
 * 停止后台 Token 刷新循环（停全部角色）。
 */
export function stopBackgroundTokenRefresh(): void {
  if (backgroundRefreshAbort) {
    backgroundRefreshAbort.abort()
    backgroundRefreshAbort = null
  }
  backgroundRefreshApps.clear()
}

/**
 * 可被 AbortSignal 中断的 sleep，供后台刷新循环复用。
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve()
    }, ms)

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error("Aborted"))
        return
      }

      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error("Aborted"))
      }

      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}
