// @input:  ./client (SessionMessage), ./history (redactSecrets)
// @output: buildDigest
// @pos:    opencode层 - 摘要镜像（桌面轮次完成 → QQ 摘要卡）
//
// GET /session/{id}/message 实测倒序（新→旧）：最后一条 user 消息至末尾 = 最近一轮。
// 无 assistant 正文的轮次（纯工具/中断）返回 null 不镜像，避免噪音（E1 债务清单）。

import type { SessionMessage } from "./client.js"
import { redactSecrets } from "./history.js"

const USER_CLIP = 160
const ANSWER_CLIP = 600

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

  const answerParts: string[] = []
  for (let i = lastUserIdx + 1; i < ordered.length; i++) {
    const m = ordered[i]
    if (m.type === "assistant") {
      for (const p of m.content ?? []) {
        if (p.type === "text" && p.text?.trim()) answerParts.push(p.text.trim())
      }
    }
  }
  const answer = answerParts.join("\n").trim()
  if (!answer) return null

  const lines = ["📋 桌面问答摘要"]
  if (userText) lines.push(`🧑 ${clip(userText, USER_CLIP)}`)
  lines.push(`🤖 ${clip(answer, ANSWER_CLIP)}`)
  if (answer.length > ANSWER_CLIP) lines.push(`（答案共 ${answer.length} 字，回 /history 看更多）`)
  return redactSecrets(lines.join("\n"))
}

function clip(value: string, max: number): string {
  const s = value.replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
