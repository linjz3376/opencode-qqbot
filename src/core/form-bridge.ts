// @input:  ../opencode/client (FormInfo/FormField/FormOption), ../qq/types (MessageContext)
// @output: renderFormPrompt, parseFormAnswer, createFormBridge, FORM_PROMPT_TTL_MS
// @pos:    core - 表单桥接（L 项 2026-10-30）：V2 Form（选择弹窗 A/B/C/D）的 QQ 同步与作答回传。
//
// 背景：昨晚"卡到今天"事故的真凶即此类弹窗（V2 Form：MCP input form/选择表单）。
// 2.1.3 即有完整 REST（GET /api/form 全局列表 / POST .../form/{id}/reply）+ SSE 事件
// （form.created/form.replied，探针实采）——纯外部 bot 可桥，无需插件无需升级。
// MVP 边界：单交互字段完整支持（选择/多选/布尔/自由文本）；多字段表单提示回桌面。
import type { FormInfo, OpencodeClient } from "../opencode/client.js"
import type { MessageContext } from "../qq/types.js"
import { redactSecrets } from "../opencode/history.js"

export const FORM_PROMPT_TTL_MS = 30 * 60 * 1000
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

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
  // 字母 A/B/C...
  const letterIdx = LETTERS.indexOf(t.toUpperCase())
  if (letterIdx >= 0 && letterIdx < opts.length) return opts[letterIdx].value
  // 1-based 序号
  const num = Number(t)
  if (Number.isInteger(num) && num >= 1 && num <= opts.length) return opts[num - 1].value
  // 精确匹配 value 或 label
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
  // string 无选项 / 未知类型 = 自由文本兜底
  return { [field.key]: t }
}

export interface PendingForm {
  form: FormInfo
  ctx: MessageContext
  timer: ReturnType<typeof setTimeout> | null
}

export interface FormBridgeDeps {
  client: OpencodeClient
  sendReply: (ctx: MessageContext, text: string) => Promise<void>
  safeDeliver: (ctx: MessageContext, text: string) => Promise<void>
}

export interface FormBridge {
  pushForm: (userId: string, ctx: MessageContext, form: FormInfo) => void
  tryResolveText: (userId: string, text: string) => boolean
  hasPending: (userId: string) => boolean
  getPending: (userId: string) => PendingForm | undefined
}

export function createFormBridge(deps: FormBridgeDeps): FormBridge {
  const pending = new Map<string, PendingForm>()

  function clear(userId: string): PendingForm | undefined {
    const entry = pending.get(userId)
    if (!entry) return undefined
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(userId)
    return entry
  }

  function pushForm(userId: string, ctx: MessageContext, form: FormInfo): void {
    // 去重：同表单已在挂起中
    if (pending.get(userId)?.form.id === form.id) return
    // 单一交互槽：新表单取代旧槽（提示旧表单失效）
    const prev = clear(userId)
    if (prev) {
      void deps.safeDeliver(ctx, "⚠️ 有新的选择请求，上一个表单已取消在 QQ 的作答（仍可回桌面处理）").catch(() => {})
    }
    const entry: PendingForm = { form, ctx, timer: null }
    entry.timer = setTimeout(() => {
      if (pending.get(userId)?.form.id !== form.id) return
      clear(userId)
      void deps.safeDeliver(ctx, "⏰ 选择请求超时（30 分钟未作答），任务可能已被取消；可回桌面重试").catch(() => {})
    }, FORM_PROMPT_TTL_MS)
    pending.set(userId, entry)
    console.log(`[form-bridge] 表单已推送 user=${userId.slice(0, 8)}… form=${form.id} title=${form.title.slice(0, 40)}`)
    void deps.sendReply(ctx, renderFormPrompt(form)).catch((error) => {
      console.error("[form-bridge] 表单推送失败:", error instanceof Error ? error.message : error)
    })
  }

  /** 有挂起表单则消费本条文本（解析成功→提交；失败→提示），返回 true；无挂起返回 false。 */
  function tryResolveText(userId: string, text: string): boolean {
    const entry = pending.get(userId)
    if (!entry) return false
    const answer = parseFormAnswer(entry.form, text)
    if (!answer) {
      const field = primaryField(entry.form)
      const hint =
        field?.type === "multiselect"
          ? '没看懂，请按选项字母回复（多选用逗号，如 "A,C"）'
          : field?.type === "boolean"
            ? "请回复 是 或 否"
            : "没看懂，请按提示回复"
      void deps.sendReply(entry.ctx, hint).catch(() => {})
      return true
    }
    const { form, ctx } = entry
    clear(userId)
    void (async () => {
      try {
        await deps.client.form.reply({ path: { sessionID: form.sessionID, formID: form.id }, body: { answer } })
        void deps.safeDeliver(ctx, `✅ 已提交选择：${text.trim()}`).catch(() => {})
        console.log(`[form-bridge] 表单已作答 user=${userId.slice(0, 8)}… form=${form.id}`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes("AlreadySettled") || msg.includes("already")) {
          void deps.safeDeliver(ctx, "该选择已在桌面端处理过，任务应已继续").catch(() => {})
        } else {
          void deps.safeDeliver(ctx, `⚠️ 提交失败：${msg.slice(0, 120)}`).catch(() => {})
        }
      }
    })()
    return true
  }

  return { pushForm, tryResolveText, hasPending: (u) => pending.has(u), getPending: (u) => pending.get(u) }
}
