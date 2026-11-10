// @input:  ./client (SessionMessage), ./history (redactSecrets)
// @output: buildDigest
// @pos:    opencode层 - 摘要镜像（桌面轮次完成 → QQ 摘要卡）
//
// GET /session/{id}/message 实测倒序（新→旧）：最后一条 user 消息至末尾 = 最近一轮。
// 无 assistant 正文的轮次（纯工具/中断）返回 null 不镜像，避免噪音（E1 债务清单）。

import type { SessionMessage } from "./client.js"
import { redactSecrets } from "./history.js"
import { labelBlock } from "../core/markdown.js"

const USER_CLIP = 160

// E2（2026-10-29，用户要求"摘要回全文"）：答案截断上限改为运行时可配——
// 默认 0=不截断回全文（投递层 splitMessage 自动分条送达）；设
// QQ_DIGEST_ANSWER_MAX_CHARS>0 可恢复旧的截断模式。用户提问行（USER_CLIP）
// 保持截断不变（问题行只是定位上下文，全文意义不大）。
function answerClipLimit(): number {
  const n = Number(process.env.QQ_DIGEST_ANSWER_MAX_CHARS ?? "0")
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

// 逻辑回合并发幂等键：同一用户消息 + 最终 assistant。不同 location 的
// execution.succeeded 事件 ID 可以不同，但同一逻辑回合仍只应镜像一次。
export function digestTurnKey(messages: SessionMessage[]): string | null {
  const ordered = [...messages].reverse()
  let lastUserIdx = -1
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].type === "user") {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return null
  for (let i = ordered.length - 1; i > lastUserIdx; i--) {
    const m = ordered[i]
    if (m.type !== "assistant" || !(m.content ?? []).some((p) => p.type === "text" && p.text?.trim())) continue
    return `${ordered[lastUserIdx].id ?? `user@${lastUserIdx}`}:${m.id ?? `assistant@${i}`}`
  }
  return null
}

// 构建最近一轮问答的摘要卡；返回 null = 无可镜像正文。
export function buildDigest(messages: SessionMessage[]): string | null {
  const ordered = [...messages].reverse()

  let lastUserIdx = -1
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].type === "user") {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return null

  const userText = ((ordered[lastUserIdx] as { text?: string }).text ?? "").trim()

  let answer = ""
  for (let i = ordered.length - 1; i > lastUserIdx; i--) {
    const m = ordered[i]
    if (m.type !== "assistant") continue
    const parts = (m.content ?? []).filter((p) => p.type === "text" && p.text?.trim()).map((p) => p.text!.trim())
    if (parts.length > 0) {
      answer = parts.join("\n").trim()
      break
    }
  }
  if (!answer) return null

  const lines = ["📋 桌面问答摘要"]
  if (userText) lines.push(`🧑 ${clip(userText, USER_CLIP)}`)
  const clipLimit = answerClipLimit()
  if (clipLimit > 0) {
    lines.push(`🤖 ${clip(answer, clipLimit)}`)
    if (answer.length > clipLimit) lines.push(`（答案共 ${answer.length} 字，回 /history 看更多）`)
  } else {
    // 全文模式：保留原文换行/排版（clip 的空白折叠只用于截断模式）。
    // 标签必须走 labelBlock：正文以 ```/标题/列表等块级语法开头时独占一行，
    // 否则 "🤖 ```" 让开围栏不顶格 → QQ 渲染空代码卡 + 正文外泄（2026-11-10 截图实证）。
    lines.push(labelBlock("🤖", answer))
  }
  return redactSecrets(lines.join("\n"))
}

function clip(value: string, max: number): string {
  const s = value.replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
