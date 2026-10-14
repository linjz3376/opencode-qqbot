// @input:  ./api (sendC2CMessage, sendGroupMessage), ./types (MessageContext)
// @output: replyToQQ, formatForQQ, formatForQQMarkdown, splitMessage
// @pos:    qq层 - 消息发送 (Markdown格式化 + 分割 + 被动回复)
//
// QQ 机器人自定义 Markdown（msg_type=2）已对单聊/群聊全量开放，无需模板。
// QQ markdown 能完整渲染标准语法: 表格、行内代码/代码块、加粗、标题、列表、链接、引用等。
// 因此主路径直接透传 AI 的 markdown 原文，交给 QQ 渲染；仅在发送失败时回退纯文本。
import { sendC2CMessage, sendGroupMessage, getNextMsgSeq } from "./api.js"
import type { MessageContext } from "./types.js"

const DEFAULT_MAX_LENGTH = 3000

// Markdown 主路径: QQ 原生渲染标准 markdown（含表格/代码），故基本透传，仅做首尾清理。
export function formatForQQMarkdown(text: string): string {
  return text.trim()
}

// 纯文本兜底: 去除所有 markdown 标记（当 markdown 发送失败时使用）
export function formatForQQ(text: string): string {
  const codeBlocks: string[] = []

  // 保护围栏代码块，用占位符替换；同时去掉 ```lang 语言标签
  let processed = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code.replace(/\n$/, ""))
    return `\x00CB${codeBlocks.length - 1}\x00`
  })

  // 处理表格: 转成 "表头 | 表头" 与 "值 | 值" 的纯文本，去掉分隔行 |---|---|
  processed = convertTables(processed)

  // 去除 markdown 标记
  processed = processed
    .replace(/`([^`]+)`/g, "$1")                 // `inline code` -> inline code
    .replace(/\*\*(.+?)\*\*/g, "$1")             // **bold** -> bold
    .replace(/\*(.+?)\*/g, "$1")                 // *italic* -> italic
    .replace(/__(.+?)__/g, "$1")                 // __underline__ -> underline
    .replace(/~~(.+?)~~/g, "$1")                 // ~~strike~~ -> strike
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")  // [text](url) -> text (url)
    .replace(/^#{1,6}\s+/gm, "")                 // ### heading -> heading
    .replace(/^>\s?/gm, "")                      // > quote -> quote
    .replace(/^\s*[-*+]\s+/gm, "• ")             // - item -> • item
    .replace(/^---$/gm, "----------")            // --- -> ----------

  // 还原代码块
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CB${i}\x00`, codeBlocks[i])
  }

  return processed.trim()
}

// 把 markdown 表格转成 QQ 可读的纯文本（列用 " | " 连接，丢弃 |---| 分隔行）
function convertTables(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    // 表格行: 以 | 开头结尾，且含分隔符
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
        rows.push(cells)
        i++
      }
      // 丢弃分隔行（形如 |---|:---:|）
      const realRows = rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)))
      for (const r of realRows) {
        out.push(r.join(" | "))
      }
      out.push("") // 表格后空一行
      continue
    }
    out.push(line)
    i++
  }

  return out.join("\n")
}

// QQ markdown 消息 content 上限约 2000 字节（中文=3字节/字），留余量取 1800 字节。
// 注意：必须按 UTF-8 字节切分，不能按字符数——否则中文长消息会超限被 QQ 丢弃（不渲染）。
const MARKDOWN_MAX_BYTES = 1800
const PLAIN_MAX_BYTES = 1900
const encoder = new TextEncoder()

function utf8Bytes(s: string): number {
  return encoder.encode(s).length
}

// 按 UTF-8 字节边界分割长消息：每片 ≤ maxBytes 字节，且不在多字节字符/代理对中间切断。
// 优先在段落(\n\n)、其次换行(\n)处断开，最后才硬切。
export function splitMessage(text: string, maxBytes: number = MARKDOWN_MAX_BYTES): string[] {
  if (utf8Bytes(text) <= maxBytes) return [text]

  const chunks: string[] = []
  const total = text.length
  let start = 0

  while (start < total) {
    if (utf8Bytes(text.slice(start)) <= maxBytes) {
      chunks.push(text.slice(start))
      break
    }

    // 从 start 开始按码点累加字节，找到不超过 maxBytes 的最大边界
    let bytes = 0
    let i = start
    let lastParaBreak = -1 // \n\n 之后的位置
    let lastLineBreak = -1 // 单个 \n 之后的位置
    let hardCut = -1       // 字节上限处（码点边界）

    while (i < total) {
      const cp = text.codePointAt(i)!
      const cpStr = String.fromCodePoint(cp)
      const cpBytes = utf8Bytes(cpStr)
      if (bytes + cpBytes > maxBytes) break
      bytes += cpBytes
      i += cpStr.length
      hardCut = i
      if (cp === 0x0a) {
        // i-1 是当前 \n；i-2 是它前一个字符，若也是 \n 则构成段落分隔
        if (i - 2 >= start && text[i - 2] === "\n") {
          lastParaBreak = i
        } else {
          lastLineBreak = i
        }
      }
    }

    let splitAt = lastParaBreak > start ? lastParaBreak : lastLineBreak > start ? lastLineBreak : hardCut
    if (splitAt <= start) splitAt = hardCut
    if (splitAt <= start) splitAt = Math.min(start + 1, total) // 兜底，避免死循环

    const chunk = text.slice(start, splitAt)
    if (chunk.trim()) chunks.push(chunk)
    start = splitAt
  }

  return chunks
}

// 发送单个分片: 先尝试 markdown，失败则回退纯文本。
async function sendChunk(
  accessToken: string,
  ctx: MessageContext,
  mdText: string,
  plainText: string,
  msgSeq: number,
): Promise<void> {
  const isGroup = ctx.type === "group" && ctx.groupId

  try {
    if (isGroup) {
      await sendGroupMessage(accessToken, ctx.groupId!, mdText, ctx.msgId, msgSeq, true)
    } else {
      await sendC2CMessage(accessToken, ctx.userId, mdText, ctx.msgId, msgSeq, true)
    }
    return
  } catch (error) {
    // markdown 发送失败（如语法不被接受/内容违规）-> 回退纯文本
    console.error("[qq-sender] markdown 发送失败，回退纯文本:", error)
  }

  if (isGroup) {
    await sendGroupMessage(accessToken, ctx.groupId!, plainText, ctx.msgId, msgSeq, false)
  } else {
    await sendC2CMessage(accessToken, ctx.userId, plainText, ctx.msgId, msgSeq, false)
  }
}

export async function replyToQQ(
  accessToken: string,
  ctx: MessageContext,
  text: string,
  _maxLength: number = DEFAULT_MAX_LENGTH,
): Promise<void> {
  const mdFormatted = formatForQQMarkdown(text)
  const plainFormatted = formatForQQ(text)

  // 关键：按 UTF-8 字节切分（QQ markdown 上限约 2000 字节），不能用字符数 maxLength，
  // 否则中文长消息会超限被 QQ 静默丢弃（看似"答非所问"，实则是答案没发出去）。
  const mdChunks = splitMessage(mdFormatted, MARKDOWN_MAX_BYTES)
  const plainChunks = splitMessage(plainFormatted, PLAIN_MAX_BYTES)

  for (let i = 0; i < mdChunks.length; i++) {
    const msgSeq = getNextMsgSeq(ctx.msgId)
    // 纯文本分片可能与 markdown 分片数量不一致，按索引兜底取对应/最后一片
    const plainChunk = plainChunks[i] ?? plainChunks[plainChunks.length - 1] ?? mdChunks[i]
    await sendChunk(accessToken, ctx, mdChunks[i], plainChunk, msgSeq)
  }
}
