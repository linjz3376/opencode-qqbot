// H1 行为断言（2026-10-30）：/history 格式化重做——换行保留/正文脱敏/工具聚合/轮次头。
import { renderHistory } from "../src/opencode/history.ts"
import type { SessionMessage } from "../src/opencode/client.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])
const mk = (arr: any[]): SessionMessage[] => arr as SessionMessage[]

// —— 1) 换行与结构保留（旧 clip 会把这些压成一行）——
const structured = mk([
  { id: "a1", type: "assistant", content: [{ type: "text", text: "说明\n```ts\nconst a = 1\nconst b = 2\n```\n\n| 列1 | 列2 |\n|---|---|\n| a | b |\n\n- 项1\n- 项2" }] },
  { id: "u1", type: "user", text: "问" },
])
const r1 = renderHistory(structured, 3)!
check("代码块多行保留", r1.includes("const a = 1\nconst b = 2"), r1.slice(0, 120))
check("表格行保留", r1.includes("| 列1 | 列2 |"), r1)
check("列表换行保留", r1.includes("- 项1\n- 项2"), r1)

// —— 2) 正文脱敏（旧版只脱工具行）——
const leaky = mk([
  { id: "a1", type: "assistant", content: [{ type: "text", text: "执行了 OPENCODE_PASSWORD=supersecret123 后的结果" }] },
  { id: "u1", type: "user", text: "我的 token=abc123456 帮我看看" },
])
const r2 = renderHistory(leaky, 3)!
check("AI 正文脱敏", r2.includes("***") && !r2.includes("supersecret123"))
check("用户正文脱敏", !r2.includes("abc123456"), r2.split("\n").find((l) => l.includes("token")) ?? "")

// —— 3) 工具聚合一行 + 失败单列详情 ——
const tools = mk([
  {
    id: "a1",
    type: "assistant",
    content: [
      { type: "text", text: "做完了" },
      { type: "tool", tool: "shell", state: { status: "completed", input: { command: "ls" } } },
      { type: "tool", tool: "shell", state: { status: "completed", input: { command: "cat x" } } },
      { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "a.ts" } } },
      { type: "tool", tool: "shell", state: { status: "failed", input: { command: "rm -rf /" }, metadata: { exit: 1 } } },
    ],
  },
  { id: "u1", type: "user", text: "干活" },
])
const r3 = renderHistory(tools, 3)!
check("聚合行 shell×3（1✗）", r3.includes("shell×3（1✗）"), r3)
check("聚合行 edit×1✓", r3.includes("edit×1✓"), r3)
check("失败详情单列且带 exit", r3.includes("🔧 shell") && r3.includes("✗ (exit 1)"), r3)
check("不再逐工具刷屏（🔧 行 ≤3）", r3.split("\n").filter((l) => l.startsWith("🔧")).length <= 3)

// —— 4) 失败详情超 3 个溢出提示 ——
const manyFails = mk([
  {
    id: "a1",
    type: "assistant",
    content: [1, 2, 3, 4, 5].map((i) => ({ type: "tool", tool: "shell", state: { status: "failed", input: { command: `cmd${i}` } } })),
  },
  { id: "u1", type: "user", text: "x" },
])
const r4 = renderHistory(manyFails, 3)!
check("失败详情溢出提示", r4.includes("另有 2 个失败工具"), r4.split("\n").filter((l) => l.startsWith("🔧")).join(" | "))

// —— 5) 截断上限生效（env 可配）——
process.env.QQ_HISTORY_TEXT_CLIP = "50"
const longText = "字".repeat(200)
const r5 = renderHistory(mk([
  { id: "a1", type: "assistant", content: [{ type: "text", text: longText }] },
  { id: "u1", type: "user", text: "q" },
]), 3)!
check("超长截断带提示行", r5.includes("已截断") && r5.includes("共 200 字"), r5.slice(40, 120))
delete process.env.QQ_HISTORY_TEXT_CLIP
const r5b = renderHistory(mk([
  { id: "a1", type: "assistant", content: [{ type: "text", text: longText }] },
  { id: "u1", type: "user", text: "q" },
]), 3)!
check("默认 1200 不截 200 字", !r5b.includes("已截断"))

// —— 6) 轮次头顺序（旧→新 1..N）——
const three = mk([
  { id: "a3", type: "assistant", content: [{ type: "text", text: "答3" }] },
  { id: "u3", type: "user", text: "问3" },
  { id: "a2", type: "assistant", content: [{ type: "text", text: "答2" }] },
  { id: "u2", type: "user", text: "问2" },
  { id: "a1", type: "assistant", content: [{ type: "text", text: "答1" }] },
  { id: "u1", type: "user", text: "问1" },
])
const r6 = renderHistory(three, 2)! // 取最近 2 轮 = 问2/问3
check("轮次头 第 1 轮在前", r6.indexOf("▎第 1 轮") < r6.indexOf("▎第 2 轮"), r6.slice(0, 40))
check("只含最近两轮", r6.includes("答2") && r6.includes("答3") && !r6.includes("答1"))

// —— 7) 空历史 → null ——
check("空历史 null", renderHistory([], 3) === null)

// —— 汇总 ——
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nhistory-render-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
