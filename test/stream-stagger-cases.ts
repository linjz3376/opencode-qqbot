// J-轻（伪流式）行为断言（2026-10-30）：错峰延迟计划纯函数。
import { staggerDelays } from "../src/qq/sender.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

check("单片无延迟", JSON.stringify(staggerDelays(1, 300)) === "[]")
check("零片无延迟", JSON.stringify(staggerDelays(0, 300)) === "[]")
check("stagger=0 关闭", JSON.stringify(staggerDelays(5, 0)) === "[]")
check("stagger<0 关闭", JSON.stringify(staggerDelays(5, -1)) === "[]")
check(
  "3 片 = 2 个间隔",
  JSON.stringify(staggerDelays(3, 300)) === JSON.stringify([300, 300]),
)
check(
  "5 片 = 4 个间隔",
  staggerDelays(5, 250).length === 4 && staggerDelays(5, 250).every((d) => d === 250),
)

let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nstream-stagger-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
