// @input:  ./config, ./qq/types, ./opencode/* (client, sessions)
// @output: isCommand, handleCommand, handlePendingSelection, CommandContext, PendingSelection
// @pos:    根层 - 命令系统: /new /stop /status /sessions /help /model /agent /rename
import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import type { OpencodeClient, SessionMessage } from "./opencode/client.js"
import { renderHistory } from "./opencode/history.js"
import { SessionManager } from "./opencode/sessions.js"

const SELECTION_TTL_MS = 60_000

// 观察模式 API（bridge 实现：SSE 订阅 + 里程碑推送）
export interface WatchApi {
  start: (userId: string, sessionID: string, ctx: MessageContext) => string
  stop: (userId: string) => string
  status: (userId: string) => string
}

// 摘要镜像 API（bridge 实现：订阅 + 摘要卡投递 + 持久开关）
export interface MirrorApi {
  set: (enabled: boolean) => string
  status: () => string
}

export interface CommandContext {
  config: Config
  client: OpencodeClient
  sessions: SessionManager
  getAccessToken: () => Promise<string>
  pendingSelections: Map<string, PendingSelection>
  watch: WatchApi
  mirror: MirrorApi
}

export interface PendingSelection {
  type: "session" | "model"
  items: Array<{ id: string; label: string }>
  expiresAt: number
}

interface ParsedCommand {
  name: string
  args: string
}

interface ListedSession {
  id: string
  title: string
}

interface ListedModel {
  id: string
  label: string
}

interface ListedAgent {
  id: string
  label: string
}

export function isCommand(content: string): boolean {
  return content.trim().startsWith("/")
}

export async function handleCommand(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  cmdCtx.pendingSelections.delete(ctx.userId)

  const parsed = parseCommand(ctx.content)
  if (!parsed) {
    return "不是有效命令"
  }

  switch (parsed.name) {
    case "new":
      return handleNew(ctx, cmdCtx)
    case "stop":
      return handleStop(ctx, cmdCtx)
    case "status":
      return handleStatus(ctx, cmdCtx)
    case "sessions":
      return handleSessions(ctx, cmdCtx)
    case "help":
      return buildHelpText()
    case "model":
      return handleModel(ctx, parsed.args, cmdCtx)
    case "agent":
      return handleAgent(ctx, parsed.args, cmdCtx)
    case "rename":
      return handleRename(ctx, parsed.args, cmdCtx)
    case "history":
      return handleHistory(ctx, parsed.args, cmdCtx)
    case "watch":
      return handleWatch(ctx, parsed.args, cmdCtx)
    case "mirror":
      return handleMirror(parsed.args, cmdCtx)
    default:
      return `不支持的命令：/${parsed.name}\n发送 /help 查看可用命令`
  }
}

export async function handlePendingSelection(
  userId: string,
  selection: number,
  cmdCtx: CommandContext,
): Promise<string | null> {
  const pending = cmdCtx.pendingSelections.get(userId)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    cmdCtx.pendingSelections.delete(userId)
    return null
  }

  const item = pending.items[selection - 1]
  if (!item) {
    return `序号无效，请回复 1-${pending.items.length}`
  }

  cmdCtx.pendingSelections.delete(userId)

  if (pending.type === "session") {
    cmdCtx.sessions.switchSession(userId, item.id, item.label)
    return `已切换到会话：${item.label}`
  }

  const model = splitModelId(item.id)
  if (!model) {
    return `模型项无效：${item.label}`
  }

  await ensureSession(userId, cmdCtx)
  await cmdCtx.sessions.setModel(userId, model.providerId, model.modelId)
  return `已切换模型：${item.label}`
}

function parseCommand(content: string): ParsedCommand | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith("/")) {
    return null
  }

  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
  const name = rawName?.toLowerCase()
  if (!name) {
    return null
  }

  return {
    name,
    args: rest.join(" ").trim(),
  }
}

async function handleNew(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = await cmdCtx.sessions.createNew(ctx.userId)
  return [
    "已创建新会话",
    `标题：${session.title ?? "未命名会话"}`,
    `ID：${session.sessionId}`,
  ].join("\n")
}

async function handleStop(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话可停止"
  }

  await cmdCtx.client.session.abort({ path: { id: session.sessionId } })
  return `已发送停止请求：${session.title ?? session.sessionId}`
}

async function handleStatus(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  const { providerId, modelId } = cmdCtx.sessions.getModel(ctx.userId)
  const agentId = cmdCtx.sessions.getAgent(ctx.userId)

  const openCodeStatus = await getOpenCodeStatus(cmdCtx.client)
  const qqStatus = await getQQStatus(cmdCtx)

  return [
    "OpenCode 状态",
    `服务器：${openCodeStatus}`,
    `QQ 鉴权：${qqStatus}`,
    `会话：${session ? `${session.title ?? "未命名会话"} (${session.sessionId})` : "未创建"}`,
    `模型：${providerId && modelId ? `${providerId} / ${modelId}` : "默认"}`,
    `Agent：${agentId ?? "默认"}`,
  ].join("\n")
}

async function handleSessions(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const sessions = await listSessions(cmdCtx.client)
  if (sessions.length === 0) {
    return "当前没有可切换的历史会话"
  }

  const currentSessionId = cmdCtx.sessions.getSession(ctx.userId)?.sessionId
  cmdCtx.pendingSelections.set(ctx.userId, {
    type: "session",
    items: sessions.map((session) => ({ id: session.id, label: session.title })),
    expiresAt: Date.now() + SELECTION_TTL_MS,
  })

  const lines = sessions.map((session, index) => {
    const prefix = session.id === currentSessionId ? "[当前] " : ""
    return `${index + 1}. ${prefix}${session.title}`
  })

  return ["会话列表：", ...lines, "回复序号切换会话（60 秒内有效）"].join("\n")
}

async function handleModel(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  if (!args) {
    const models = await listModels(cmdCtx.client)
    if (models.length === 0) {
      return "当前没有可用模型"
    }

    const current = cmdCtx.sessions.getModel(ctx.userId)
    cmdCtx.pendingSelections.set(ctx.userId, {
      type: "model",
      items: models.map((model) => ({ id: model.id, label: model.label })),
      expiresAt: Date.now() + SELECTION_TTL_MS,
    })

    const lines = models.map((model, index) => {
      const isCurrent = current.providerId && current.modelId && `${current.providerId}/${current.modelId}` === model.id
      return `${index + 1}. ${isCurrent ? "[当前] " : ""}${model.label}`
    })

    return ["可用模型：", ...lines, "回复序号或 /model <provider/model> 切换（60 秒内有效）"].join("\n")
  }

  if (/^\d+$/.test(args)) {
    const result = await handlePendingSelection(ctx.userId, Number(args), cmdCtx)
    return result ?? "没有待选择的模型列表，请先发送 /model"
  }

  const model = splitModelId(args)
  if (!model) {
    return "模型格式不对，请使用 /model <provider/model>"
  }

  await ensureSession(ctx.userId, cmdCtx)
  await cmdCtx.sessions.setModel(ctx.userId, model.providerId, model.modelId)
  return `已切换模型：${model.providerId} / ${model.modelId}`
}

async function handleAgent(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const agents = await listAgents(cmdCtx.client)
  if (!args) {
    if (agents.length === 0) {
      return "当前没有可用 Agent"
    }

    const currentAgent = cmdCtx.sessions.getAgent(ctx.userId)
    const lines = agents.map((agent, index) => {
      const isCurrent = currentAgent === agent.id
      return `${index + 1}. ${isCurrent ? "[当前] " : ""}${agent.label}`
    })

    return ["可用 Agent：", ...lines, "回复 /agent <name> 切换"].join("\n")
  }

  const normalized = args.trim().toLowerCase()
  const matched = agents.find((agent) => agent.id.toLowerCase() === normalized)
  if (!matched) {
    return `未找到 Agent：${args}`
  }

  await ensureSession(ctx.userId, cmdCtx)
  await cmdCtx.sessions.setAgent(ctx.userId, matched.id)
  return `已切换 Agent：${matched.id}`
}

async function handleRename(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const title = args.trim()
  if (!title) {
    return "用法：/rename <新名称>"
  }

  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话可重命名"
  }

  cmdCtx.sessions.switchSession(ctx.userId, session.sessionId, title)
  return `已重命名当前会话：${title}`
}

async function handleHistory(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话"
  }

  const n = /^\d+$/.test(args.trim()) ? Math.min(Math.max(Number(args.trim()), 1), 10) : 3
  const res = await cmdCtx.client.session.messages({ path: { id: session.sessionId } })
  const messages: SessionMessage[] = res?.data ?? []
  const body = renderHistory(messages, n)
  if (!body) {
    return "该会话暂无历史消息"
  }
  return `📜 ${session.title ?? session.sessionId} · 最近 ${n} 轮\n\n${body}`
}

async function handleWatch(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const a = args.trim()
  const lower = a.toLowerCase()

  if (lower === "off" || lower === "stop") {
    return cmdCtx.watch.stop(ctx.userId)
  }

  if (!a) {
    const session = await cmdCtx.sessions.getOrCreate(ctx.userId)
    return cmdCtx.watch.start(ctx.userId, session.sessionId, ctx)
  }

  if (/^ses_/i.test(a)) {
    return cmdCtx.watch.start(ctx.userId, a, ctx)
  }

  return "用法：/watch 观察当前会话｜/watch <会话ID> 观察指定会话｜/watch off 停止观察"
}

function handleMirror(args: string, cmdCtx: CommandContext): string {
  const a = args.trim().toLowerCase()
  if (!a) return cmdCtx.mirror.status()
  if (["on", "1", "开", "打开"].includes(a)) return cmdCtx.mirror.set(true)
  if (["off", "0", "关", "关闭"].includes(a)) return cmdCtx.mirror.set(false)
  return "用法：/mirror 查看状态｜/mirror on 开启｜/mirror off 关闭"
}

async function ensureSession(userId: string, cmdCtx: CommandContext): Promise<void> {
  await cmdCtx.sessions.getOrCreate(userId)
}

async function getOpenCodeStatus(client: OpencodeClient): Promise<string> {
  try {
    await client.session.list()
    return "运行中"
  } catch (error) {
    return `异常（${toErrorMessage(error)}）`
  }
}

async function getQQStatus(cmdCtx: CommandContext): Promise<string> {
  try {
    await cmdCtx.getAccessToken()
    return "正常"
  } catch (error) {
    return `异常（${toErrorMessage(error)}）`
  }
}

async function listSessions(client: OpencodeClient): Promise<ListedSession[]> {
  const result = await client.session.list()
  const rawItems = extractArray(result)
  const items = rawItems.length > 0 ? rawItems : extractArray(extractProperty(result, "data"))

  return items
    .map((item) => {
      const id = getString(item, "id")
      if (!id) {
        return null
      }

      return {
        id,
        title: getString(item, "title") ?? id,
      }
    })
    .filter((item): item is ListedSession => item !== null)
}

async function listModels(client: OpencodeClient): Promise<ListedModel[]> {
  const configApi = extractProperty(client, "config")
  const providersFn = typeof configApi === "object" && configApi !== null ? Reflect.get(configApi, "providers") : undefined
  const response = typeof providersFn === "function" ? await Promise.resolve(providersFn.call(configApi)) : []

  const providers = extractArray(response)
  const resolvedProviders = providers.length > 0 ? providers : extractArray(extractProperty(response, "data"))
  const models: ListedModel[] = []

  for (const provider of resolvedProviders) {
    const providerId = getString(provider, "id") ?? getString(provider, "providerID")
    const rawModels = extractArray(extractProperty(provider, "models"))
    for (const model of rawModels) {
      const modelId = getString(model, "id") ?? getString(model, "modelID")
      if (!providerId || !modelId) {
        continue
      }
      models.push({
        id: `${providerId}/${modelId}`,
        label: `${providerId} / ${modelId}`,
      })
    }
  }

  return models
}

async function listAgents(client: OpencodeClient): Promise<ListedAgent[]> {
  const response = await client.app.agents()
  const rawAgents = extractArray(response)
  const agents = rawAgents.length > 0 ? rawAgents : extractArray(extractProperty(response, "data"))

  return agents
    .map((agent) => {
      const id = getString(agent, "id") ?? getString(agent, "name")
      if (!id) {
        return null
      }

      const description = getString(agent, "description")
      return {
        id,
        label: description ? `${id} - ${description}` : id,
      }
    })
    .filter((agent): agent is ListedAgent => agent !== null)
}

function splitModelId(value: string): { providerId: string; modelId: string } | null {
  const trimmed = value.trim()
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null
  }

  const providerId = trimmed.slice(0, slashIndex).trim()
  const modelId = trimmed.slice(slashIndex + 1).trim()
  if (!providerId || !modelId) {
    return null
  }

  return { providerId, modelId }
}

export function buildHelpText(): string {
  return [
    "可用命令：",
    "/new - 创建新会话",
    "/stop - 停止当前 AI 运行",
    "/status - 查看服务器和当前会话状态",
    "/sessions - 列出历史会话并回复序号切换",
    "/help - 查看帮助",
    "/model - 列出可用模型",
    "/model <provider/model> - 切换模型",
    "/agent - 列出可用 Agent",
    "/agent <name> - 切换 Agent",
    "/rename <name> - 重命名当前会话",
    "/history [N] - 查看当前会话最近 N 轮历史（默认 3，最多 10）",
    "/watch - 观察当前会话实时过程（工具调用/完成会推送摘要）",
    "/watch <会话ID> - 观察指定会话",
    "/watch off - 停止观察",
    "/mirror [on|off] - 桌面问答摘要镜像开关（会话轮次完成推送问答摘要）",
    "",
    "权限审批（AI 请求权限时）：",
    "回复「允许」= 本次允许｜「总是」= 总是允许｜「拒绝」= 拒绝",
    "也可用 /allow /always /deny（30 分钟无响应自动拒绝）",
  ].join("\n")
}

function extractArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter(isRecord)
}

function extractProperty(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined
  }
  return value[key]
}

function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const resolved = value[key]
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
