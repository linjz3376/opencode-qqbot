// @input:  requestSchema（elicitation.create 的 requestedSchema）
// @output: QuestionItem, parseQuestionForm, renderQuestion, parseAnswer, toFormContent,
//          timeoutOutcome, TimeoutOutcome
// @pos:    core层 - 表单/提问的纯逻辑：把 elicitation 的 JSON-Schema 归一成「逐题问答」，
//          并把用户文字回复映射回表单答案。不做 IO，供 bridge 与单测共用。
//          背景（2026-11-08）：question 工具的字段是 options + custom，
//          elicitation 落地时会拆成 q0 与 q0_custom 两个属性，必须合并成一道题。

export interface QuestionOption {
  value: string
  label: string
  description?: string
}

export interface QuestionItem {
  /** 主属性名，如 q0（写回答案时用） */
  key: string
  title: string
  description?: string
  options: QuestionOption[]
  /** 多选（schema type=array，或 multiselect） */
  multiple: boolean
  /** 自定义答案属性名，如 q0_custom；无则为 undefined */
  customKey?: string
  /** 该题是否必填（schema.required 含此 key）——决定超时是「跳过」还是「中止」 */
  required: boolean
  /** 数字/布尔等自由输入类型 */
  kind: "string" | "number" | "integer" | "boolean"
}

type JsonSchema = {
  type?: string
  title?: string
  description?: string
  enum?: unknown[]
  enumNames?: unknown[]
  oneOf?: Array<{ const?: unknown; title?: unknown; description?: unknown }>
  anyOf?: Array<{ const?: unknown; title?: unknown; description?: unknown }>
  items?: JsonSchema
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function optionsOf(prop: JsonSchema): QuestionOption[] {
  const branches = asArray(prop.oneOf).length ? asArray(prop.oneOf) : asArray(prop.anyOf)
  if (branches.length) {
    return branches.map((b) => {
      const item = (b ?? {}) as { const?: unknown; title?: unknown; description?: unknown }
      const value = item.const
      return {
        value: value === undefined ? String(item.title ?? "") : String(value),
        label: String(item.title ?? value ?? ""),
        ...(typeof item.description === "string" ? { description: item.description } : {}),
      }
    })
  }
  if (asArray(prop.enum).length) {
    const names = asArray(prop.enumNames)
    return asArray(prop.enum).map((v, i) => ({
      value: String(v),
      label: String(names[i] ?? v),
    }))
  }
  return []
}

/** 把 elicitation 的 requestedSchema 归一成题目列表；无可用属性时返回 null。 */
export function parseQuestionForm(requestedSchema: unknown): QuestionItem[] | null {
  const schema = (requestedSchema ?? {}) as { properties?: Record<string, JsonSchema> }
  const props = Object.entries(schema.properties ?? {})
  if (!props.length) return null

  const customKeys = new Map<string, string>()
  for (const [key] of props) {
    if (key.endsWith("_custom")) customKeys.set(key.slice(0, -"_custom".length), key)
  }
  const requiredKeys = new Set(
    asArray((requestedSchema as { required?: unknown[] } | null | undefined)?.required).map((k) => String(k)),
  )

  const items: QuestionItem[] = []
  for (const [key, raw] of props) {
    if (key.endsWith("_custom")) continue // 作为自定义输入随主题合并
    const prop = (raw ?? {}) as JsonSchema
    const type = prop.type
    const multiple = type === "array"
    const options = optionsOf(multiple && prop.items ? prop.items : prop)
    const kind: QuestionItem["kind"] =
      type === "number" || type === "integer" || type === "boolean" ? type : "string"
    const customKey = customKeys.get(key)
    items.push({
      key,
      title: (prop.title ?? key).trim() || key,
      ...(prop.description ? { description: prop.description } : {}),
      options,
      multiple,
      ...(customKey ? { customKey } : {}),
      kind,
      required: requiredKeys.has(key),
    })
  }
  return items.length ? items : null
}

/** 渲染一道题给 QQ（纯文本）。total>1 时带进度。 */
export function renderQuestion(item: QuestionItem, index: number, total: number): string {
  const lines: string[] = []
  lines.push(total > 1 ? `📝 需要你的选择（第 ${index + 1}/${total} 题）` : "📝 需要你的选择")
  lines.push(item.title)
  if (item.description) lines.push(item.description)
  lines.push("")
  if (item.options.length) {
    item.options.forEach((o, i) => {
      const desc = o.description ? `（${o.description}）` : ""
      lines.push(`${String.fromCharCode(65 + i)}. ${o.label}${desc}`)
    })
    if (item.multiple) {
      lines.push("", "可多选：回复字母，如 AB 或 A,B；也可以直接输入自定义答案")
    } else {
      lines.push("", "回复选项字母（或序号）；也可以直接输入自定义答案")
    }
  } else if (item.kind === "boolean") {
    lines.push("回复「是」或「否」")
  } else {
    lines.push("请直接回复内容")
  }
  lines.push("回复「取消」放弃；30 分钟未答：可选题自动跳过，必填题中止")
  return lines.join("\n")
}

export type ParsedAnswer =
  | { ok: true; value: string | string[]; custom: boolean }
  | { ok: false }

/** 把用户的文字回复解析成答案；无法识别时返回 ok:false（调用方重新提问）。 */
export function parseAnswer(item: QuestionItem, content: string): ParsedAnswer {
  const text = content.trim()
  if (!text) return { ok: false }

  if (item.options.length) {
    const pick = (token: string): QuestionOption | null => {
      const t = token.trim()
      if (!t) return null
      if (/^[A-Za-z]$/.test(t)) {
        const idx = t.toUpperCase().charCodeAt(0) - 65
        return item.options[idx] ?? null
      }
      if (/^\d+$/.test(t)) {
        const idx = Number(t) - 1
        return Number.isInteger(idx) ? (item.options[idx] ?? null) : null
      }
      const lower = t.toLowerCase()
      return (
        item.options.find((o) => o.label.toLowerCase() === lower) ??
        item.options.find((o) => o.value.toLowerCase() === lower) ??
        null
      )
    }

    if (item.multiple) {
      // "AB" 这种连写字母按单字符拆开；其余按分隔符切
      const tokens = /^[A-Za-z]{2,}$/.test(text)
        ? text.split("")
        : text.split(/[\s,，、/|]+/).filter(Boolean)
      const hits: QuestionOption[] = []
      for (const token of tokens) {
        const hit = pick(token)
        if (!hit) {
          // 任一 token 不是选项 → 视为整段自定义答案
          if (item.customKey) return { ok: true, value: text, custom: true }
          return { ok: false }
        }
        if (!hits.includes(hit)) hits.push(hit)
      }
      if (!hits.length) return { ok: false }
      return { ok: true, value: hits.map((h) => h.value), custom: false }
    }

    const hit = pick(text)
    if (hit) return { ok: true, value: hit.value, custom: false }
    if (item.customKey) return { ok: true, value: text, custom: true }
    return { ok: false }
  }

  if (item.kind === "boolean") {
    if (/^(是|对|yes|y|true|1|要|确定|ok)$/i.test(text)) return { ok: true, value: "true", custom: false }
    if (/^(否|不|no|n|false|0|不要|取消选择)$/i.test(text)) return { ok: true, value: "false", custom: false }
    return { ok: false }
  }

  if (item.kind === "number" || item.kind === "integer") {
    if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false }
    return { ok: true, value: text, custom: false }
  }

  return { ok: true, value: text, custom: false }
}

/** 组装写回的 content：自定义答案同时写主属性与 custom 属性（服务端优先取 custom）。 */
export function toFormContent(answers: Array<{ item: QuestionItem; value: string | string[]; custom: boolean }>): Record<string, unknown> {
  const content: Record<string, unknown> = {}
  for (const { item, value, custom } of answers) {
    content[item.key] = value
    if (custom && item.customKey) content[item.customKey] = Array.isArray(value) ? value.join(", ") : value
  }
  return content
}

export type TimeoutOutcome =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "cancel" }

/**
 * 30 分钟未作答的归宿（2026-11-08 用户拍板：沉默 ≠ 拒绝，未答应跳过）。
 * - 存在「未答的必填题」→ cancel（此时 cancel 才是真语义：任务缺必要输入，必须中止）
 * - 否则 → accept 已收集的答案（缺的题上游会写成 Unanswered，模型按默认继续推进）
 * 与上游 question 工具对齐：cancelled 分支会回给模型 "The user dismissed this question"
 * （用户主动拒绝），绝不能拿来表示「用户没看见/没来得及答」。
 */
export function timeoutOutcome(
  questions: readonly QuestionItem[],
  answers: ReadonlyArray<{ item: QuestionItem; value: string | string[]; custom: boolean }>,
): TimeoutOutcome {
  const answeredKeys = new Set(answers.map((a) => a.item.key))
  const missingRequired = questions.some((q) => q.required && !answeredKeys.has(q.key))
  if (missingRequired) return { action: "cancel" }
  return { action: "accept", content: toFormContent([...answers]) }
}
