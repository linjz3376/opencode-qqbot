// @input:  ../opencode/client (FormInfo/FormField/FormOption), ../qq/types (MessageContext), ./form-journal
// @output: renderFormPrompt, parseFormAnswer, createFormBridge, FORM_PROMPT_TTL_MS
// @pos:    core - 表单桥接：QQ 同步、作答回传、跨重启恢复与服务端对账。
//
// MVP 边界：单交互字段完整支持（选择/多选/布尔/自由文本）；多字段表单提示回桌面。
// 所有服务端成功状态才允许清槽；点击 ACK、submitting 与取消失败均同步落盘，重启后可续交。
import type { FormInfo, OpencodeClient } from "../opencode/client.js"
import type { MessageContext } from "../qq/types.js"
import type { InlineKeyboard, KeyboardButton } from "../qq/api.js"
import { redactSecrets } from "../opencode/history.js"
import {
  createFormJournal,
  minimalFormContext,
  type FormJournal,
  type FormJournalEntry,
  type FormLifecycleState,
} from "./form-journal.js"

export const FORM_PROMPT_TTL_MS = 30 * 60 * 1000
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const BUTTON_LABEL_MAX = 10
const BUTTONS_PER_ROW = 2
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000

// 宽松字段视图：V2 字段类型可能扩展（external 等），运行时用宽类型读取可选属性，
// 未知类型走自由文本兜底而不是报错。
interface FieldLike {
  key: string
  type: string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  options?: Array<{ value: string; label: string; description?: string }>
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

// 找第一个可交互字段（MVP：单字段表单完整支持）
export function primaryField(form: FormInfo): FieldLike | undefined {
  return form.fields.find((f) => !(f as FieldLike).hidden)
}

/** 渲染表单为 QQ 文本（选项字母化 A/B/C/D；多选提示逗号分隔）。 */
export function renderFormPrompt(form: FormInfo): string {
  const field = primaryField(form)
  const lines = [`📝 需要你的选择：${redactSecrets(form.title)}`]
  if (!field) {
    lines.push("（空表单，请回桌面处理）")
    return lines.join("\n")
  }
  const visible = form.fields.filter((f) => !(f as FieldLike).hidden)
  if (visible.length > 1) {
    lines.push("（该表单含多个输入项，请在桌面端完成）")
    return lines.join("\n")
  }
  if (field.title) lines.push(redactSecrets(field.title))
  if (field.description) lines.push(redactSecrets(field.description))
  if ((field.type === "multiselect" || field.type === "string") && field.options?.length) {
    field.options.slice(0, LETTERS.length).forEach((opt, i) => {
      lines.push(`${LETTERS[i]}) ${redactSecrets(opt.label)}`)
    })
    lines.push(field.type === "multiselect" ? '回复字母（多选用逗号，如 "A,C"）' : "回复字母/序号或选项文字")
  } else if (field.type === "boolean") {
    lines.push("回复 是 / 否")
  } else {
    lines.push("请直接回复内容")
  }
  lines.push("（30 分钟未答自动取消）")
  return lines.join("\n")
}

function tokenToOption(token: string, field: FieldLike): string | undefined {
  const t = token.trim()
  if (!t) return undefined
  const opts = field.options ?? []
  const letterIdx = LETTERS.indexOf(t.toUpperCase())
  if (letterIdx >= 0 && letterIdx < opts.length) return opts[letterIdx].value
  const num = Number(t)
  if (Number.isInteger(num) && num >= 1 && num <= opts.length) return opts[num - 1].value
  const hit = opts.find((o) => o.value === t || o.label === t)
  return hit?.value
}

/** 解析用户回复为 Form.Answer；无法解析返回 null（调用方发提示）。 */
export function parseFormAnswer(form: FormInfo, text: string): Record<string, unknown> | null {
  const field = primaryField(form)
  if (!field) return null
  const t = text.trim()
  if (!t) return null

  if (field.type === "boolean") {
    if (/^(是|yes|y|true|1|对)$/i.test(t)) return { [field.key]: true }
    if (/^(否|no|n|false|0|不对)$/i.test(t)) return { [field.key]: false }
    return null
  }
  if (field.type === "number" || field.type === "integer") {
    const n = Number(t)
    if (!Number.isFinite(n)) return null
    if (field.type === "integer" && !Number.isInteger(n)) return null
    if (typeof field.minimum === "number" && n < field.minimum) return null
    if (typeof field.maximum === "number" && n > field.maximum) return null
    return { [field.key]: field.type === "integer" ? Math.floor(n) : n }
  }
  if (field.type === "multiselect") {
    const tokens = t.split(/[,，、\s]+/).filter(Boolean)
    if (tokens.length === 0) return null
    const values: string[] = []
    for (const token of tokens) {
      const v = tokenToOption(token, field)
      if (v === undefined) return null
      if (!values.includes(v)) values.push(v)
    }
    if (typeof field.minItems === "number" && values.length < field.minItems) return null
    if (typeof field.maxItems === "number" && values.length > field.maxItems) return null
    return { [field.key]: values }
  }
  if (field.type === "string" && field.options?.length) {
    const v = tokenToOption(t, field)
    return v === undefined ? null : { [field.key]: v }
  }
  return { [field.key]: t }
}

export interface PendingForm extends FormJournalEntry {
  timer: ReturnType<typeof setTimeout> | null
  restored?: boolean
}

interface InternalPendingForm extends PendingForm {
  replying: boolean
  cancelling: boolean
}

// ── 表单按钮：兼容旧 t/form/f/k/v 协议，可选 i 为交互回调 id ──

export interface FormButtonData {
  t: "form"
  f: string
  k: string
  v: string
  i?: string
}

export function encodeFormButton(data: FormButtonData): string {
  return JSON.stringify(data)
}

export function decodeFormButton(raw: string | undefined): FormButtonData | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<FormButtonData> & { interactionId?: unknown }
    if (
      parsed && typeof parsed === "object" && parsed.t === "form" &&
      typeof parsed.f === "string" && typeof parsed.k === "string" && typeof parsed.v === "string"
    ) {
      const interactionId = typeof parsed.i === "string"
        ? parsed.i
        : typeof parsed.interactionId === "string" ? parsed.interactionId : undefined
      return { t: "form", f: parsed.f, k: parsed.k, v: parsed.v, ...(interactionId ? { i: interactionId } : {}) }
    }
  } catch {
    // fall through
  }
  return undefined
}

function clipButtonLabel(text: string): string {
  const s = text.trim()
  return s.length > BUTTON_LABEL_MAX ? s.slice(0, BUTTON_LABEL_MAX - 1) + "…" : s
}

/** 单选直接提交字符串；多选按钮与文字路径一致，提交单值数组。 */
export function buildFormKeyboard(form: FormInfo, _ownerOpenid: string): InlineKeyboard | null {
  const visible = form.fields.filter((f) => !(f as FieldLike).hidden)
  if (visible.length !== 1) return null
  const field = visible[0] as FieldLike
  const opts = field.options
  if (!opts?.length) return null
  if (field.type !== "string" && field.type !== "multiselect") return null
  const buttons: KeyboardButton[] = opts.slice(0, 20).map((opt) => ({
    id: `form-${form.id}-${opt.value}`.slice(0, 64),
    render_data: { label: clipButtonLabel(opt.label), visited_label: clipButtonLabel(`✓ ${opt.label}`), style: 1 },
    // permission 形状对齐腾讯 P0（{type:2} 不带 specify_user_ids，同审批卡；
    // 平台校验收敛后冲突形状会导致客户端不渲染键盘）。
    action: {
      type: 1,
      permission: { type: 2 },
      data: encodeFormButton({ t: "form", f: form.id, k: field.key, v: opt.value }),
    },
  }))
  const rows: Array<{ buttons: KeyboardButton[] }> = []
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push({ buttons: buttons.slice(i, i + BUTTONS_PER_ROW) })
  }
  return { content: { rows } }
}

export interface FormInteractionEvent {
  id?: string
  user_openid?: string
  group_openid?: string
  group_member_openid?: string
  data?: { resolved?: { button_id?: string; button_data?: string } }
}

export interface FormBridgeDeps {
  client: OpencodeClient
  sendReply: (ctx: MessageContext, text: string) => Promise<void>
  safeDeliver: (ctx: MessageContext, text: string) => Promise<boolean>
  sendFormCard?: (ctx: MessageContext, form: FormInfo, keyboard: InlineKeyboard) => Promise<boolean>
  /** 测试/嵌入方可显式指定台账；生产默认 ~/.openqq/forms.json 或 QQ_FORM_JOURNAL_FILE。 */
  journalPath?: string
  journal?: FormJournal
  /** 以下时钟/TTL 参数供可控测试使用，生产无需传入。 */
  now?: () => number
  ttlMs?: number
}

export interface FormBridge {
  pushForm: (userId: string, ctx: MessageContext, form: FormInfo) => void
  tryResolveText: (userId: string, text: string) => boolean
  handleButton: (event: FormInteractionEvent) => boolean
  hasPending: (userId: string) => boolean
  getPending: (userId: string) => PendingForm | undefined
  /** 仅读本地磁盘，不访问网络；返回恢复记录涉及的 sessionID（含当前映射之外的会话）。 */
  restore: () => string[]
  /** 查询指定会话；列表失败 fail-closed 保留本地，成功才清理或续交。 */
  reconcile: (sessionID: string) => Promise<boolean>
  /** 等待所有已跟踪 reply/cancel/通知完成；超时返回 false。 */
  drainInteractions: (timeoutMs?: number) => Promise<boolean>
  /** 停止接受新交互并清 TTL 定时器；在途 Promise 仍可由 drainInteractions 等待。 */
  stopAccepting: () => void
}

export function createFormBridge(deps: FormBridgeDeps): FormBridge {
  const pending = new Map<string, InternalPendingForm>()
  const journal = deps.journal ?? createFormJournal(deps.journalPath)
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? FORM_PROMPT_TTL_MS
  const operations = new Set<Promise<unknown>>()
  let accepting = true

  function track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => operations.delete(tracked))
    operations.add(tracked)
    return tracked
  }

  function deliver(ctx: MessageContext, text: string): Promise<boolean> {
    return track(deps.safeDeliver(ctx, text).catch((error) => {
      console.error("[form-bridge] 回执投递失败:", error instanceof Error ? error.message : error)
      return false
    }))
  }

  function journalSnapshot(entry: InternalPendingForm): FormJournalEntry {
    return {
      form: entry.form,
      ctx: minimalFormContext(entry.ctx),
      userId: entry.userId,
      createdAt: entry.createdAt,
      state: entry.state,
      ...(entry.answer ? { answer: entry.answer } : {}),
      ...(entry.display !== undefined ? { display: entry.display } : {}),
      ...(entry.interactionId ? { interactionId: entry.interactionId } : {}),
      updatedAt: entry.updatedAt,
    }
  }

  function transition(entry: InternalPendingForm, state: FormLifecycleState): void {
    const previous = entry.state
    const previousUpdatedAt = entry.updatedAt
    entry.state = state
    entry.updatedAt = now()
    try {
      journal.put(journalSnapshot(entry))
    } catch (error) {
      entry.state = previous
      entry.updatedAt = previousUpdatedAt
      throw error
    }
  }

  function clearEntry(userId: string, entry: InternalPendingForm): boolean {
    if (pending.get(userId) !== entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    pending.delete(userId)
    try {
      journal.remove(userId, entry.form.id)
    } catch (error) {
      // 服务端已成功时才进入这里；残留账会由下次成功 reconcile 清理。
      console.error("[form-bridge] 清理表单台账失败:", error instanceof Error ? error.message : error)
    }
    return true
  }

  function isCurrent(userId: string, entry: InternalPendingForm): boolean {
    return pending.get(userId) === entry
  }

  function submit(userId: string, entry: InternalPendingForm, answer: Record<string, unknown>, display: string, interactionId?: string): void {
    if (!isCurrent(userId, entry) || entry.replying || entry.cancelling) return
    entry.answer = answer
    entry.display = display
    if (interactionId) entry.interactionId = interactionId
    entry.replying = true
    try {
      // 先同步落 submitting，再发起网络请求；崩溃后 reconcile 可续交同一答案。
      transition(entry, "submitting")
    } catch (error) {
      entry.replying = false
      const msg = error instanceof Error ? error.message : String(error)
      void deliver(entry.ctx, `⚠️ 无法保存提交状态，尚未向服务端作答：${msg}；请回桌面处理`)
      return
    }

    const operation = (async () => {
      try {
        await deps.client.form.reply({
          path: { sessionID: entry.form.sessionID, formID: entry.form.id },
          body: { answer },
        })
      } catch (error) {
        entry.replying = false
        const msg = error instanceof Error ? error.message : String(error)
        if (/AlreadySettled|already|OpenCode API 404/i.test(msg)) {
          // 桌面端先答/先取消是终态；只有明确的服务端冲突才清理。
          if (isCurrent(userId, entry)) clearEntry(userId, entry)
          await deliver(entry.ctx, "ℹ️ 该选择已在桌面端处理或取消，QQ 卡片已失效；若 AI 再次询问你会立即收到新卡片，也可回桌面处理")
        } else {
          // submitting + answer 保留在内存和磁盘，可手动重试或由 reconcile 续交。
          await deliver(entry.ctx, `⚠️ 提交失败，选择已保留、可在重启后续交：${msg.length > 120 ? `${msg.slice(0, 120)}…` : msg}`)
        }
        return
      }

      entry.replying = false
      if (isCurrent(userId, entry)) {
        try {
          transition(entry, "replied")
        } catch (error) {
          console.error("[form-bridge] replied 状态落盘失败:", error instanceof Error ? error.message : error)
        }
        clearEntry(userId, entry)
      }
      console.log(`[form-bridge] 表单已作答 user=${userId.slice(0, 8)}… form=${entry.form.id} answer=${display}`)
    })().catch((error) => {
      entry.replying = false
      console.error("[form-bridge] 提交流程异常:", error instanceof Error ? error.message : error)
    })
    void track(operation)
  }

  async function expireEntry(userId: string, entry: InternalPendingForm): Promise<void> {
    if (!isCurrent(userId, entry) || entry.replying || entry.cancelling || entry.state === "expired" && entry.cancelling) return
    entry.cancelling = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    try {
      transition(entry, "expired")
    } catch (error) {
      entry.cancelling = false
      await deliver(entry.ctx, `⚠️ 选择已到期，但取消状态无法落盘；请回桌面处理：${error instanceof Error ? error.message : error}`)
      return
    }
    try {
      await deps.client.form.cancel({ path: { sessionID: entry.form.sessionID, formID: entry.form.id } })
    } catch (error) {
      entry.cancelling = false
      const msg = error instanceof Error ? error.message : String(error)
      await deliver(entry.ctx, `⚠️ 选择请求已到期，但服务端取消失败（${msg.length > 120 ? `${msg.slice(0, 120)}…` : msg}）；本地已保留恢复记录，请回桌面确认`)
      return
    }
    entry.cancelling = false
    if (isCurrent(userId, entry)) {
      try {
        transition(entry, "cancelled")
      } catch (error) {
        console.error("[form-bridge] cancelled 状态落盘失败:", error instanceof Error ? error.message : error)
      }
      clearEntry(userId, entry)
    }
    await deliver(entry.ctx, "⏰ 选择请求已满 30 分钟未作答，服务端已确认取消；若 AI 再次询问你会立即收到新卡片，也可回桌面处理")
  }

  function scheduleExpiry(userId: string, entry: InternalPendingForm): void {
    if (!accepting) return
    const remaining = Math.max(0, entry.createdAt + ttlMs - now())
    entry.timer = setTimeout(() => {
      void track(expireEntry(userId, entry))
    }, remaining)
    entry.timer.unref?.()
  }

  function restore(): string[] {
    const sessions = new Set<string>()
    for (const saved of journal.load()) {
      sessions.add(saved.form.sessionID)
      if (saved.state === "replied" || saved.state === "cancelled") {
        try { journal.remove(saved.userId, saved.form.id) } catch { /* 下次启动再清理 */ }
        continue
      }
      const entry: InternalPendingForm = {
        ...saved,
        ctx: minimalFormContext({ ...saved.ctx, userId: saved.userId }),
        timer: null,
        restored: true,
        replying: false,
        cancelling: false,
      }
      const previous = pending.get(saved.userId)
      if (previous && previous.updatedAt > entry.updatedAt) continue
      if (previous?.timer) clearTimeout(previous.timer)
      pending.set(saved.userId, entry)
      scheduleExpiry(saved.userId, entry)
      console.log(`[form-bridge] 恢复本地表单 user=${saved.userId.slice(0, 8)}… form=${saved.form.id} state=${saved.state}`)
    }
    return [...sessions]
  }

  async function reconcile(sessionID: string): Promise<boolean> {
    let forms: FormInfo[]
    try {
      forms = (await deps.client.form.list({ sessionID })).data ?? []
    } catch (error) {
      // fail-closed：列表不可信时绝不清槽，也不把未确认的服务端状态告知用户。
      console.error(`[form-bridge] 会话表单对账失败 session=${sessionID}:`, error instanceof Error ? error.message : error)
      return false
    }

    const candidates = [...pending.entries()].filter(([, entry]) => entry.form.sessionID === sessionID)
    for (const [userId, entry] of candidates) {
      if (!isCurrent(userId, entry)) continue
      const server = forms.find((form) => form.id === entry.form.id) as (FormInfo & { state?: { status?: string } | string }) | undefined
      const serverStatus = typeof server?.state === "string" ? server.state : server?.state?.status
      const serverPending = server !== undefined && (!serverStatus || serverStatus === "pending")
      if (!serverPending) {
        clearEntry(userId, entry)
        await deliver(entry.ctx, "ℹ️ 该选择已在桌面端处理或取消，QQ 卡片已失效")
        continue
      }
      if (entry.state === "expired") {
        if (!entry.cancelling) await track(expireEntry(userId, entry))
      } else if ((entry.state === "clickReceived" || entry.state === "submitting") && entry.answer && !entry.replying) {
        submit(userId, entry, entry.answer, entry.display ?? "已恢复的选择", entry.interactionId)
      }
    }
    return true
  }

  function pushForm(userId: string, ctx: MessageContext, form: FormInfo): void {
    if (!accepting) {
      void deliver(ctx, "⚠️ 表单桥正在停止，暂不接受新的 QQ 作答；请回桌面处理")
      return
    }
    if (pending.get(userId)?.form.id === form.id) return

    const liveCtx: MessageContext = { ...minimalFormContext(ctx), msgId: ctx.msgId }
    const timestamp = now()
    const entry: InternalPendingForm = {
      form,
      ctx: liveCtx,
      userId,
      createdAt: timestamp,
      state: "pending",
      updatedAt: timestamp,
      timer: null,
      replying: false,
      cancelling: false,
    }
    try {
      // 推送前先持久化：发送崩溃也至少能恢复旧按钮和服务端对账。
      journal.put(journalSnapshot(entry))
    } catch (error) {
      console.error("[form-bridge] 表单落盘失败，取消 QQ 推送:", error instanceof Error ? error.message : error)
      void deliver(ctx, "⚠️ 选择请求无法保存恢复记录，本次未推送到 QQ；请回桌面处理")
      return
    }

    const previous = pending.get(userId)
    if (previous?.timer) clearTimeout(previous.timer)
    pending.set(userId, entry)
    scheduleExpiry(userId, entry)
    if (previous) {
      // 举一反三（2026-11-05）：被取代的旧表单台账必须同步清理——否则非终态记录
      // 永久残留，每次重启都被 restore 重载（updatedAt 比较能防顶替新槽，但僵尸账
      // 无限累积），与 bgWait superseded 同罪。
      try {
        journal.remove(userId, previous.form.id)
      } catch { /* 下次替换/reconcile 再清理 */ }
      void deliver(previous.ctx, "⚠️ 有新的选择请求，上一个表单已取消在 QQ 的作答（仍可回桌面处理）")
    }
    console.log(`[form-bridge] 表单已推送 user=${userId.slice(0, 8)}… form=${form.id} title=${form.title.slice(0, 40)}`)
    const operation = (async () => {
      const keyboard = buildFormKeyboard(form, liveCtx.userId)
      if (keyboard && deps.sendFormCard) {
        const sent = await deps.sendFormCard(liveCtx, form, keyboard).catch(() => false)
        if (sent) return
      }
      await deps.sendReply(liveCtx, renderFormPrompt(form)).catch((error) => {
        console.error("[form-bridge] 表单推送失败:", error instanceof Error ? error.message : error)
      })
    })()
    void track(operation)
  }

  function tryResolveText(userId: string, text: string): boolean {
    const entry = pending.get(userId)
    if (!entry) return false
    if (!accepting) {
      void deliver(entry.ctx, "⚠️ 表单桥正在停止，本次答案未提交；请回桌面处理")
      return true
    }
    if (entry.state === "expired") {
      void deliver(entry.ctx, "⚠️ 按钮和文字答案已失效，请使用新卡或回桌面处理")
      return true
    }
    if (entry.replying || entry.cancelling) {
      void deliver(entry.ctx, "⏳ 选择正在提交或取消，请勿重复操作；稍后会给出最终回执")
      return true
    }
    const answer = parseFormAnswer(entry.form, text)
    if (!answer) {
      const field = primaryField(entry.form)
      const hint = field?.type === "multiselect"
        ? '没看懂，请按选项字母回复（多选用逗号，如 "A,C"）'
        : field?.type === "boolean" ? "请回复 是 或 否" : "没看懂，请按提示回复"
      void deps.sendReply(entry.ctx, hint).catch(() => {})
      return true
    }
    submit(userId, entry, answer, text.trim())
    return true
  }

  function eventContext(event: FormInteractionEvent, userId: string): MessageContext {
    return {
      type: event.group_member_openid ? "group" : "c2c",
      userId,
      ...(event.group_member_openid && event.group_openid ? { groupId: event.group_openid } : {}),
      msgId: "",
      content: "",
    }
  }

  function rejectButton(ctx: MessageContext): void {
    void deliver(ctx, "⚠️ 按钮已失效、已处理或不属于当前选择，请使用新卡或回桌面处理")
  }

  function handleButton(event: FormInteractionEvent): boolean {
    const userId = event.user_openid ?? event.group_member_openid
    if (!userId) return false
    const button = decodeFormButton(event.data?.resolved?.button_data)
    if (!button) return false
    const entry = pending.get(userId)
    const ctx = entry?.ctx ?? eventContext(event, userId)
    if (!accepting || !entry || entry.form.id !== button.f || entry.state === "expired") {
      console.log(`[form-bridge] 拒识过期表单按钮 user=${userId.slice(0, 8)}… form=${button.f}`)
      rejectButton(ctx)
      return true
    }
    if (entry.replying || entry.cancelling) {
      void deliver(ctx, "⏳ 该按钮已受理，正在等待服务端最终结果，请勿重复点击")
      return true
    }

    const field = entry.form.fields.find((candidate) => (candidate as FieldLike).key === button.k && !(candidate as FieldLike).hidden) as FieldLike | undefined
    const option = field?.options?.find((candidate) => candidate.value === button.v)
    if (!field || (field.type !== "string" && field.type !== "multiselect") || !option) {
      rejectButton(ctx)
      return true
    }
    const interactionId = button.i ?? event.data?.resolved?.button_id ?? event.id
    const answer: Record<string, unknown> = { [button.k]: field.type === "multiselect" ? [button.v] : button.v }

    // clickReceived 是“QQ ACK 后、reply 前”崩溃窗口的可恢复锚。
    entry.answer = answer
    entry.display = button.v
    if (interactionId) entry.interactionId = interactionId
    try {
      transition(entry, "clickReceived")
    } catch (error) {
      void deliver(ctx, `⚠️ 无法保存按钮受理状态，尚未提交：${error instanceof Error ? error.message : error}`)
      return true
    }
    submit(userId, entry, answer, button.v, interactionId)
    return true
  }

  async function drainInteractions(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (operations.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining)
      })
      const drained = Promise.allSettled([...operations]).then(() => "drained" as const)
      const result = await Promise.race([drained, timeout])
      if (timer) clearTimeout(timer)
      if (result === "timeout") return false
    }
    return true
  }

  function stopAccepting(): void {
    accepting = false
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  return {
    pushForm,
    tryResolveText,
    handleButton,
    hasPending: (userId) => pending.has(userId),
    getPending: (userId) => pending.get(userId),
    restore,
    reconcile,
    drainInteractions,
    stopAccepting,
  }
}
