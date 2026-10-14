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

const USER_CLIP = 160
const TEXT_CLIP = 400
const TOOL_CLIP = 140

// 渲染最近 turns 轮对话（每轮以 user 消息为界），返回空串表示无历史。
export function renderHistory(messages: SessionMessage[], turns: number): string {
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
  const out: string[] = []
  for (const seg of picked) {
    const lines: string[] = []
    for (const m of seg) {
      if (m.type === "user") {
        const text = (m as { text?: string }).text ?? ""
        if (text.trim()) lines.push(`🧑 ${clip(text, USER_CLIP)}`)
      } else if (m.type === "assistant") {
        for (const p of m.content ?? []) {
          if (p.type === "text" && p.text?.trim()) {
            lines.push(`🤖 ${clip(p.text, TEXT_CLIP)}`)
          } else if (p.type === "tool") {
            lines.push(`🔧 ${renderToolPart(p)}`)
          }
        }
      }
      // idle 等其余类型不渲染
    }
    if (lines.length > 0) out.push(lines.join("\n"))
  }
  return out.join("\n\n")
}

function renderToolPart(part: MessagePart): string {
  // 兼容两种形态：{tool, state:{...}} 或扁平 {status, input, metadata}
  const state = (part.state ?? part) as Record<string, any>
  const status = String(state.status ?? "?")
  const input = state.input
  const toolName = typeof part.tool === "string" ? `${part.tool} ` : ""
  const exit = state.metadata?.exit
  const exitNote = typeof exit === "number" && exit !== 0 ? ` (exit ${exit})` : ""
  const mark = status === "completed" ? "✓" : status === "failed" || status === "error" ? "✗" : status
  return `${toolName}${clip(redactSecrets(summarizeInput(input)), TOOL_CLIP)} ${mark}${exitNote}`
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
