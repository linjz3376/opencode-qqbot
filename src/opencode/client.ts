// V2-compatible OpenCode client (fetch-based).
// The bundled V1 @opencode-ai/sdk is incompatible with the V2 server API:
//   - its client-side payload validation rejects session.create({}) before the
//     request is even sent, and
//   - its SSE event model differs from V2.
// So we talk to the V2 REST API directly instead. Endpoint contract (base = .../api):
//   POST   /session                     -> { data: { id } }
//   GET    /session                     -> { data: [...] }
//   POST   /session/{id}/prompt {text}  -> { data: { time.created } }
//        (v2 body additionalProperties:false —— model/agent 字段会被 zod 静默剥离，
//         模型/agent 是 session 级设置，见下面 /model /agent 端点)
//   GET    /session/{id}/message        -> { data: [...] }
//   POST   /session/{id}/interrupt   (v2: /abort 不存在，返回 404)
//   POST   /session/{id}/model {model:{providerID,id}}   -> 204 (session 级切模型)
//   POST   /session/{id}/agent {agent}                   -> 204 (session 级切 agent)
//   GET    /permission/request          -> { data: PermissionRequest[] } (全局待审批)
//   POST   /session/{id}/permission/{requestID}/reply {decision} -> 204
//   GET    /agent                       -> { data: [...] }
//   GET    /model                       -> { data: [ { providerID, modelID } ] } (flat)
export type PermissionDecision = "once" | "always" | "reject"

// L 项（2026-10-30）：V2 Form（选择表单）类型——P0 实证 openapi Form.* schema。
// MultiselectField/StringField.options 即 "A/B/C/D 选择弹窗"的选项模型。
export interface FormOption {
  value: string
  label: string
  description?: string
}

export type FormField =
  | { key: string; type: "string"; title?: string; description?: string; required?: boolean; options?: FormOption[]; placeholder?: string }
  | { key: string; type: "number" | "integer"; title?: string; description?: string; required?: boolean; minimum?: number; maximum?: number }
  | { key: string; type: "boolean"; title?: string; description?: string; required?: boolean }
  | { key: string; type: "multiselect"; title?: string; description?: string; required?: boolean; options: FormOption[]; minItems?: number; maxItems?: number; custom?: boolean }
  | { key: string; type: string; title?: string; description?: string; required?: boolean }

export interface FormInfo {
  id: string
  sessionID: string
  title: string
  fields: FormField[]
}

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  message?: string
}

export interface PromptOptions {
  model?: { providerID: string; modelID: string }
  agent?: string
}

export interface PromptAndWaitOptions extends PromptOptions {
  // 原生附件（2026-10-14）：prompt body 的 files（v2 PromptInput schema 内
  // 字段，additionalProperties:false 不会剥它；model/agent 才会被剥）
  files?: Array<{ uri: string; name?: string }>
  // 轮询中发现待审批权限时调用；返回用户的审批决策后，promptAndWait 负责
  // POST reply 并继续等待 idle。审批等待时间不计入 5 分钟超时。
  onPermission?: (req: PermissionRequest) => Promise<PermissionDecision>
  // reply POST 成功后回调（确认消息在服务端受理后再发，避免误导）
  onPermissionReplied?: (decision: PermissionDecision) => void
  // reply 404 = 请求已在其他端（桌面）被处理：不致命，任务继续，仅需提示
  onPermissionConflict?: () => void
}

export interface MessagePart {
  type: string
  text?: string
  tool?: string
  state?: unknown
}

export interface SessionMessage {
  type?: string
  time?: { created?: number; completed?: number }
  content?: MessagePart[]
  finish?: string
  text?: string
  model?: { id?: string; providerID?: string }
}

export interface OpencodeClient {
  baseUrl: string
  // HC2（2026-10-26）：运行中热换基（端口漂移自愈）。原地改闭包 base，
  // 引用不变——sessions/bridge 等持有方零感知。
  rebase(url: string): void
  session: {
    create(body?: Record<string, unknown>): Promise<{ data?: { id: string; title?: string } }>
    list(): Promise<{ data?: unknown[] }>
    abort(opts: { path: { id: string } }): Promise<unknown>
    messages(opts: { path: { id: string } }): Promise<{ data?: SessionMessage[] }>
    prompt(opts: { path: { id: string }; body: { text: string } & PromptOptions }): Promise<{ data?: { time?: { created?: number } } }>
    setModel(opts: { path: { id: string }; body: { model: { providerID: string; id: string } } }): Promise<unknown>
    setAgent(opts: { path: { id: string }; body: { agent: string } }): Promise<unknown>
  }
  permission: {
    list(): Promise<{ data?: PermissionRequest[] }>
    reply(opts: { path: { sessionID: string; requestID: string }; body: { decision: PermissionDecision } }): Promise<unknown>
  }
  // L 项（2026-10-30）：V2 Form API——按会话列表（实测 GET /api/form 是 location 维度，
  // bot 进程 cwd 与会话项目不一致会漏；会话级列表才可靠）+ 作答
  form: {
    list(input: { sessionID: string }): Promise<{ data?: FormInfo[] }>
    reply(opts: { path: { sessionID: string; formID: string }; body: { answer: Record<string, unknown> } }): Promise<unknown>
  }
  app: {
    agents(): Promise<{ data?: unknown[] }>
  }
  config: {
    providers(): Promise<{ data?: unknown[] }>
  }
  // Send a prompt and poll until the assistant reply for THIS prompt is done.
  promptAndWait(sessionId: string, text: string, options?: PromptAndWaitOptions): Promise<string>
}

// 回合超时：原 5 分钟与 QQ 被动回复窗口绑定，但真实长任务（写码+多轮工具）
// 常超 5 分钟——超时后答案永久丢失（实测 2026-10-13）。最终回复现已有主动
// 消息兜底（bridge.deliver 被动失败→主动），已解耦。默认 30 分钟，
// 可用 env OPENCODE_TURN_TIMEOUT_MINUTES 覆盖。
const TURN_TIMEOUT_MINUTES = (() => {
  const n = Number(process.env.OPENCODE_TURN_TIMEOUT_MINUTES ?? "30")
  return Number.isFinite(n) && n > 0 ? n : 30
})()
const RESPONSE_TIMEOUT_MS = TURN_TIMEOUT_MINUTES * 60 * 1000

// 聚合某轮（baseline 之后）所有 assistant 消息的文本部件，丢弃 reasoning/tool 部件。
// promptAndWait 与 bridge 的后台等待共用（后台等待 = 前台超时后不放弃，完成即回传）。
export function collectReplyText(msgs: SessionMessage[], baseline: number): string {
  return msgs
    .filter((x) => x.type === "assistant" && (x.time?.created ?? 0) >= baseline)
    .flatMap((x) => (x.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? ""))
    .join("\n")
    .trim()
}

let client: OpencodeClient | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createClient(baseUrl: string): OpencodeClient {
  // HC2：let 而非 const —— rebase 热换基需要
  let base = baseUrl.replace(/\/+$/, "")
  const password = process.env.OPENCODE_PASSWORD
  const authHeaders: Record<string, string> = { "Content-Type": "application/json" }
  if (password) {
    // V2 desktop API is protected by Basic Auth (opencode:<service.json password>).
    // fetch() forbids credentials in the URL, so inject via the Authorization header.
    authHeaders.Authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  }

  async function req(path: string, init?: RequestInit): Promise<Response> {
    return fetch(base + path, {
      ...init,
      headers: { ...authHeaders, ...((init?.headers as Record<string, string>) ?? {}) },
    })
  }

  async function json(res: Response): Promise<any> {
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      throw new Error(`OpenCode API ${res.status}: ${txt.substring(0, 200)}`)
    }
    // 204 (如 /model /agent /permission reply) 无 body；res.json() 会抛错。
    if (res.status === 204) return null
    const txt = await res.text()
    if (!txt.trim()) return null
    return JSON.parse(txt)
  }

  const oc: OpencodeClient = {
    get baseUrl() {
      return base
    },

    rebase(nextUrl: string) {
      const next = nextUrl.replace(/\/+$/, "")
      if (next !== base) {
        console.log(`[opencode] 热换基：${base} → ${next}`)
        base = next
      }
    },

    session: {
      async create(body = {}) {
        return json(await req("/session", { method: "POST", body: JSON.stringify(body) }))
      },
      async list() {
        return json(await req("/session"))
      },
      async abort(opts) {
        return json(await req(`/session/${opts.path.id}/interrupt`, { method: "POST", body: "{}" }))
      },
      async messages(opts) {
        return json(await req(`/session/${opts.path.id}/message`))
      },
      async prompt(opts) {
        return json(await req(`/session/${opts.path.id}/prompt`, { method: "POST", body: JSON.stringify(opts.body) }))
      },
      async setModel(opts) {
        return json(await req(`/session/${opts.path.id}/model`, { method: "POST", body: JSON.stringify(opts.body) }))
      },
      async setAgent(opts) {
        return json(await req(`/session/${opts.path.id}/agent`, { method: "POST", body: JSON.stringify(opts.body) }))
      },
    },

    permission: {
      async list() {
        return json(await req("/permission/request"))
      },
      async reply(opts) {
        return json(
          await req(`/session/${opts.path.sessionID}/permission/${opts.path.requestID}/reply`, {
            method: "POST",
            body: JSON.stringify(opts.body),
          }),
        )
      },
    },

    form: {
      async list(input) {
        return json(await req(`/session/${input.sessionID}/form`))
      },
      async reply(opts) {
        return json(
          await req(`/session/${opts.path.sessionID}/form/${opts.path.formID}/reply`, {
            method: "POST",
            body: JSON.stringify(opts.body),
          }),
        )
      },
    },

    app: {
      async agents() {
        return json(await req("/agent"))
      },
    },

    config: {
      async providers() {
        // V2 exposes a flat model list at GET /model. Group by provider to match
        // the shape the /model command expects: { data: [ { id, models: [ { id } ] } ] }.
        const res = await json(await req("/model"))
        const models = (res?.data ?? []) as Array<{ providerID?: string; modelID?: string; id?: string }>
        const byProvider = new Map<string, { id: string; models: { id: string }[] }>()
        for (const m of models) {
          const pid = m.providerID
          const mid = m.modelID ?? m.id
          if (!pid || !mid) continue
          if (!byProvider.has(pid)) byProvider.set(pid, { id: pid, models: [] })
          byProvider.get(pid)!.models.push({ id: mid })
        }
        return { data: [...byProvider.values()] }
      },
    },

    async promptAndWait(sessionId, text, options) {
      // v2: prompt body 只接受 {text,...}（additionalProperties:false），model/agent
      // 会被静默剥离 —— 不再往 body 里塞；模型/agent 由 SessionManager 走 session 级端点。
      const body: { text: string; files?: Array<{ uri: string; name?: string }> } = { text }
      if (options?.files?.length) body.files = options.files

      // 债务D1：子会话（subagent）审批检测——session 详情带 parentID
      //（2026-10-13 探针实证：task 工具的子会话 parentID 精确指向主会话）。
      // 只做父链精确匹配，不做全局猜测；parentID 永不变，负缓存安全。
      const childLinkCache = new Map<string, boolean>()
      async function isChildSession(childId: string, parentId: string): Promise<boolean> {
        const key = `${parentId}->${childId}`
        const cached = childLinkCache.get(key)
        if (cached !== undefined) return cached
        let result = false
        try {
          const detail = await json(await req(`/session/${childId}`))
          result = detail?.data?.parentID === parentId
        } catch {
          result = false
        }
        if (childLinkCache.size > 500) childLinkCache.clear()
        childLinkCache.set(key, result)
        return result
      }

      // The prompt call returns as soon as the user message is created (~ms);
      // the assistant reply streams in over the next few seconds.
      const promptJson = await json(
        await req(`/session/${sessionId}/prompt`, { method: "POST", body: JSON.stringify(body) }),
      )
      // Only accept assistant messages created at/after this prompt, so a prior
      // turn's completed reply is never mistaken for this turn's answer.
      const baseline = promptJson?.data?.time?.created ?? 0

      const deadline = Date.now() + RESPONSE_TIMEOUT_MS
      let permissionWaitMs = 0 // 审批等待时间不计入 5 分钟超时（用户可能几分钟才回复）
      const handledPermissions = new Set<string>()

      while (Date.now() - permissionWaitMs < deadline) {
        await sleep(1000)

        // 审批检测：会话阻塞在权限请求上时不会产生 idle，必须先放行。
        if (options?.onPermission) {
          try {
            const permJson = await json(await req("/permission/request"))
            const all = (permJson?.data ?? []) as PermissionRequest[]
            // 债务D1：主会话请求 + 子会话（subagent，parentID 指向本会话）请求
            const pending: PermissionRequest[] = []
            for (const r of all) {
              if (handledPermissions.has(r.id)) continue
              if (r.sessionID === sessionId) {
                pending.push(r)
                continue
              }
              if (await isChildSession(r.sessionID, sessionId)) pending.push(r)
            }
            if (pending.length > 0) {
              const request = pending[0]
              handledPermissions.add(request.id)
              const waitStart = Date.now()
              const decision = await options.onPermission(request)
              permissionWaitMs += Date.now() - waitStart
              // reply 用请求自带的 sessionID（与轮询会话 id 在同会话时相同，
              // 但若请求来自子会话则必须用请求的归属会话，否则 404）。
              const replyRes = await req(`/session/${request.sessionID}/permission/${request.id}/reply`, {
                method: "POST",
                body: JSON.stringify({ decision }),
              })
              if (replyRes.status === 404) {
                // 债务D2：请求已被其他端（桌面）先处理——不是错误，任务继续
                options?.onPermissionConflict?.()
              } else {
                await json(replyRes)
                options?.onPermissionReplied?.(decision)
              }
              continue // 决策已提交，重新进入轮询
            }
          } catch (error) {
            // 审批链路故障不能杀死本轮对话。请求在回调前已标记 handled：
            // 不会重复推送 QQ，但 reply 失败时会留到 5 分钟超时暴露问题。
            console.error("[opencode] 权限审批轮询失败:", error)
          }
        }

        const listJson = await json(await req(`/session/${sessionId}/message`))
        const msgs: SessionMessage[] = listJson?.data ?? []
        // Completion = the idle marker created at/after this prompt. This is the
        // only reliable "whole turn done" signal: tool-using turns emit several
        // assistant messages (reasoning+tool) before the final text one, so
        // "first completed assistant" would return an empty tool message.
        const idle = msgs.find((x) => x.type === "idle" && (x.time?.created ?? 0) >= baseline)
        if (idle) {
          // Aggregate text parts from ALL assistant messages of this turn,
          // dropping reasoning/tool parts. In practice only the final assistant
          // carries text; earlier ones are reasoning+tool.
          const reply = collectReplyText(msgs, baseline)
          return reply || "(AI 未返回内容)"
        }
      }
      throw new Error(`AI 响应超时（${TURN_TIMEOUT_MINUTES} 分钟）`)
    },
  }

  client = oc
  return oc
}

export function getClient(): OpencodeClient {
  if (!client) throw new Error("OpenCode client not initialized")
  return client
}

export async function healthCheck(oc: OpencodeClient, quiet = false): Promise<void> {
  try {
    await oc.session.list()
    if (!quiet) console.log("[opencode] 连接正常")
  } catch (error) {
    throw new Error(`OpenCode 连接失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}
