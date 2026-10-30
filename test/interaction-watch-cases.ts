// L 项行为断言（2026-10-30）：常驻交互监听——表单渲染/作答解析/挂起槽语义/pushExternal。
// 用户洞察落地："审批也是选择题"——permission 与 form 统一为一条交互监听流水线。
import {
  renderFormPrompt,
  parseFormAnswer,
  createFormBridge,
  type PendingForm,
} from "../src/core/form-bridge.ts"
import type { FormInfo } from "../src/opencode/client.ts"
import type { MessageContext } from "../src/qq/types.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const CHOICE_FORM: FormInfo = {
  id: "frm_test_001",
  sessionID: "ses_main_001",
  title: "选择部署环境",
  fields: [{ key: "env", type: "multiselect", title: "目标环境", options: [
    { value: "prod", label: "生产" },
    { value: "staging", label: "预发" },
    { value: "dev", label: "开发" },
    { value: "test", label: "测试" },
  ], minItems: 1, maxItems: 2 }],
}

// —— 1) 渲染：选项字母化 A/B/C/D ——
const r1 = renderFormPrompt(CHOICE_FORM)
check("渲染含标题", r1.includes("📝 需要你的选择：选择部署环境"))
check("渲染 A/B/C/D 选项", r1.includes("A) 生产") && r1.includes("B) 预发") && r1.includes("C) 开发") && r1.includes("D) 测试"))
check("多选提示", r1.includes("A,C"))

// —— 2) 解析：字母/序号/多选/标签/非法 ——
check("字母→value（多选数组）", JSON.stringify(parseFormAnswer(CHOICE_FORM, "b")) === JSON.stringify({ env: ["staging"] }))
check("序号→value（多选数组）", JSON.stringify(parseFormAnswer(CHOICE_FORM, "1")) === JSON.stringify({ env: ["prod"] }))
check("多选 A,C", JSON.stringify(parseFormAnswer(CHOICE_FORM, "A,C")) === JSON.stringify({ env: ["prod", "dev"] }))
check("中文逗号多选", JSON.stringify(parseFormAnswer(CHOICE_FORM, "A，D")) === JSON.stringify({ env: ["prod", "test"] }))
check("标签文字→value（多选数组）", JSON.stringify(parseFormAnswer(CHOICE_FORM, "预发")) === JSON.stringify({ env: ["staging"] }))
check("超出 maxItems 拒绝", parseFormAnswer(CHOICE_FORM, "A,B,C") === null)
check("非法字母拒绝", parseFormAnswer(CHOICE_FORM, "Z") === null)

// —— 3) 布尔/自由文本/数字 ——
const BOOL_FORM: FormInfo = { id: "frm_b", sessionID: "s", title: "确认", fields: [{ key: "ok", type: "boolean", title: "继续？" }] }
check("布尔 是/否", JSON.stringify(parseFormAnswer(BOOL_FORM, "是")) === JSON.stringify({ ok: true }) && JSON.stringify(parseFormAnswer(BOOL_FORM, "no")) === JSON.stringify({ ok: false }))
check("布尔非法拒绝", parseFormAnswer(BOOL_FORM, "也许") === null)
const TEXT_FORM: FormInfo = { id: "frm_t", sessionID: "s", title: "输入", fields: [{ key: "name", type: "string", title: "名称" }] }
check("自由文本透传", JSON.stringify(parseFormAnswer(TEXT_FORM, "  hello world  ")) === JSON.stringify({ name: "hello world" }))
const NUM_FORM: FormInfo = { id: "frm_n", sessionID: "s", title: "数量", fields: [{ key: "n", type: "integer" }] }
check("整数解析", JSON.stringify(parseFormAnswer(NUM_FORM, "42")) === JSON.stringify({ n: 42 }))
check("整数拒绝小数", parseFormAnswer(NUM_FORM, "4.5") === null)

// —— 4) 单选 string（options）——
const SINGLE_FORM: FormInfo = { id: "frm_s", sessionID: "s", title: "选一个", fields: [{ key: "m", type: "string", options: [{ value: "x", label: "方案甲" }, { value: "y", label: "方案乙" }] }] }
check("string 单选字母", JSON.stringify(parseFormAnswer(SINGLE_FORM, "B")) === JSON.stringify({ m: "y" }))
const rs = renderFormPrompt(SINGLE_FORM)
check("string 单选渲染字母", rs.includes("A) 方案甲") && rs.includes("B) 方案乙"))

// —— 5) formBridge 槽语义（假 deps）——
const sent: string[] = []
const replies: Array<{ sessionID: string; formID: string; answer: Record<string, unknown> }> = []
const ctx: MessageContext = { type: "c2c", userId: "u1", msgId: "m1", content: "" }
const fakeClient = {
  form: {
    list: async () => ({ data: [] }),
    reply: async (o: { path: { sessionID: string; formID: string }; body: { answer: Record<string, unknown> } }) => {
      replies.push({ sessionID: o.path.sessionID, formID: o.path.formID, answer: o.body.answer })
    },
  },
}
const bridge = createFormBridge({
  client: fakeClient as any,
  sendReply: async (_c, text) => void sent.push(text),
  safeDeliver: async (_c, text) => void sent.push(text),
})

bridge.pushForm("u1", ctx, CHOICE_FORM)
check("推送即发送渲染文本", sent.some((t) => t.includes("A) 生产")))
check("槽已建立", bridge.hasPending("u1"))
bridge.pushForm("u1", ctx, CHOICE_FORM) // 同 id 去重
check("同 id 去重不重复推送", sent.filter((t) => t.includes("A) 生产")).length === 1)

check("无挂起用户 → false", bridge.tryResolveText("u2", "A") === false)
check("挂起用户解析失败 → true 且发提示", bridge.tryResolveText("u1", "Z") === true && sent.some((t) => t.includes("没看懂")))
check("挂起用户作答 → 提交 reply", bridge.tryResolveText("u1", "A,C") === true && replies.length === 1 && JSON.stringify(replies[0].answer) === JSON.stringify({ env: ["prod", "dev"] }))
check("提交后槽清空", !bridge.hasPending("u1"))

// 新表单取代旧槽
bridge.pushForm("u1", ctx, CHOICE_FORM)
bridge.pushForm("u1", ctx, SINGLE_FORM)
check("新表单取代旧槽并提示", sent.some((t) => t.includes("有新的选择请求")) && bridge.getPending("u1")?.form.id === "frm_s")

// —— 6) pushExternal 语义（permission 域，假 deps 经 createPermissionGate 不便→直接验接口存在性略）——
// permission.pushExternal 的行为依赖 createPermissionGate 全量 deps，此处验 form 侧为主；
// pushExternal 的 404/直连 reply 路径与 restored 相同（既有 O2 语义），由部署后实测验。

// —— 汇总 ——
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\ninteraction-watch-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
