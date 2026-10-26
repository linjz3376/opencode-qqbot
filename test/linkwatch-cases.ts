// HC2 行为断言（2026-10-26）：运行中链路自愈巡检。
// 覆盖：client 真链路 rebase（死口→活口）、巡检状态机（发现成功热切换 /
// 发现失败保持 open + 告警去重 / 自然恢复 / 跨重启延续未结事故不重发 open）。
// 只在 bun 下运行（Bun.serve 假服）；incident 文件写入临时目录，不污染 ~/.openqq。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { createClient, healthCheck } from "../src/opencode/client.ts"
import { startLinkWatch } from "../src/core/linkwatch.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

// —— 假服基建 ——
const TMP = join(process.env.TEMP ?? "/tmp", "opencode", "hc2-linkwatch-test")
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

let stoppers: Array<() => void> = []
function fakeOpencode(): { base: string; port: number; stop(): void } {
  const INFO = { version: "2.1.3-test", pid: 1, urls: ["http://x"], paths: { tmp: "/tmp" } }
  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url)
      if (u.pathname === "/api/session") return new Response(JSON.stringify({ data: [] }))
      if (u.pathname === "/api/info") return new Response(JSON.stringify(INFO))
      return new Response("not found", { status: 404 })
    },
  })
  stoppers.push(() => srv.stop(true))
  return { base: `http://127.0.0.1:${srv.port}/api`, port: srv.port, stop: () => srv.stop(true) }
}
function deadBase(): string {
  const s = Bun.serve({ port: 0, fetch: () => new Response("x") })
  const p = s.port
  s.stop(true)
  return `http://127.0.0.1:${p}/api`
}

// —— 1) client 真链路 rebase ——
const good = fakeOpencode()
const bad1 = deadBase()
const oc1 = createClient(bad1)
let died = false
try {
  await healthCheck(oc1, true)
} catch {
  died = true
}
check("死口 healthCheck 失败", died)
oc1.rebase(good.base)
let ok = true
try {
  await healthCheck(oc1, true)
} catch (e) {
  ok = false
  check("", false, String(e))
}
check("rebase 后 healthCheck 通过", ok)
check("baseUrl 已随 rebase 更新", oc1.baseUrl === good.base, oc1.baseUrl)

// —— 2) 巡检：发现成功 → 热切换 + open/fixed 告警 + 事故 closed ——
const bad2 = deadBase()
const oc2 = createClient(bad2)
const rebaseCalls: string[] = []
const alarms2: string[] = []
const incA = join(TMP, "incident-a.json")
const w2 = startLinkWatch({
  client: oc2,
  onRebase: (u) => rebaseCalls.push(u),
  alarm: async (t) => alarms2.push(t),
  intervalMin: 60, // 循环定时器不触发，全靠 runOnce 手动驱动
  discover: async () => ({ baseUrl: good.base, port: good.port, version: "2.1.3-test" }),
  incidentFile: incA,
})
await w2.runOnce()
check("发现成功：rebase 联动恰 1 次", rebaseCalls.length === 1 && rebaseCalls[0] === good.base, JSON.stringify(rebaseCalls))
check("发现成功：告警 2 条（open+fixed）", alarms2.length === 2, JSON.stringify(alarms2))
const recA = JSON.parse(readFileSync(incA, "utf-8"))
check("发现成功：事故 closed + rebasedTo 落盘", recA.state === "closed" && recA.rebasedTo === good.base, JSON.stringify(recA))
check("发现成功：client baseUrl 已热换", oc2.baseUrl === good.base, oc2.baseUrl)
// 换基后再巡检一轮：健康、零新告警（去重）
await w2.runOnce()
check("恢复后巡检不再告警", alarms2.length === 2, JSON.stringify(alarms2))
w2.stop()

// —— 3) 巡检：发现失败 → 保持 open + open 告警去重 ——
const bad3 = deadBase()
const oc3 = createClient(bad3)
const alarms3: string[] = []
const incB = join(TMP, "incident-b.json")
const w3 = startLinkWatch({
  client: oc3,
  alarm: async (t) => alarms3.push(t),
  intervalMin: 60,
  discover: async () => null,
  incidentFile: incB,
})
await w3.runOnce()
await w3.runOnce()
const recB = JSON.parse(readFileSync(incB, "utf-8"))
check("发现失败：两次巡检后仍 open", recB.state === "open" && recB.attempts === 2, JSON.stringify(recB))
check("发现失败：open 告警去重只 1 条", alarms3.length === 1, JSON.stringify(alarms3))
w3.stop()

// —— 4) 自然恢复（无 rebase）→ 恢复告警 + closed ——
const good4 = fakeOpencode()
const oc4 = createClient(bad3) // 同一死口起点（w3 已停，状态互不影响：新实例不读 incB）
const alarms4: string[] = []
const incC = join(TMP, "incident-c.json")
const w4 = startLinkWatch({
  client: oc4,
  alarm: async (t) => alarms4.push(t),
  intervalMin: 60,
  discover: async () => null,
  incidentFile: incC,
})
await w4.runOnce() // 失联 → open
oc4.rebase(good4.base) // 模拟"原口复活"（服务回来了）
await w4.runOnce() // 健康 → 自然恢复
const recC = JSON.parse(readFileSync(incC, "utf-8"))
check("自然恢复：closed 且无 rebasedTo", recC.state === "closed" && !recC.rebasedTo, JSON.stringify(recC))
check("自然恢复：告警共 2 条（open+恢复）", alarms4.length === 2, JSON.stringify(alarms4))
w4.stop()

// —— 5) 跨重启延续：预置 open 事故 → 健康巡检结案，不重发 open 告警 ——
const incD = join(TMP, "incident-d.json")
writeFileSync(
  incD,
  JSON.stringify({
    state: "open",
    since: new Date(Date.now() - 10 * 60_000).toISOString(),
    lastCheck: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastError: "旧进程的失联",
    attempts: 5,
  }),
)
const alarms5: string[] = []
const w5 = startLinkWatch({
  client: createClient(good.base),
  alarm: async (t) => alarms5.push(t),
  intervalMin: 60,
  discover: async () => null,
  incidentFile: incD,
})
await w5.runOnce()
const recD = JSON.parse(readFileSync(incD, "utf-8"))
check("跨重启：结案且 attempts 延续", recD.state === "closed" && recD.attempts === 5, JSON.stringify(recD))
check("跨重启：只发恢复告警（不重发 open）", alarms5.length === 1 && alarms5[0].startsWith("✅"), JSON.stringify(alarms5))
w5.stop()

// —— 汇总 ——
stoppers.forEach((s) => s())
rmSync(TMP, { recursive: true, force: true })
let fails = 0
for (const [name, ok2, detail] of results) {
  if (ok2) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nlinkwatch-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
