// H2 行为断言（2026-10-30）：bgWait 停滞提醒决策（昨晚桌面弹窗卡死事故的缓解件）。
import { stallNudgeDecision } from "../src/bridge.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const T0 = 1_000_000
const FIRST = 30 * 60 * 1000
const INTERVAL = 30 * 60 * 1000
const MAX = 3

check("首次窗口前 → wait", stallNudgeDecision(T0, T0, 0, T0 + FIRST - 1, FIRST, INTERVAL, MAX) === "wait")
check("首次窗口到点 → nudge", stallNudgeDecision(T0, T0, 0, T0 + FIRST, FIRST, INTERVAL, MAX) === "nudge")
check("nudge 后未到间隔 → wait", stallNudgeDecision(T0, T0 + FIRST, 1, T0 + FIRST + INTERVAL - 1, FIRST, INTERVAL, MAX) === "wait")
check("nudge 后间隔到点 → nudge#2", stallNudgeDecision(T0, T0 + FIRST, 1, T0 + FIRST + INTERVAL, FIRST, INTERVAL, MAX) === "nudge")
check("nudge#2 后 → nudge#3", stallNudgeDecision(T0, T0 + FIRST + INTERVAL, 2, T0 + FIRST + INTERVAL * 2, FIRST, INTERVAL, MAX) === "nudge")
check("达到上限 → wait", stallNudgeDecision(T0, T0 + FIRST + INTERVAL * 2, 3, T0 + FIRST + INTERVAL * 99, FIRST, INTERVAL, MAX) === "wait")
check("有进展重置（lastProgressAt 新）→ wait", stallNudgeDecision(T0, T0 + FIRST * 2, 1, T0 + FIRST * 2 + INTERVAL - 1, FIRST, INTERVAL, MAX) === "wait")

let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nstall-nudge-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
