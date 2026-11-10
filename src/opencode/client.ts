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
  // 修复⑧（2026-11-03）：受领回调——prompt 落库即回传 { promptId, baseline }。
  // promptId = 本回合 user 消息 id，是「直答归属本回合」的精确锚点（共享会话下
  // 「baseline 后第一条 assistant」会抓到别回合的产物）。
  onAccepted?: (info: { promptId: string; baseline: number }) => void
  // 轮询中发现待审批权限时调用；返回用户的审批决策后，promptAndWait 负责
  // POST reply 并继续等待 idle。审批等待时间不计入 5 分钟超时。
  onPermission?: (req: PermissionRequest) => Promise<PermissionDecision>
  // reply POST 成功后回调（确认消息在服务端受理后再发，避免误导）
  onPermissionReplied?: (decision: PermissionDecision) => void
  // reply 404 = 请求已在其他端（桌面/引擎自动放行）被处理：不致命，任务继续。
  // 2026-11-07：回调带裁决值——「拒绝」遇 404 说明动作可能已执行，须告警（DEF-qqbot-20261107-1）。
  onPermissionConflict?: (decision: PermissionDecision) => void
}

export interface MessagePart {
  type: string
  text?: string
  tool?: string
  state?: unknown
}

export interface SessionMessage {
  id?: string
  type?: string
  time?: { created?: number; completed?: number }
  content?: MessagePart[]
  /** 运行时工具段（REST 实际返回 tool parts；类型补录 2026-11-10 终稿提取用） */
  parts?: Array<{ type?: string; tool?: string; state?: { status?: string } }>
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
    /** 会话详情（location.directory=项目归属；model/agent=会话级设置，切换回读/显示锚点用） */
    get(opts: { path: { id: string } }): Promise<{
      data?: {
        id?: string
        title?: string
        location?: { directory?: string }
        model?: { id?: string; providerID?: string; variant?: string }
        agent?: string
      }
    }>
    /** 设置会话项目归属（POST /session/{id}/move；directory=绝对路径） */
    move(opts: { path: { id: string }; body: { directory: string } }): Promise<unknown>
    abort(opts: { path: { id: string } }): Promise<unknown>
    messages(opts: {
      path: { id: string }
      query?: { limit?: number; cursor?: string }
    }): Promise<{ data?: SessionMessage[]; cursor?: { next?: string } }>
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
    cancel(opts: { path: { sessionID: string; formID: string } }): Promise<unknown>
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
// ★ P0 同族修复（2026-11-03）：静态 const 在模块加载期捕获 env，.env 运行时才
//    注入——发布包装后 OVERRIDE 永远赶不上。改惰性函数：每次调用现场取值。
function turnTimeoutMinutes(): number {
  const n = Number(process.env.OPENCODE_TURN_TIMEOUT_MINUTES ?? "30")
  return Number.isFinite(n) && n > 0 ? n : 30
}
function responseTimeoutMs(): number {
  return turnTimeoutMinutes() * 60 * 1000
}

// 取 baseline 之后最后一个有正文的 assistant 消息，丢弃 reasoning/tool 与阶段前导语。
// 长回合会产生多条“正在检查/进度总结”assistant 文本；全部拼接会把过程包装成多条
// 相近答案。promptAndWait 与后台等待都只应交付最终回答。
export function collectReplyText(msgs: SessionMessage[], baseline: number): string {
  const latest = msgs
    .filter((x) => x.type === "assistant" && (x.time?.created ?? 0) >= baseline)
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
    .find((x) => (x.content ?? []).some((p) => p.type === "text" && p.text?.trim()))
  return (latest?.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim()
}

// 修复⑧（2026-11-03 定案）：回合边界归属——共享会话错误源实证（expA 等 21 分钟
// 拿到桌面排障报告）：collectReplyText 的「baseline 后最新 assistant」在共享会话
// 会抓到别回合产物。正确口径=只取本回合自己：
//   ① 定位本回合 user 行——promptId 精确匹配（prompt API 受理返回值）；
//   ② 兜底时间锚：created == baseline 的 user 行（受理即落库，±1s 容差错 skew）；
//   ③ 边界=该 user 行 → 下一条 user 行之前；hasIdle/text 都只看边界内。
// 锚点全部失配（形状变化/兼容旧数据）→ 回落旧 baseline 判据（anchored=false）。
export interface TurnState {
  /** true=已按回合边界定位（text/hasIdle 只关乎本回合）；false=回落旧判据 */
  anchored: boolean
  /** 本回合（或旧判据窗口内）是否已出现 idle 终结标记 */
  hasIdle: boolean
  /** 本回合（或旧判据窗口内）最终 assistant 正文；无正文为空串 */
  text: string
  /** DEF-qqbot-20261107-P2：本回合已被同会话新输入接管（runner 接管语义，
   *  回合已死，idle/正文永远不会到来）；前台/后台等待方据此按「被打断」终态结算 */
  superseded: boolean
}

/** DEF-qqbot-20261107-P2（2026-11-07）：本回合被同会话新输入接管。
 *  前台/后台等待方捕获后给用户可见交代并按 superseded 销账——不等 30 分钟超时、
 *  不谎称「转后台继续执行」、不再交付占位符。 */
export class SupersededError extends Error {
  constructor(readonly sessionId: string) {
    super(`superseded: 会话 ${sessionId} 的回合被同会话新输入接管`)
    this.name = "SupersededError"
  }
}

export function turnStateOf(msgs: SessionMessage[], promptId: string, baseline: number): TurnState {
  const ordered = [...msgs].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  let userIdx = -1
  if (promptId) userIdx = ordered.findIndex((m) => m.type === "user" && m.id === promptId)
  if (userIdx < 0 && baseline > 0) {
    // 修复⑧时间锚兜底：baseline 即本回合 user 行 created（受理即落库），取最近命中；
    // 容差 200ms 仅吸收毫秒级落库偏差，防同窗紧邻行误绑（17:37 定案：5 连发行距 ms 级，锚必最准）。
    let best = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].type !== "user") continue
      const delta = Math.abs((ordered[i].time?.created ?? 0) - baseline)
      if (delta < bestDelta) {
        bestDelta = delta
        best = i
      }
    }
    if (best >= 0 && bestDelta <= 200) userIdx = best
  }
  if (userIdx < 0) {
    // 回落旧判据：行为与 collectReplyText 时代一致，不引入新风险
    const idle = msgs.find((x) => x.type === "idle" && (x.time?.created ?? 0) >= baseline)
    return { anchored: false, hasIdle: Boolean(idle), text: collectReplyText(msgs, baseline), superseded: false }
  }
  let end = ordered.length
  for (let i = userIdx + 1; i < ordered.length; i++) {
    if (ordered[i].type === "user") {
      end = i
      break
    }
  }
  const boundary = ordered.slice(userIdx + 1, end)
  let text = ""
  for (let i = boundary.length - 1; i >= 0; i--) {
    const m = boundary[i]
    if (m.type !== "assistant") continue
    const joined = (m.content ?? [])
      .filter((p) => p.type === "text" && p.text?.trim())
      .map((p) => p.text ?? "")
      .join("\n")
      .trim()
    if (joined) {
      text = joined
      break
    }
  }
  // 防线 A 修正（2026-11-07 第二版，实测早交后钉死）：下一 user 接替判 done 必须
  // 以「本回合正文已落库」为守卫——POST /prompt 受理即建 user 行（排队消息不等
  // 前回合结束），无守卫会把「正文未生成的进行中回合」判 done，交付
  // (AI 未返回内容) 且丢失真实答案（11-07 10:16 实证）。正文在=回合实质已完，
  // 接替判据才安全；正文空则继续等 idle/正文。
  const nextTurnStarted = end < ordered.length && Boolean(text)
  // DEF-qqbot-20261107-P2（11-07 10:16/10:29 实证 ×2）：OpenCode V2 runner 对忙会话的
  // 新 /prompt 是「接管」语义——新 user 行受理即在途回合被 打断（消息链实证：assistant
  // finish=tool_calls 后无第二步，死回合）。防线 A 守卫只防早交占位符，防不了「等一个
  // 永远不会来的 idle/正文」：死回合会挂到前台 30 分钟超时，转后台还谎称任务继续执行。
  // 判定口径：边界内无正文、无 idle（回合未完），但边界外（下一条 user 行之后）已出现
  // assistant/idle 活动 → runner 已在推进后续回合，本回合死亡。正文已落库或本回合 idle
  // 已现时不适用（superseded 仅在 !text 下计算，正常终结维持原判定）。
  let superseded = false
  if (!text && end < ordered.length) {
    const lastBoundaryCreated = boundary.length
      ? (boundary[boundary.length - 1].time?.created ?? 0)
      : (ordered[userIdx].time?.created ?? 0)
    superseded = ordered
      .slice(end + 1)
      .some((m) => (m.type === "assistant" || m.type === "idle") && (m.time?.created ?? 0) > lastBoundaryCreated)
  }
  return {
    anchored: true,
    hasIdle: boundary.some((m) => m.type === "idle") || nextTurnStarted,
    text,
    superseded,
  }
}

let client: OpencodeClient | null = null

/**
 * DEF-qqbot-20261110-9 归属守卫（纯函数，导出供测试）：
 * anchored=false 的回落命中是否属于「邻回合答案」——命中的 assistant 正文若位于
 * 消息窗口中最后一条 user 行之前，则它属于更早的回合（本回合 user 尚未落库），
 * 回落不得取用它（否则该回合被假完成，内容再被 24h 去重拦截后无声消失）。
 */
export function fallbackAnswerStolen(msgs: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>, text: string): boolean {
  if (!text.trim()) return false
  let lastUserIdx = -1
  msgs.forEach((m, i) => {
    if (m.type === "user") lastUserIdx = i
  })
  if (lastUserIdx < 0) return false
  const needle = text.trim()
  const idx = msgs.findIndex(
    (m, i) =>
      m.type === "assistant" &&
      i < lastUserIdx &&
      (m.content ?? []).some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() === needle),
  )
  return idx >= 0
}

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
      const excerpt = txt.length > 200 ? `${txt.substring(0, 200)}…` : txt
      throw new Error(`OpenCode API ${res.status}: ${excerpt}`)
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
      async get(opts) {
        return json(await req(`/session/${opts.path.id}`))
      },
      async move(opts) {
        return json(await req(`/session/${opts.path.id}/move`, { method: "POST", body: JSON.stringify(opts.body) }))
      },
      async abort(opts) {
        return json(await req(`/session/${opts.path.id}/interrupt`, { method: "POST", body: "{}" }))
      },
      async messages(opts) {
        const query = new URLSearchParams()
        if (opts.query?.limit !== undefined) query.set("limit", String(opts.query.limit))
        if (opts.query?.cursor) query.set("cursor", opts.query.cursor)
        const suffix = query.size > 0 ? `?${query.toString()}` : ""
        return json(await req(`/session/${opts.path.id}/message${suffix}`))
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
      async cancel(opts) {
        return json(await req(`/session/${opts.path.sessionID}/form/${opts.path.formID}`, { method: "DELETE" }))
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
      // v2: model/agent 会被 additionalProperties:false 静默剥离 —— 不往 body 里塞；
      // 模型/agent 由 SessionManager 走 session 级端点。
      // delivery:"steer"（SDK V2SessionPromptData.body 已实证支持）：声明前台在场，
      // 引擎审批门据此闭合（design §3.2/§4「steer 前台在场语义」）。
      const body: { text: string; files?: Array<{ uri: string; name?: string }>; delivery: "steer" } = {
        text,
        delivery: "steer",
      }
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
      const promptId = promptJson?.data?.id ?? ""
      // 修复⑧：受领即回传锚点（调用方存台账/挑选直答归属用）
      if (options?.onAccepted) options.onAccepted({ promptId, baseline })
      // LLM 入口实证：user 记录可核对每次真实 /prompt 受理，不再由 QQ 出站反推执行次数。
      console.log(`[opencode] LLM prompt 已受理 pid=${process.pid} session=${sessionId} user=${promptJson?.data?.id ?? "?"} baseline=${baseline}`)

      const deadline = Date.now() + responseTimeoutMs()
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
                options?.onPermissionConflict?.(decision)
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

        // DEF-qqbot-20261105-P1 防线 A 配套（2026-11-07）：裸 /message 默认只回
        // 50 条——长会话里占回合之后的 idle/下一 user 证据被窗口截断，回合
        // 完成却判不出 done，悬挂至 30 分钟超时（11-07 实证 6 分钟悬挂+完整
        // 消息链取证）。显式 limit=200 扩大判定窗口（与 fetchRecoveryMessages
        // 同档；极端长会话由防线 A 的「下一 user 接替」判据兜住边界）。
        const listJson = await json(await req(`/session/${sessionId}/message?limit=200`))
        const msgs: SessionMessage[] = listJson?.data ?? []
        // Completion = the idle marker of THIS turn (修复⑧ 回合边界归属)。
        // Tool-using turns emit several assistant messages (reasoning+tool) before
        // the final text one, so "first completed assistant" would return an empty
        // tool message. 共享会话下别回合的 idle/assistant 都不再计入本回合判定。
        const turn = turnStateOf(msgs, promptId, baseline)
        if (turn.hasIdle) {
          // DEF-qqbot-20261110-9（2026-11-10 回归实证）：anchored=false 回落命中时
          // 必须校验答案归属——若命中正文属于「最后一条 user 行之前」的更早回合
          //（本回合 user 尚未落库、回落把邻回合答案亮出来），不得张冠李戴，
          // 继续等本回合落库；否则该回合会被邻回合答案"假完成"并在去重拦截后
          // 无声消失。
          const stolen = !turn.anchored && !!turn.text && fallbackAnswerStolen(msgs, turn.text)
          // DEF-9 深挖临时桩（2026-11-10 深夜专项）：记录每次判定的证据面，
          // 定位残余「假已答零出站」路径后移除。
          console.log(
            `[pw9] hasIdle anchored=${turn.anchored} textLen=${turn.text.length} stolen=${stolen} superseded=${turn.superseded} msgCount=${msgs.length} lastUser=${(() => {
              let idx = -1
              msgs.forEach((m, i) => {
                if (m.type === "user") idx = i
              })
              return idx
            })()} prompt=${promptId.slice(0, 8)}`,
          )
          if (!turn.anchored && turn.text && stolen) {
            console.log(`[opencode] 回落答案归属邻回合，弃用继续等 prompt=${promptId}`)
          } else {
            return turn.text || "(AI 未返回内容)"
          }
        }
        if (turn.superseded) {
          console.log(`[pw9] superseded throw prompt=${promptId.slice(0, 8)}`)
          throw new SupersededError(sessionId)
        }
      }
      console.log(`[pw9] deadline exit prompt=${promptId.slice(0, 8)}`)
      throw new Error(`AI 响应超时（${turnTimeoutMinutes()} 分钟）`)
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
