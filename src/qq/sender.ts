// @input:  ./api (sendC2CMessage, sendGroupMessage), ./types (MessageContext)
// @output: replyToQQ, formatForQQ, formatForQQMarkdown, splitMessage
// @pos:    qq层 - 消息发送 (Markdown格式化 + 分割 + 被动回复)
//
// QQ 机器人自定义 Markdown（msg_type=2）已对单聊/群聊全量开放，无需模板。
// QQ markdown 能完整渲染标准语法: 表格、行内代码/代码块、加粗、标题、列表、链接、引用等。
// 因此主路径直接透传 AI 的 markdown 原文，交给 QQ 渲染；仅在发送失败时回退纯文本。
import {
  sendC2CMessage,
  sendGroupMessage,
  getNextMsgSeq,
  type MessageResponse,
  type SentMessageReceipt,
} from "./api.js"
import type { MessageContext } from "./types.js"
import { normalizeOutboundMarkdown, matchFence, type FenceToken } from "../core/markdown.js"
import { stripInteractionTags } from "../core/notices.js"
import { stripScaffolding } from "../core/outbound-sanitize.js"

// QQ 按 CommonMark 语义渲染：`\`+ASCII标点 被当作转义、反斜杠被吃掉
//（2026-11-20 /status 实证：C:\Users\linjz\.openqq 被渲染成 linjz.openqq——
// 路径里 `\U`、`\l` 等「反斜杠+字母」不是标点不受影响，唯独 `\.` 中招）。
// 围栏代码块与行内代码内 QQ 按字面渲染、不做转义——故仅对围栏外、行内代码外的
// 反斜杠双写（`\.` → `\\.` → QQ 渲染还原 `\.`）。
// ASCII 标点类即 CommonMark 转义目标：!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
const PUNCT_BACKSLASH = /\\(?=[!-/:-@[-`{-~])/g
const INLINE_CODE_SPLIT = /(`[^`]*`)/g

/** 单行内：行内代码段（单反引号对）原样保留，其余段做反斜杠双写。 */
function escapeLineBackslashes(line: string): string {
  return line
    .split(INLINE_CODE_SPLIT)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(PUNCT_BACKSLASH, "\\\\")))
    .join("")
}

// Markdown 主路径: QQ 原生渲染标准 markdown（含表格/代码），故基本透传，仅做首尾清理
// 与围栏归一（补未闭合 + 去空围栏对）——两者都会在 QQ 里变成空代码卡（2026-11-10 实证）。
export function formatForQQMarkdown(text: string): string {
  // Z 项（2026-11-23）：先消毒脚手架块（thinking/system-reminder 等），再走归一——
  // 顺序不可换：围栏保护在归一步，消毒须在围栏占位之前执行才刮不到代码块内。
  const sanitized = stripScaffolding(text)
  const normalized = normalizeOutboundMarkdown(sanitized.trim())
  // 围栏状态跟踪（normalizeOutboundMarkdown 已保证围栏配对，可安全切换）：
  // 围栏行与其内部内容逐字保留，不做反斜杠双写。
  let inFence = false
  return normalized
    .split("\n")
    .map((line) => {
      const f = matchFence(line)
      if (f) {
        inFence = !inFence
        return line
      }
      return inFence ? line : escapeLineBackslashes(line)
    })
    .join("\n")
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

  // 交互标签兜底剥离（2026-11-22 学习参考）：<qqbot-cmd-input> 等仅 markdown 消息生效，
  // 纯文本通道必须把标签降级为可读文本，否则尖括号原样糊给用户（AstrBot#8755 同款坑）。
  // 围栏内是代码字面量，不动。
  let inStripFence = false
  processed = processed.split("\n").map((line) => {
    const f = matchFence(line)
    if (f) {
      inStripFence = !inStripFence
      return line
    }
    return inStripFence ? line : stripInteractionTags(line)
  }).join("\n")

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

// 分条字节上限（2026-11-03 探针实证修订，替换旧"约 2000 字节"经验值——该值无官方出处且被证伪）：
// - 官方文档（bot.q.qq.com/wiki API v2，2026-10-28 版）未公布 content/markdown.content 数值上限，
//   仅错误码 40054007「消息长度超限」/40054018「消息过长或异常」证明服务端确有校验；
// - 本机探针（生产环境发真实消息）：纯文本 8 万字/24 万字节、Markdown 60232 字节（2 万字+起止标识）
//   均 HTTP 200 受理，且 2 万字 Markdown 经用户确认 QQ 客户端完整渲染；
// - 故上限统一取 2 万字实测值 60232 字节（markdown=plain=60232）；
// 分条逻辑（行边界/表格原子/围栏修补）保留，超 60232 字节仍分片。
// 注意：必须按 UTF-8 字节切分，不能按字符数——中文 3 字节/字，按字符预算会在字节维度失控。
const MARKDOWN_MAX_BYTES = 60232
const PLAIN_MAX_BYTES = 60232
const encoder = new TextEncoder()

function utf8Bytes(s: string): number {
  return encoder.encode(s).length
}

// —— 结构化分条（2026-10-29 固化）——
// 设计参考 dsh-qqbot 的 chunker：GFM 表格作为原子单元并按行边界打包。
// 本实现按项目需求独立扩展：① UTF-8 字节预算，避免中文字符数与字节数不一致；
// ② 代码块跨片时前片补闭合、后片补开围栏（带语言），使每片独立可渲染；
// ③ 超长单元按段落/换行/码点分级切分。围栏识别与出站兜底共用 core/markdown
// （2026-11-10：补 ~~~ 与 4+ 标记长度，避免波浪围栏被当正文切碎）。
// 上游来源与许可见 THIRD_PARTY_NOTICES.md。
const GFM_TABLE_LINE = /^\s*\|.*\|\s*$/

interface LineUnit {
  /** 行原文（含结尾 \n，全文末行除外） */
  text: string
  bytes: number
  /** 本行是围栏行时记录标记，否则 null */
  fence: FenceToken | null
}

function toLineUnits(text: string): LineUnit[] {
  const rawLines = text.split("\n")
  const units: LineUnit[] = []
  let tableBuf: string[] = []
  const flushTable = (isLast: boolean): void => {
    if (tableBuf.length === 0) return
    const body = tableBuf.join("\n") + (isLast ? "" : "\n")
    units.push({ text: body, bytes: utf8Bytes(body), fence: null })
    tableBuf = []
  }

  rawLines.forEach((line, idx) => {
    const isLast = idx === rawLines.length - 1
    if (GFM_TABLE_LINE.test(line)) {
      tableBuf.push(line)
      if (isLast) flushTable(true)
      return
    }
    flushTable(isLast)
    const body = line + (isLast ? "" : "\n")
    units.push({ text: body, bytes: utf8Bytes(body), fence: matchFence(line) })
  })
  return units
}

// 超大单元（巨型表格行/无换行长行）的字节级兜底切分：
// 优先段落(\n\n)、其次换行(\n)、最后码点边界硬切（不切多字节字符/代理对）。
function splitOversizeUnit(text: string, maxBytes: number): string[] {
  const chunks: string[] = []
  const total = text.length
  let start = 0

  while (start < total) {
    if (utf8Bytes(text.slice(start)) <= maxBytes) {
      chunks.push(text.slice(start))
      break
    }
    let bytes = 0
    let i = start
    let lastParaBreak = -1
    let lastLineBreak = -1
    let hardCut = -1

    while (i < total) {
      const cp = text.codePointAt(i)!
      const cpStr = String.fromCodePoint(cp)
      const cpBytes = utf8Bytes(cpStr)
      if (bytes + cpBytes > maxBytes) break
      bytes += cpBytes
      i += cpStr.length
      hardCut = i
      if (cp === 0x0a) {
        if (i - 2 >= start && text[i - 2] === "\n") lastParaBreak = i
        else lastLineBreak = i
      }
    }

    let splitAt = lastParaBreak > start ? lastParaBreak : lastLineBreak > start ? lastLineBreak : hardCut
    if (splitAt <= start) splitAt = hardCut
    if (splitAt <= start) splitAt = Math.min(start + 1, total)

    const chunk = text.slice(start, splitAt)
    if (chunk.trim()) chunks.push(chunk)
    start = splitAt
  }
  return chunks
}

export function splitMessage(text: string, maxBytes: number = MARKDOWN_MAX_BYTES): string[] {
  if (utf8Bytes(text) <= maxBytes) return [text]

  const units = toLineUnits(text)
  const chunks: string[] = []
  let cur = ""
  let curBytes = 0
  let prefix = "" // 围栏内切断时，下一片需补的开围栏（带语言）
  let open: FenceToken | null = null // 原文全局围栏状态（跨片跟踪）

  const flush = (): void => {
    const body = cur
    cur = ""
    curBytes = 0
    const f = open
    const inside = f !== null
    const closer = f ? f.ch.repeat(f.len) : ""
    const out = prefix + body + (inside ? (body.endsWith("\n") ? `${closer}\n` : `\n${closer}\n`) : "")
    prefix = f ? `${f.ch.repeat(f.len)}${f.info}\n` : ""
    if (out.trim()) chunks.push(out)
  }

  const closesOpen = (u: LineUnit): boolean =>
    open !== null &&
    u.fence !== null &&
    u.fence.ch === open.ch &&
    u.fence.len >= open.len &&
    u.fence.info === ""

  for (const u of units) {
    if (u.bytes > maxBytes) {
      // 超大单元：先封当前片，再字节级兜底切（围栏行本身不可能超大，不参与围栏语义）
      if (cur) flush()
      const parts = splitOversizeUnit(u.text, maxBytes)
      for (let k = 0; k < parts.length - 1; k++) chunks.push(parts[k])
      cur = parts[parts.length - 1] ?? ""
      curBytes = utf8Bytes(cur)
      continue
    }
    const prefixBytes = prefix ? utf8Bytes(prefix) : 0
    // 闭栏行优先并入当前片：若在它之前切断，下一片会补出「开栏紧跟闭栏」的空代码块。
    if (cur && !closesOpen(u) && curBytes + prefixBytes + u.bytes > maxBytes) {
      flush()
    }
    cur += u.text
    curBytes += u.bytes
    if (u.fence) {
      if (!open) open = u.fence
      else if (u.fence.ch === open.ch && u.fence.len >= open.len && u.fence.info === "") open = null
    }
  }
  flush()

  return chunks.length > 0 ? chunks : [text]
}

// J-轻（2026-10-30，伪流式固化）：多片错峰发送的延迟计划——片间各睡 staggerMs，
// 单片无延迟。纯函数导出供测试。
export function staggerDelays(chunkCount: number, staggerMs: number): number[] {
  if (chunkCount <= 1 || staggerMs <= 0) return []
  return Array.from({ length: chunkCount - 1 }, () => staggerMs)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 发送单个分片: 先尝试 markdown，失败则回退纯文本。返回服务端消息回执（含 id，
// 供上下文缓存登记——引用解析用）。
async function sendChunk(
  accessToken: string,
  ctx: MessageContext,
  mdText: string,
  plainText: string,
  msgSeq: number,
): Promise<MessageResponse | null> {
  const isGroup = ctx.type === "group" && ctx.groupId

  try {
    if (isGroup) {
      return await sendGroupMessage(accessToken, ctx.groupId!, mdText, ctx.msgId, msgSeq, true)
    } else {
      return await sendC2CMessage(accessToken, ctx.userId, mdText, ctx.msgId, msgSeq, true)
    }
  } catch (error) {
    // markdown 发送失败（如语法不被接受/内容违规）-> 回退纯文本
    console.error("[qq-sender] markdown 发送失败，回退纯文本:", error)
  }

  if (isGroup) {
    return await sendGroupMessage(accessToken, ctx.groupId!, plainText, ctx.msgId, msgSeq, false)
  } else {
    return await sendC2CMessage(accessToken, ctx.userId, plainText, ctx.msgId, msgSeq, false)
  }
}

export interface ReplyToQQOptions {
  /** J-轻（2026-10-30）：伪流式错峰——多片发送时片间间隔 ms（默认 0=一次性全发） */
  staggerMs?: number
  /** 每片真实发送成功立即回调；后续分片失败也不丢已发分片的锚点。 */
  onReceipt?: (receipt: SentMessageReceipt) => void | Promise<void>
  /** 第 2 片起的受控身份前缀；先预留字节、切分后再添加。 */
  continuationPrefix?: string
}

export class PartialReplyError extends Error {
  readonly name = "PartialReplyError"
  constructor(
    readonly receipts: readonly SentMessageReceipt[],
    readonly failedChunkIndex: number,
    readonly originalError: unknown,
  ) {
    super(`QQ 分片发送中断：第 ${failedChunkIndex + 1} 片失败，此前已成功 ${receipts.length} 片`)
  }
}

export interface ReplyResult {
  chunks: number
  /** 服务端回执的消息 id（兼容既有引用缓存调用方） */
  ids: string[]
  /** 每个真实分片的完整回执：refIdx 才是摘要锚点 lookup 键。 */
  receipts: SentMessageReceipt[]
}

export async function replyToQQ(
  accessToken: string,
  ctx: MessageContext,
  text: string,
  options?: ReplyToQQOptions,
): Promise<ReplyResult> {
  const mdFormatted = formatForQQMarkdown(text)
  const plainFormatted = formatForQQ(text)

  // 关键：按 UTF-8 字节切分（上限见文件头考据注释：2 万字实测），不能用字符数 maxLength，
  // 否则中文长消息会超限被 QQ 静默丢弃（看似"答非所问"，实则是答案没发出去）。
  const continuationPrefix = options?.continuationPrefix ?? ""
  const continuationBytes = utf8Bytes(continuationPrefix)
  if (continuationBytes >= Math.min(MARKDOWN_MAX_BYTES, PLAIN_MAX_BYTES) - 1024) {
    throw new Error("continuationPrefix 过长，无法为正文预留分片空间")
  }
  // 所有片都预留续片前缀字节，续片在切分后再加标记——身份绝不会被切到上一片。
  const mdChunks = splitMessage(mdFormatted, MARKDOWN_MAX_BYTES - continuationBytes)
    .map((chunk, index) => index > 0 ? continuationPrefix + chunk : chunk)
  const plainChunks = splitMessage(plainFormatted, PLAIN_MAX_BYTES - continuationBytes)
    .map((chunk, index) => index > 0 ? continuationPrefix + chunk : chunk)

  const delays = staggerDelays(mdChunks.length, options?.staggerMs ?? 0)
  const receipts: SentMessageReceipt[] = []
  for (let i = 0; i < mdChunks.length; i++) {
    if (i > 0 && delays[i - 1]) await sleep(delays[i - 1])
    const msgSeq = getNextMsgSeq(ctx.msgId)
    // 纯文本分片可能与 markdown 分片数量不一致，按索引兜底取对应/最后一片
    const plainChunk = plainChunks[i] ?? plainChunks[plainChunks.length - 1] ?? mdChunks[i]
    let res: MessageResponse | null
    try {
      res = await sendChunk(accessToken, ctx, mdChunks[i], plainChunk, msgSeq)
    } catch (error) {
      if (receipts.length > 0) throw new PartialReplyError(receipts, i, error)
      throw error
    }
    if (res?.id) {
      const receipt: SentMessageReceipt = {
        id: res.id,
        ...(res.ext_info?.ref_idx ? { refIdx: res.ext_info.ref_idx } : {}),
      }
      receipts.push(receipt)
      try {
        await options?.onReceipt?.(receipt)
      } catch (error) {
        // 已发分片的簿记错误不得中断后续发送，更不能触发上层降级重发。
        console.error("[qq-sender] 分片回执回调失败:", error)
      }
    }
  }
  return { chunks: mdChunks.length, ids: receipts.map((receipt) => receipt.id), receipts }
}
