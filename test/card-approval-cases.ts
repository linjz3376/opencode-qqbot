// A 项行为断言（2026-10-29）：卡片按钮审批。
// 覆盖：button_data 编解码、键盘形状（P0 类型对齐）、互动裁决映射、
// 竞态与 fail-closed（槽位替换拒识/忽略不决策/非法数据拒识）。纯单测零网络。
import {
  encodeButtonData,
  decodeButtonData,
  buildApprovalKeyboard,
  handleApprovalInteraction,
  type ApprovalButtonData,
} from "../src/core/card-approval.ts"
import type { InteractionEvent } from "../src/qq/types.ts"
import type { PermissionRequest } from "../src/opencode/client.ts"
import type { PendingPermission } from "../src/core/permission.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const REQ: PermissionRequest = {
  id: "req_test_0001",
  sessionID: "ses_main_0001",
  action: "bash",
  resources: ["rm -rf /tmp/x"],
}

// —— 1) 编解码 ——
const data: ApprovalButtonData = { t: "approval", r: REQ.id, d: "always" }
const round = decodeButtonData(encodeButtonData(data))
check("编解码往返一致", JSON.stringify(round) === JSON.stringify(data), JSON.stringify(round))
check("非法 JSON → undefined", decodeButtonData("{not json") === undefined)
check("缺 t 字段 → undefined", decodeButtonData(JSON.stringify({ r: REQ.id, d: "once" })) === undefined)
check("t 错误 → undefined", decodeButtonData(JSON.stringify({ t: "question", q: "1", i: 0 })) === undefined)
check("d 枚举外 → undefined", decodeButtonData(JSON.stringify({ t: "approval", r: REQ.id, d: "haha" })) === undefined)
check("undefined → undefined", decodeButtonData(undefined) === undefined)

// —— 2) 键盘形状（P0 类型：rows[].buttons[]/render_data/action.permission）——
const kb = buildApprovalKeyboard(REQ, "u_owner_001")
const rows = kb.content.rows
check("2 行布局", rows.length === 2)
const all = rows.flatMap((r) => r.buttons)
check("四键齐全", all.length === 4, all.map((b) => b.render_data.label).join(","))
check("全部按钮 action.type=1", all.every((b) => b.action.type === 1))
check(
  "全部按钮 permission.type=2 且仅发起人可点",
  all.every((b) => b.action.permission.type === 2 && b.action.permission.specify_user_ids?.[0] === "u_owner_001"),
)
check("label 均 ≤10 字符", all.every((b) => b.render_data.label.length <= 10))
check("visited_label 回显化（允许✓/拒绝✗/忽略原样）", all.every((b) => {
  const d = decodeButtonData(b.action.data)
  if (!d) return false
  if (d.d === "ignore") return b.render_data.visited_label === b.render_data.label
  if (d.d === "reject") return b.render_data.visited_label.startsWith("✗")
  return b.render_data.visited_label.startsWith("✓")
}))
const dataSet = new Set(all.map((b) => b.action.data))
check(
  "每键 data 可解码且 r=请求 id",
  [...dataSet].every((d) => decodeButtonData(d)?.r === REQ.id),
)
const decisions = [...dataSet].map((d) => decodeButtonData(d)?.d).sort()
check("四决策齐全（once/always/reject/ignore）", JSON.stringify(decisions) === JSON.stringify(["always", "ignore", "once", "reject"].sort()), JSON.stringify(decisions))

// —— 3) 互动裁决映射 ——
function fakeGate(pendingFor: string | null, resolved: Array<{ uid: string; d: string }>) {
  return {
    getPending: (uid: string) =>
      uid === pendingFor
        ? ({ request: REQ, mainSessionId: "ses_main_0001" } as PendingPermission)
        : undefined,
    resolve: (uid: string, d: string) => resolved.push({ uid, d }),
  }
}
function evt(d: ApprovalButtonData["d"], user = "u_owner_001"): InteractionEvent {
  return { id: "it_1", user_openid: user, data: { type: 11, resolved: { button_data: encodeButtonData({ t: "approval", r: REQ.id, d }) } } }
}

// 3a 正常裁决：once
{
  const log: Array<{ uid: string; d: string }> = []
  const handled = handleApprovalInteraction(evt("once"), fakeGate("u_owner_001", log))
  check("once 裁决被消费", handled && log.length === 1 && log[0].d === "once", JSON.stringify(log))
}
// 3b 总是允许
{
  const log: Array<{ uid: string; d: string }> = []
  handleApprovalInteraction(evt("always"), fakeGate("u_owner_001", log))
  check("always 裁决映射", log.length === 1 && log[0].d === "always")
}
// 3c 拒绝
{
  const log: Array<{ uid: string; d: string }> = []
  handleApprovalInteraction(evt("reject"), fakeGate("u_owner_001", log))
  check("reject 裁决映射", log.length === 1 && log[0].d === "reject")
}
// 3d 忽略 = fail-closed 不决策
{
  const log: Array<{ uid: string; d: string }> = []
  const handled = handleApprovalInteraction(evt("ignore"), fakeGate("u_owner_001", log))
  check("ignore 被消费但不裁决", handled && log.length === 0)
}
// 3e 槽位已空（超时/已处理）：拒识但消费
{
  const log: Array<{ uid: string; d: string }> = []
  const handled = handleApprovalInteraction(evt("once"), fakeGate(null, log))
  check("无待审 → 拒识不裁决", handled && log.length === 0)
}
// 3f request.id 不匹配（槽位被新请求替换）：拒识不误裁决
{
  const log: Array<{ uid: string; d: string }> = []
  const stale = evt("once")
  stale.data!.resolved!.button_data = encodeButtonData({ t: "approval", r: "req_old_stale", d: "once" })
  const handled = handleApprovalInteraction(stale, fakeGate("u_owner_001", log))
  check("旧按钮（r 不匹配）拒识", handled && log.length === 0)
}
// 3g 非本域事件（无 user_openid / 无 button_data）
{
  const log: Array<{ uid: string; d: string }> = []
  const noUser = handleApprovalInteraction({ id: "x", data: { resolved: { button_data: encodeButtonData({ t: "approval", r: REQ.id, d: "once" }) } } }, fakeGate("u_owner_001", log))
  const noData = handleApprovalInteraction({ id: "x", user_openid: "u_owner_001", data: {} }, fakeGate("u_owner_001", log))
  check("缺 user/button_data → 不消费", !noUser && !noData)
}

// 3h 群场景：点击者身份走 group_member_openid（自我评审修复——槽位按 member_openid 索引）
{
  const log: Array<{ uid: string; d: string }> = []
  const groupEvt: InteractionEvent = {
    id: "it_g1",
    scene: "group",
    group_openid: "g_001",
    group_member_openid: "u_owner_001", // 群里无 user_openid
    data: { type: 11, resolved: { button_data: encodeButtonData({ t: "approval", r: REQ.id, d: "once" }) } },
  }
  const handled = handleApprovalInteraction(groupEvt, fakeGate("u_owner_001", log))
  check("群 member_openid 点击可裁决", handled && log.length === 1 && log[0].uid === "u_owner_001", JSON.stringify(log))
}

// —— 汇总 ——
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\ncard-approval-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
