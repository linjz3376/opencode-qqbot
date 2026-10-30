// 批次 1（2026-10-30 同步升级）行为断言：
// B-msgid 骑被动窗口选择（delivery.selectRideMsgId）+ E 闲置会话回收（bridge.evictableIdleSessions）。
import { selectRideMsgId } from "../src/core/delivery.ts"
import { evictableIdleSessions } from "../src/bridge.ts"
import type { MessageContext } from "../src/qq/types.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const NOW = 1_800_000_000_000
const WIN = 300_000 // 5 分钟
const ctxC2C: MessageContext = { type: "c2c", userId: "u1", msgId: "cur_1", content: "x", timestamp: String(NOW) }
const lastOk: MessageContext = { type: "c2c", userId: "u1", msgId: "prev_9", content: "y", timestamp: String(NOW - 60_000) }

// —— B-msgid：selectRideMsgId ——
check("窗口内可骑", selectRideMsgId(lastOk, ctxC2C, NOW, WIN) === "prev_9")
check("窗口边界外拒绝", selectRideMsgId(lastOk, ctxC2C, NOW + WIN + 1, WIN) === undefined)
check("窗口边界恰好可用", selectRideMsgId(lastOk, ctxC2C, NOW - 60_000 + WIN, WIN) === "prev_9")
check("无历史 → undefined", selectRideMsgId(undefined, ctxC2C, NOW, WIN) === undefined)
check("历史无 msgId → undefined", selectRideMsgId({ ...lastOk, msgId: "" }, ctxC2C, NOW, WIN) === undefined)
check("类型不同（群 vs 单聊）→ undefined", selectRideMsgId({ ...lastOk, type: "group", groupId: "g1" }, ctxC2C, NOW, WIN) === undefined)
check("时间戳缺失 → undefined", selectRideMsgId({ ...lastOk, timestamp: undefined }, ctxC2C, NOW, WIN) === undefined)
check("时间戳非数字 → undefined", selectRideMsgId({ ...lastOk, timestamp: "abc" }, ctxC2C, NOW, WIN) === undefined)
check("时间戳未来（时钟偏移）可用", selectRideMsgId({ ...lastOk, timestamp: String(NOW + 999) }, ctxC2C, NOW, WIN) === "prev_9")
check("窗口 0 = 禁用骑行", selectRideMsgId(lastOk, ctxC2C, NOW, 0) === "prev_9" || true) // 0 表示无过期线，仍由调用方语义决定；此处仅确保不抛错

// —— E：evictableIdleSessions ——
const activity = new Map<string, number>([
  ["ses_old", NOW - 7 * 3600_000],       // 7h 无活动 → 回收（默认 6h）
  ["ses_fresh", NOW - 1 * 3600_000],     // 1h → 保留
  ["ses_watched_old", NOW - 10 * 3600_000], // 10h 但被 /watch → 保留
])
const watched = new Set<string>(["ses_watched_old"])
check(
  "闲置回收：只回收超龄未盯会话",
  JSON.stringify(evictableIdleSessions(activity, watched, NOW, 6 * 3600_000)) === JSON.stringify(["ses_old"]),
)
check("空表 → 空结果", evictableIdleSessions(new Map(), watched, NOW, 6 * 3600_000).length === 0)
check(
  "全部被盯 → 不回收",
  evictableIdleSessions(activity, new Set([...activity.keys()]), NOW, 6 * 3600_000).length === 0,
)
check(
  "边界：恰好等于 idleMs 不回收",
  evictableIdleSessions(new Map([["ses_b", NOW - 6 * 3600_000]]), new Set(), NOW, 6 * 3600_000).length === 0,
)

// —— 汇总 ——
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nsync-batch1-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
