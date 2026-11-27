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
export const DIGEST_TITLE_MAX_WIDTH = 20 // 10 个中文，或 20 个 ASCII 的等效显示宽度

function isWideCodePoint(cp: number): boolean {
  return cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** 会话标题按终端等效显示宽度截断：中文/全角/emoji 2 列，ASCII 1 列。 */
export function clipDigestTitle(value: string | undefined, maxWidth = DIGEST_TITLE_MAX_WIDTH): string {
  const title = (value ?? "").replace(/\s+/g, " ").trim() || "未命名会话"
  let width = 0
  let out = ""
  for (const char of title) {
    const cp = char.codePointAt(0) ?? 0
    const charWidth = /\p{Mark}/u.test(char) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)
      ? 0
      : isWideCodePoint(cp) ? 2 : 1
    if (width + charWidth > maxWidth) return `${out}...`
    out += char
    width += charWidth
  }
  return out
}

export function digestSessionLabel(sessionId: string): string {
  return sessionId.length > 10 ? `${sessionId.slice(0, 10)}…` : sessionId
}

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
// 摘要锚定用户消息 id（DEF-20261118-P6 来源身份守卫用）：与 digestTurnKey 同一
// 锚点口径——时间序最后的 user 消息。无 user 消息返回 undefined（守卫放行给既有逻辑）。
export function digestAnchorUserId(messages: SessionMessage[]): string | undefined {
  const ordered = [...messages].reverse()
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].type === "user") return ordered[i].id ?? undefined
  }
  return undefined
}

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

export interface DigestIdentity {
  sessionId: string
  title?: string
}

// 构建最近一轮问答的摘要卡；返回 null = 无可镜像正文。
export function buildDigest(
  messages: SessionMessage[],
  goalObjective?: string,
  identity?: DigestIdentity,
): string | null {
  const ordered = [...messages].reverse()

  // A 方案第三桶（owner 2026-11-23）：回合边界消息 type=synthetic = 引擎自主注入
  // （goal 续跑/自动化）——既非 QQ 派发也非桌面输入，实证 shape（11-23 goal 会话
  // 消息流）：continuation 为 synthetic 型 user 消息。此类回合标「🎯 目标续跑摘要」。
  // kickoff 轮（引擎不打标）：边界 user 文本==goal 设定原文时同标（bot 侧标记近似）。
  let lastUserIdx = -1
  let goalDriven = false
  for (let i = ordered.length - 1; i >= 0; i--) {
    const t = (ordered[i] as { type?: string }).type
    if (t === "user" || t === "synthetic") {
      lastUserIdx = i
      goalDriven = t === "synthetic"
      break
    }
  }
  if (lastUserIdx < 0) return null

  const boundaryMsg = ordered[lastUserIdx] as { text?: string; content?: Array<{ type?: string; text?: string }> }
  const userText = goalDriven
    ? ""
    : ((boundaryMsg.text ?? (boundaryMsg.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("")) ?? "").trim()
  if (!goalDriven && goalObjective && userText && userText === goalObjective.trim()) {
    goalDriven = true
  }

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

  const kind = goalDriven ? "🎯 目标续跑摘要" : "📋 桌面问答摘要"
  const lines = [
    identity
      ? `${kind} · ${clipDigestTitle(identity.title)} · ${digestSessionLabel(identity.sessionId)}`
      : kind,
  ]
  if (identity) lines.push("↩️ 引用回复仅在该会话仍为当前绑定时受理")
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
