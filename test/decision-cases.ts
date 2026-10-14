// parsePermissionDecision 用例表回归（安全方向性：歧义偏向拒绝）
import { parsePermissionDecision } from "../src/bridge.ts"

const cases: Array<[string, string | null]> = [
  // once
  ["允许", "once"],
  ["同意", "once"],
  ["批准", "once"],
  ["/allow", "once"],
  ["ok", "once"],
  ["yes", "once"],
  ["y", "once"],
  ["OK", "once"],
  // always
  ["总是", "always"],
  ["总是允许", "always"],
  ["/always", "always"],
  ["永久", "always"],
  ["always", "always"],
  // reject —— 重点回归
  ["拒绝", "reject"],
  ["不允许", "reject"],
  ["不同意", "reject"], // ← 修复前误判 once（反向放行）
  ["不批准", "reject"],
  ["总是不允许", "reject"], // ← 修复前误判 always
  ["不行", "reject"],
  ["别", "reject"],
  ["不要", "reject"],
  ["/deny", "reject"],
  ["no", "reject"],
  ["reject", "reject"],
  // 债务D5 混合否定增强（2026-10-13）
  ["不ok", "reject"],
  ["不OK", "reject"],
  ["不太行", "reject"],
  ["不怎么行", "reject"],
  ["不可以", "reject"],
  ["否决", "reject"],
  ["驳回", "reject"],
  ["nope", "reject"],
  ["nah", "reject"],
  ["否", "reject"],
  ["不准", "reject"],
  ["不给", "reject"],
  // null —— 不该被消费
  ["not really", null],
  ["为什么", null],
  ["1", null],
  ["帮我看看这个报错", null],
  ["/status", null],
  ["", null],
]

let fail = 0
for (const [input, expect] of cases) {
  const got = parsePermissionDecision(input)
  const ok = got === expect
  if (!ok) fail++
  console.log(`${ok ? "ok  " : "FAIL"} ${JSON.stringify(input).padEnd(22)} expect=${expect} got=${got}`)
}
console.log(fail === 0 ? `ALL PASS (${cases.length})` : `FAILURES: ${fail}`)
process.exit(fail === 0 ? 0 : 1)
