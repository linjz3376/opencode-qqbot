// @input:  ./client (SessionMessage 类型)
// @output: renderHistory
// @pos:    opencode层 - 会话历史渲染（QQ 用）
//
// GET /session/{id}/message 实测结构（2026-10-13，倒序=新→旧）：
//   user:      { id, time, text, type:"user" }
//   assistant: { id, time, type, agent, model, content[], finish, cost, tokens }
//              content 部件: {type:"text",text} | {type:"tool", tool?, state:{status,input,content,metadata}}
//   idle:      { id, time, type:"idle", outcome }
import type { MessagePart, SessionMessage } from "./client.js"

// H1（2026-10-30，/history 格式化重做）：默认上限放宽——/history 的目的是"回看
// 内容"，旧 400 字/160 字无意义；保留 env 逃生门。按字符计（投递层管字节）。
const TOOL_CLIP = 140

function historyLimit(envKey: string, fallback: number): number {
  const n = Number(process.env[envKey])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// 块级截断：保留换行与 markdown 结构（旧 clip 折叠 \s+ 会把代码块/表格压成一行，
// 是 "/history 没格式化" 的核心病根），仅超长在尾部截断+提示。
function clipBlock(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（共 ${text.length} 字，已截断，回桌面看全文）`
}

interface ToolRun {
  name: string
  ok: boolean
  detail: string
}

// 工具部件 → 结构化摘要（聚合计数 + 失败详情两用）
function toolRunOf(part: MessagePart): ToolRun {
  const state = (part.state ?? part) as Record<string, any>
  const status = String(state.status ?? "?")
  const ok = status === "completed"
  const toolName = typeof part.tool === "string" && part.tool ? part.tool : "tool"
  const exit = state.metadata?.exit
  const exitNote = typeof exit === "number" && exit !== 0 ? ` (exit ${exit})` : ""
  const detail = `${toolName} ${clip(redactSecrets(summarizeInput(state.input)), TOOL_CLIP)} ${ok ? "✓" : `✗${exitNote}`}`
  return { name: toolName, ok, detail }
}

// 渲染最近 turns 轮对话（每轮以 user 消息为界）；无内容返回 null（调用方回兜底文案）。
// H1 重做：轮次头编号 + 换行保留 + 全文脱敏 + 工具行聚合（失败单列详情）。
export function renderHistory(messages: SessionMessage[], turns: number): string | null {
  // 倒序转正序，按 user 消息切轮次
  const ordered = [...messages].reverse()
  const segments: SessionMessage[][] = []
  let cur: SessionMessage[] = []
  for (const m of ordered) {
    if (m.type === "user" && cur.length > 0) {
      segments.push(cur)
      cur = []
    }
    cur.push(m)
  }
  if (cur.length > 0) segments.push(cur)

  const picked = segments.slice(-turns)
  if (picked.length === 0) return null

  const userClip = historyLimit("QQ_HISTORY_USER_CLIP", 500)
  const textClip = historyLimit("QQ_HISTORY_TEXT_CLIP", 1200)
  const TOOL_DETAIL_MAX = 3

  const total = picked.length
  const out: string[] = []
  picked.forEach((seg, idx) => {
    const lines: string[] = [`▎第 ${idx + 1} 轮（共 ${total} 轮）`]
    const toolStats = new Map<string, { ok: number; fail: number }>()
    const failDetails: string[] = []
    let failOverflow = 0

    for (const m of seg) {
      if (m.type === "user") {
        const text = (m as { text?: string }).text ?? ""
        // H1 安全修复：正文全量脱敏（旧版只脱工具行，用户/AI 正文可外泄密钥）
        if (text.trim()) lines.push(`🧑 ${clipBlock(redactSecrets(text.trim()), userClip)}`)
      } else if (m.type === "assistant") {
        for (const p of m.content ?? []) {
          if (p.type === "text" && p.text?.trim()) {
            lines.push(`🤖 ${clipBlock(redactSecrets(p.text.trim()), textClip)}`)
          } else if (p.type === "tool") {
            const t = toolRunOf(p)
            const st = toolStats.get(t.name) ?? { ok: 0, fail: 0 }
            if (t.ok) st.ok += 1
            else st.fail += 1
            toolStats.set(t.name, st)
            if (!t.ok) {
              if (failDetails.length < TOOL_DETAIL_MAX) failDetails.push(`🔧 ${t.detail}`)
              else failOverflow += 1
            }
          }
        }
      }
      // idle 等其余类型不渲染
    }

    if (toolStats.size > 0) {
      const agg = [...toolStats.entries()]
        .map(([name, s]) => `${name}×${s.ok + s.fail}${s.fail > 0 ? `（${s.fail}✗）` : "✓"}`)
        .join(" ")
      lines.push(`🔧 ${agg}`)
      for (const d of failDetails) lines.push(d)
      if (failOverflow > 0) lines.push(`🔧 …另有 ${failOverflow} 个失败工具（回桌面看详情）`)
    }

    // 跳过空轮（只有轮次头没有内容）
    if (lines.length > 1) out.push(lines.join("\n"))
  })

  return out.length > 0 ? out.join("\n\n") : null
}

// 秘钥脱敏：命令原文常含 env 赋值（如 OPENCODE_PASSWORD=xxx），
// 推送/渲染前调用，防止密码、token 随里程碑或历史外泄（2026-10-13 实测截图教训）。
const SECRET_RE =
  /((?:password|passwd|secret|token|api[_-]?key|authorization|credential)["']?\s*[=:]\s*["']?(?:bearer\s+|basic\s+|token\s+)?)([^\s"']+)/gi

export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, "$1***")
}

// 工具输入摘要：不同工具 input 字段不同，逐个降级猜测（与 bridge 里程碑共用思路）
export function summarizeInput(input: unknown): string {
  if (input == null) return "(无输入)"
  if (typeof input === "string") return input
  if (typeof input !== "object") return String(input)
  const obj = input as Record<string, unknown>
  for (const key of ["command", "filePath", "path", "url", "pattern", "query", "agent", "description"]) {
    const v = obj[key]
    if (typeof v === "string" && v.trim()) return key === "pattern" ? `搜索 ${v}` : v
  }
  return JSON.stringify(obj)
}

function clip(value: string, max: number): string {
  const s = value.replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
