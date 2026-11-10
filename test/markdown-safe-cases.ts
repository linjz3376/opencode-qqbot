// QQ markdown 安全层用例（2026-11-10，用户摘要卡截图实证）：标签与块级语法隔离、
// 围栏配对兜底、分条器 ~~~ 支持与闭栏并入。对应缺陷：摘要卡 `🤖 ``` ` 让开围栏
// 不顶格 → 结尾闭栏被当成开栏 → QQ 渲染空代码卡 + 正文外泄。
import {
  balanceFences,
  labelBlock,
  matchFence,
  startsWithBlockSyntax,
} from "../src/core/markdown.ts"
import { buildDigest } from "../src/opencode/mirror.ts"
import { renderHistory } from "../src/opencode/history.ts"
import { formatForQQMarkdown, splitMessage } from "../src/qq/sender.ts"
import type { SessionMessage } from "../src/opencode/client.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])
const mk = (arr: any[]): SessionMessage[] => arr as SessionMessage[]
const countOf = (s: string, token: string) => s.split(token).length - 1
const balanced = (s: string, token: string) => countOf(s, token) % 2 === 0

// —— 1) 标签与块级语法隔离 ——
check("普通段落保持内联", labelBlock("🤖", "答案是 42。") === "🤖 答案是 42。")
check("反引号围栏标签独占一行", labelBlock("🤖", "```\nqq-approve-live-9\n```") === "🤖\n```\nqq-approve-live-9\n```")
check("波浪围栏同样独占一行", labelBlock("🤖", "~~~ts\nconst a = 1\n~~~") === "🤖\n~~~ts\nconst a = 1\n~~~")
check("标题独占一行", labelBlock("🤖", "### 结论") === "🤖\n### 结论")
check("无序列表独占一行", labelBlock("🤖", "- 甲\n- 乙") === "🤖\n- 甲\n- 乙")
check("有序列表独占一行", labelBlock("🤖", "1. 甲\n2. 乙") === "🤖\n1. 甲\n2. 乙")
check("引用独占一行", labelBlock("🤖", "> 注意") === "🤖\n> 注意")
check("表格独占一行", labelBlock("🤖", "| a | b |\n|---|---|") === "🤖\n| a | b |\n|---|---|")
check("分隔线独占一行", labelBlock("🤖", "---") === "🤖\n---")
check("缩进代码块独占一行", labelBlock("🤖", "    indented code") === "🤖\n    indented code")
check("空正文只回标签", labelBlock("🤖", "   ") === "🤖")
check("只看首个非空行（正文含围栏不算块级开头）", !startsWithBlockSyntax("说明\n```\ncode\n```"))
check("块级判定忽略前导空行", startsWithBlockSyntax("\n\n```\nx\n```"))
check("行内反引号不算围栏", !startsWithBlockSyntax("用 `ls` 看看"))

// —— 2) 围栏配对兜底 ——
const unclosed = "说明\n```\ncode"
check("未闭合围栏补齐", balanceFences(unclosed) === "说明\n```\ncode\n```", JSON.stringify(balanceFences(unclosed)))
check("已配对逐字返回", balanceFences("```\ncode\n```") === "```\ncode\n```")
check("补齐幂等", balanceFences(balanceFences(unclosed)) === balanceFences(unclosed))
check("结尾换行不补空行", balanceFences("```\ncode\n") === "```\ncode\n```")
check("波浪围栏用同字符闭合", balanceFences("~~~js\nx") === "~~~js\nx\n~~~")
check(
  "4 反引号围栏不被 3 反引号误闭合",
  balanceFences("````\na\n```\nb") === "````\na\n```\nb\n````",
  JSON.stringify(balanceFences("````\na\n```\nb")),
)
check(
  "代码块内的波浪线不算闭合（字符不同）",
  balanceFences("```\n~~~\ncode") === "```\n~~~\ncode\n```",
  JSON.stringify(balanceFences("```\n~~~\ncode")),
)
check("matchFence 识别缩进围栏", matchFence("   ```ts")?.info === "ts")
check("matchFence 拒绝行内围栏", matchFence("前缀 ```ts") === null)

// —— 3) 摘要卡：正是本次截图那一轮 ——
const digest = buildDigest(mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: "```\nqq-approve-live-9\n```" }] },
  { id: "u2", type: "user", text: "执行 echo qq-approve-live-9" },
]))!
check("摘要不含「🤖 ```」同行前缀", !digest.split("\n").some((l) => l.startsWith("🤖 ```")), digest)
check("摘要标签独占一行", digest.includes("🤖\n```"), JSON.stringify(digest))
check("摘要围栏开闭平衡", balanced(digest, "```"), digest)
check("摘要代码内容完整保留", digest.includes("qq-approve-live-9"))
const dProse = buildDigest(mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: "答案是 42。" }] },
  { id: "u2", type: "user", text: "问" },
]))!
check("摘要普通段落仍内联", dProse.includes("🤖 答案是 42。"), dProse)

// —— 4) /history：同类标签 + 截断切断围栏的兜底 ——
const hist = renderHistory(mk([
  { id: "a1", type: "assistant", content: [{ type: "text", text: "```bash\necho hi\n```" }] },
  { id: "u1", type: "user", text: "```\n用户贴的代码\n```" },
]), 3)!
check("历史 AI 标签不与围栏同行", !hist.split("\n").some((l) => l.startsWith("🤖 ```")), hist)
check("历史用户标签不与围栏同行", !hist.split("\n").some((l) => l.startsWith("🧑 ```")), hist)
process.env.QQ_HISTORY_TEXT_CLIP = "12"
const cut = renderHistory(mk([
  { id: "a1", type: "assistant", content: [{ type: "text", text: "```\n" + "代码行很长".repeat(20) + "\n```" }] },
  { id: "u1", type: "user", text: "q" },
]), 3)!
delete process.env.QQ_HISTORY_TEXT_CLIP
check("截断可切断围栏（前提成立）", !balanced(cut, "```"), cut.slice(-60))
check("出站兜底后围栏闭合", balanced(balanceFences(cut), "```"))
check("formatForQQMarkdown 已兜底", balanced(formatForQQMarkdown(cut), "```"))

// —— 5) 分条器：~~~ 支持 + 闭栏并入（不产生空代码块） ——
const tilde = ["前言", "~~~ts", ...Array.from({ length: 25 }, (_, i) => `const v${i} = ${i} // 填充填充`), "~~~", "后记"].join("\n")
const tParts = splitMessage(tilde, 200)
check("波浪围栏分多片", tParts.length > 1, `chunks=${tParts.length}`)
check("每片 ~~~ 开闭平衡", tParts.every((p) => balanced(p, "~~~")), tParts.map((p) => countOf(p, "~~~")).join(","))
check("开栏片保留语言 ts", tParts[0].includes("~~~ts"), tParts[0].slice(0, 30))
check("不混用反引号补栏", tParts.every((p) => !p.includes("```")))

const joined = tParts.join("")
check("原文行零丢失", tilde.split("\n").filter((l) => l.trim()).every((l) => joined.includes(l)))
const backtick = ["序", "```ts", ...Array.from({ length: 25 }, (_, i) => `const w${i} = ${i} // 填充填充`), "```", "尾"].join("\n")
const bParts = splitMessage(backtick, 200)
check("反引号分片无空代码块", bParts.every((p) => !/^```[^\n]*\n```/m.test(p)), bParts.map((p) => p.slice(0, 20)).join(" | "))
check("反引号每片开闭平衡", bParts.every((p) => balanced(p, "```")), bParts.map((p) => countOf(p, "```")).join(","))

// —— 汇总 ——
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else {
    fails++
    console.log(`FAIL  ${name}  ${detail}`)
  }
}
console.log(`\nmarkdown-safe-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
