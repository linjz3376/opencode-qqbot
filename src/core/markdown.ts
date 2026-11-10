// @input:  (纯文本工具，无依赖)
// @output: startsWithBlockSyntax, labelBlock, matchFence, balanceFences, FenceToken
// @pos:    根层/core - QQ markdown 安全层（标签↔块级语法隔离、围栏配对兜底）
//
// 背景（2026-11-10 用户截图实证）：摘要卡正文以 ``` 开头时，标签行
// `🤖 \`\`\`` 让开围栏不顶格（CommonMark 要求行首 ≤3 空格），开栏失效；而结尾
// 顶格的 ``` 反而被当成开栏 → QQ 渲染出一张空代码卡、正文外泄成普通段落。
// 同类风险还有：/history 的 🧑/🤖 标签 + 块级正文、clipBlock 截断切断围栏、
// 分条器只认 ``` 不认 ~~~。本模块把「标签拼接」与「围栏配对」收敛成两个纯函数，
// 供摘要、历史、分条与出站兜底共用。

/** 一行里识别到的围栏标记（含信息串，如 ```ts 的 ts） */
export interface FenceToken {
  /** 围栏字符：反引号或波浪线 */
  ch: "`" | "~"
  /** 连续标记长度（CommonMark 允许 ≥3，闭合须 ≥ 开启长度） */
  len: number
  /** 信息串（语言标签）；闭合围栏的信息串必须为空 */
  info: string
}

// CommonMark：围栏前最多 3 空格；反引号围栏的信息串不得含反引号。
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** 判断整行是否为围栏行；返回标记，非围栏返回 null。 */
export function matchFence(line: string): FenceToken | null {
  const m = FENCE_LINE.exec(line)
  if (!m) return null
  const run = m[1]
  const ch = run[0] as "`" | "~"
  const info = m[2].trim()
  if (ch === "`" && info.includes("`")) return null
  return { ch, len: run.length, info }
}

// 正文首个非空行落在这些块级构造上时，标签必须独占一行——否则 "🤖 " 前缀会把
// 围栏/标题/列表/引用/表格降级成普通段落（最坏情况即空代码卡 + 内容外泄）。
const BLOCK_START = [
  /^ {0,3}(`{3,}|~{3,})/, // 围栏代码块
  /^ {0,3}#{1,6}(\s|$)/, // ATX 标题
  /^ {0,3}>/, // 引用
  /^ {0,3}([-*+]|\d{1,9}[.)])\s+/, // 无序/有序列表
  /^ {0,3}\|/, // GFM 表格
  /^ {0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/, // 分隔线
  /^ {0,3}</, // HTML 块
  /^ {4,}\S/, // 缩进代码块
]

/** 正文首个非空行是否以块级语法开头（决定标签能否内联）。 */
export function startsWithBlockSyntax(text: string): boolean {
  const first = text.split("\n").find((line) => line.trim() !== "") ?? ""
  return BLOCK_START.some((re) => re.test(first))
}

/**
 * 给正文加标签（如 "🤖"）：普通段落保持 "标签 正文" 内联；块级正文让标签独占一行，
 * 保住块级语法与围栏顶格。空正文只返回标签。
 */
export function labelBlock(label: string, body: string): string {
  if (!body.trim()) return label
  return startsWithBlockSyntax(body) ? `${label}\n${body}` : `${label} ${body}`
}

/**
 * 出站兜底：补齐未闭合的围栏。QQ 渲染器把未闭合围栏吞到消息末尾并渲染成空卡片，
 * 因此在发送前把「开栏无闭栏」补成配对（内容仍是原文，只是补一个闭合标记）。
 * 已配对的文本逐字返回，幂等。
 */
export function balanceFences(text: string): string {
  let open: FenceToken | null = null
  for (const line of text.split("\n")) {
    const f = matchFence(line)
    if (!f) continue
    if (!open) {
      open = f
    } else if (f.ch === open.ch && f.len >= open.len && f.info === "") {
      open = null
    }
  }
  if (!open) return text
  const closer = open.ch.repeat(open.len)
  return text.endsWith("\n") ? `${text}${closer}` : `${text}\n${closer}`
}
