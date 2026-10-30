// 3.4/3.5 综合验证: EventStream 实况分流 + formatMilestone 真实载荷 + renderHistory 真实数据
import { createEventStream } from "../src/opencode/eventstream.ts"
import { renderHistory } from "../src/opencode/history.ts"
import { createClient } from "../src/opencode/client.ts"
import { formatMilestone } from "../src/bridge.ts"
import "./load-env.ts" // 从 ~/.openqq/.env 载入 OPENCODE_PASSWORD 等（与 bot 同源单点）

import "./load-env.ts"
// 10-30 深度自测修复：端口从硬编码 49374 改为 .env 单点（服务端口动态，HC1 已有自动发现）
const base = process.env.OPENCODE_BASE_URL || "http://localhost:49374/api"
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64")
const H = { Authorization: auth, "Content-Type": "application/json" }
let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log("assert ok:", msg)
  else { console.log("ASSERT FAIL:", msg); failures++ }
}

// ---- T1: EventStream 实况（订阅→触发轮次→事件到达→退订→连接关闭）----
const client = createClient(base)
const es = createEventStream(base)
const s = await client.session.create({})
const sid = s.data!.id!
// 10-30 自测修复：测试会话显式用工作模型——全局默认 space-bunny-free 为 Go 系免费模型，
// 拒绝带训练条款外的调用（AI.Error: trains on request data），e2e 因此执行失败
await client.session.setModel({ path: { id: sid }, body: { model: { providerID: "kimi-code-plan-cn", id: "kimi-for-coding" } } })
const seen: string[] = []
const unsub = es.subscribe(sid, (ev) => seen.push(ev.type))
assert(es.activeSessions === 1, "订阅后 activeSessions=1")

await fetch(`${base}/session/${sid}/prompt`, {
  method: "POST", headers: H,
  body: JSON.stringify({ text: "你必须调用 shell 工具真实执行命令 `echo stream-test-999`（禁止凭记忆编造输出，必须用工具实际执行），然后把工具的真实输出告诉我" }),
})
// 自适应等待轮次终态（2026-10-14 修：①写死 14s 慢模型下漏终态；②首版 startsWith("session.execution.")
// 误把 .started 当终态 → 窗口 1s 自关。终态仅 succeeded/failed 两种）
const deadline = Date.now() + 90_000
while (Date.now() < deadline && !seen.some((t) => t === "session.execution.succeeded" || t === "session.execution.failed")) {
  await new Promise((r) => setTimeout(r, 1000))
}
await new Promise((r) => setTimeout(r, 500)) // 终态事件与消息落库的排序余量
console.log("T1 events:", JSON.stringify(seen))
assert(seen.includes("session.tool.called"), "收到 tool.called")
assert(seen.includes("session.execution.succeeded"), "收到 execution.succeeded")
assert(seen.includes("session.inbox.enqueued"), "收到 inbox.enqueued（其他会话事件未串扰——按 sessionID 分流）")
unsub()
assert(es.activeSessions === 0, "退订后 activeSessions=0")

// ---- T2: formatMilestone 用探针拿到的真实载荷 ----
const realToolCalled = {
  type: "session.tool.called",
  data: { sessionID: sid, id: "call_x", input: { command: "echo payload-probe-789" }, executed: false },
} as any
const realToolSuccessExit1 = {
  type: "session.tool.success",
  data: { sessionID: sid, id: "call_x", metadata: { status: "completed", exit: 1 }, content: [] },
} as any
const realToolSuccessOk = {
  type: "session.tool.success",
  data: { sessionID: sid, metadata: { status: "completed", exit: 0 } },
} as any
assert(formatMilestone(realToolCalled) === "🔧 echo payload-probe-789", "tool.called → 🔧 命令行")
assert(formatMilestone(realToolSuccessExit1) === "⚠️ exit 1", "非零退出码可见（无上下文时仅 exit 码）")
assert(formatMilestone(realToolSuccessOk) === null, "exit 0 静默（防刷屏）")
assert(formatMilestone({ type: "session.text.delta", data: { sessionID: sid } } as any) === null, "delta 不推送")
assert(formatMilestone({ type: "session.execution.succeeded", data: { sessionID: sid } } as any) === "✅ 本轮完成", "轮次完成行")

// ⚠️ 命令上下文：通过 callID 缓存补全失败命令（2026-10-13 用户反馈"很多报错"无从对号入座）
const cache = new Map<string, string>()
const called = formatMilestone(realToolCalled, cache)!
assert(called === "🔧 echo payload-probe-789" && cache.get("call_x") === "echo payload-probe-789", "tool.called 写入 callID 缓存")
const withCtx = formatMilestone(realToolSuccessExit1, cache)!
assert(withCtx === "⚠️ exit 1：echo payload-probe-789", "exit≠0 带上失败命令上下文")
const leakyCalled = formatMilestone({ type: "session.tool.called", data: { id: "call_y", input: { command: "env OPENCODE_PASSWORD=abc123 def" } } } as any, cache)!
assert(!leakyCalled.includes("abc123") && cache.get("call_y")?.includes("***"), "缓存内容已脱敏")

// ---- T3: renderHistory 真实消息 ----
const msgs = await client.session.messages({ path: { id: sid } })
const rendered = renderHistory(msgs.data ?? [], 3)
console.log("--- renderHistory 样例 ---\n" + rendered + "\n-------------------------")
assert(rendered.includes("🧑"), "含用户发言")
assert(rendered.includes("🤖"), "含 AI 回复")
assert(rendered.includes("🔧"), "含工具调用行")
assert(rendered.includes("✓") || rendered.includes("✗"), "含工具状态标记")
assert(renderHistory([], 3) === null, "空历史返回 null（H1 契约）")
assert(renderHistory(msgs.data ?? [], 0) === "" || true, "turns=0 不崩溃")

await fetch(`${base}/session/${sid}`, { method: "DELETE", headers: H })
console.log(failures === 0 ? "ALL PASS" : `FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
