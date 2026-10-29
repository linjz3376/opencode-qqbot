// B1 行为断言（2026-10-29）：被动回复限额器（吸收自 openclaw-qqbot reply-limiter，P0 官方语义）。
// 覆盖：首查放行、计数到限、超限转主动（带原因）、TTL 过期转主动、FIFO 驱逐、统计与清空。
import { ReplyLimiter } from "../src/core/reply-limiter.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// —— 1) 首次查询：无记录 → 放行且余量满 ——
const l1 = new ReplyLimiter()
const r1 = l1.checkLimit("m1")
check("首查放行（remaining=4）", r1.allowed && r1.remaining === 4 && !r1.shouldFallbackToProactive, JSON.stringify(r1))

// —— 2) 计数到限：record×4 后第 5 次预判转主动 ——
const l2 = new ReplyLimiter()
l2.record("m1")
l2.record("m1")
l2.record("m1")
const before4 = l2.checkLimit("m1")
check("计 3 次后仍放行（remaining=1）", before4.allowed && before4.remaining === 1, JSON.stringify(before4))
l2.record("m1")
const after4 = l2.checkLimit("m1")
check(
  "计满 4 次后转主动（limit_exceeded）",
  !after4.allowed && after4.shouldFallbackToProactive && after4.fallbackReason === "limit_exceeded",
  JSON.stringify(after4),
)

// —— 3) 失败不计额度语义（record 只在成功路径调用，由调用方保证）——
const l3 = new ReplyLimiter()
l3.record("m1")
check("单条记录后统计=1", l3.getStats().trackedMessages === 1 && l3.getStats().totalReplies === 1, JSON.stringify(l3.getStats()))

// —— 4) TTL 过期：短窗口内记录，窗口外查询 → expired 转主动 ——
const l4 = new ReplyLimiter({ ttlMs: 40 })
l4.record("m1")
await sleep(60)
const expired = l4.checkLimit("m1")
check(
  "TTL 过期转主动（expired）且记录已清",
  !expired.allowed && expired.fallbackReason === "expired" && l4.getStats().trackedMessages === 0,
  JSON.stringify(expired),
)

// —— 5) TTL 内不过期：窗口内重复查询稳定 ——
const l5 = new ReplyLimiter({ ttlMs: 60_000 })
l5.record("m1")
const within = l5.checkLimit("m1")
check("TTL 内查询保持计数", within.allowed && within.remaining === 3, JSON.stringify(within))

// —— 6) FIFO 驱逐：maxTracked=2，第 3 条挤掉第 1 条 ——
const l6 = new ReplyLimiter({ maxTrackedMessages: 2 })
l6.record("m1")
l6.record("m2")
l6.record("m3")
check("驱逐后跟踪数=2", l6.getStats().trackedMessages === 2, JSON.stringify(l6.getStats()))
const evicted = l6.checkLimit("m1")
check("被挤出的 m1 视为全新（remaining=满）", evicted.allowed && evicted.remaining === 4, JSON.stringify(evicted))
const kept = l6.checkLimit("m2")
check("保留的 m2 计数延续（remaining=3）", kept.remaining === 3, JSON.stringify(kept))

// —— 7) 自定义 limit ——
const l7 = new ReplyLimiter({ limit: 2 })
l7.record("m1")
l7.record("m1")
const capped = l7.checkLimit("m1")
check("自定义 limit=2 生效", !capped.allowed && capped.fallbackReason === "limit_exceeded", JSON.stringify(capped))

// —— 8) clear ——
const l8 = new ReplyLimiter()
l8.record("m1")
l8.clear()
check("clear 后统计归零", l8.getStats().trackedMessages === 0 && l8.getStats().totalReplies === 0)

// —— 9) 不同 msgId 互不干扰 ——
const l9 = new ReplyLimiter()
for (let i = 0; i < 4; i++) l9.record("m1")
const other = l9.checkLimit("m2")
check("其他 msgId 不受影响", other.allowed && other.remaining === 4, JSON.stringify(other))

// —— 汇总 ——
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nreply-limiter-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
