// 里程碑过滤回归（2026-10-14 用户反馈：文件类工具裸路径推送无意义 → 静默）
// formatMilestone：仅动作类（shell 命令）tool.called 推送；文件类 null 但缓存仍写。
import { formatMilestone } from "../src/bridge.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const ev = (type: string, data: Record<string, any>) => ({ type, data }) as any
const calls = new Map<string, string>()

// 1. shell 命令 → 推送（保留的动作类）
const shellLine = formatMilestone(ev("session.tool.called", { id: "t1", input: { command: "bun run test.ts" } }), calls)
check("shell 命令推送", shellLine?.startsWith("🔧 ") === true && shellLine.includes("bun run test.ts"), shellLine ?? "null")

// 2. 文件路径类 → 静默（截图投诉的那批）
const readLine = formatMilestone(ev("session.tool.called", { id: "t2", input: { filePath: "C:\\x\\bridge.ts" } }), calls)
const editLine = formatMilestone(ev("session.tool.called", { id: "t3", input: { filePath: "C:\\x\\commands.ts", oldString: "a" } }), calls)
const grepLine = formatMilestone(ev("session.tool.called", { id: "t4", input: { pattern: "foo", path: "src" } }), calls)
check("read(filePath) 静默", readLine === null, String(readLine))
check("edit(filePath) 静默", editLine === null, String(editLine))
check("grep(pattern) 静默", grepLine === null, String(grepLine))

// 3. 静默但缓存仍写（裸摘要、无 🔧 前缀——原有设计，⚠️ 行自带前缀）
check("静默仍写缓存", calls.get("t2") === "C:\\x\\bridge.ts", calls.get("t2") ?? "undefined")

// 4. tool.success：exit 0 静默；exit≠0 带缓存上下文
check("exit 0 静默", formatMilestone(ev("session.tool.success", { id: "t1", metadata: { exit: 0 } }), calls) === null)
const warn = formatMilestone(ev("session.tool.success", { id: "t1", metadata: { exit: 2 } }), calls)
check("exit≠0 告警带命令", warn?.startsWith("⚠️ exit 2：") === true && warn.includes("bun run"), warn ?? "null")

// 5. 轮次收尾行保留
check("完成行保留", formatMilestone(ev("session.execution.succeeded", {})) === "✅ 本轮完成")
check("失败行保留", formatMilestone(ev("session.execution.failed", {})) === "❌ 执行失败")

// 6. input 为字符串（命令串形态）→ 推送
const strLine = formatMilestone(ev("session.tool.called", { id: "t5", input: "echo hi" }), calls)
check("字符串 input 推送", strLine === "🔧 echo hi", String(strLine))

// 7. 命令含密钥 → 脱敏仍生效
const sec = formatMilestone(ev("session.tool.called", { id: "t6", input: { command: "set PASSWORD=hunter2secret && x" } }), calls)
check("命令脱敏", (sec?.includes("***") ?? false) && !sec!.includes("hunter2secret"), sec ?? "null")

const fails = results.filter(([, ok]) => !ok)
for (const [n, ok, d] of results) console.log(`${ok ? "ok  " : "FAIL"} ${n}${d ? " — " + d : ""}`)
console.log(fails.length === 0 ? "milestone-filter: ALL PASS" : `milestone-filter: ${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
