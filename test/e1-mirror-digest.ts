// E1 单元：buildDigest（摘要镜像卡构建）
import { buildDigest } from "../src/opencode/mirror.ts"
import type { SessionMessage } from "../src/opencode/client.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

// 构造实测倒序结构（新→旧）
const mk = (arr: any[]): SessionMessage[] => arr as SessionMessage[]

// 1. 正常一轮：倒序（assistant 答 → user 问 → 上一轮残留）
const normal = mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: "答案是42。" }, { type: "tool", tool: "shell", state: { status: "completed" } }] },
  { id: "u2", type: "user", text: "问一个问题" },
  { id: "a1", type: "assistant", content: [{ type: "text", text: "旧答案" }] },
  { id: "u1", type: "user", text: "旧问题" },
])
const d1 = buildDigest(normal)
check("正常一轮出卡", !!d1, d1?.split("\n")[0] ?? "null")
check("含最新用户问题", d1?.includes("🧑 问一个问题") ?? false)
check("含最新答案、不含旧轮", (d1?.includes("答案是42") ?? false) && !(d1?.includes("旧答案") ?? false))

// 2. 无 assistant 正文（纯工具轮）→ null
const toolOnly = mk([
  { id: "a2", type: "assistant", content: [{ type: "tool", tool: "shell", state: { status: "completed" } }] },
  { id: "u2", type: "user", text: "跑个命令" },
])
check("纯工具轮返回 null", buildDigest(toolOnly) === null)

// 3. 空历史 → null
check("空历史返回 null", buildDigest([]) === null)

// 4. 只有 user 没有回复 → null
check("无回复返回 null", buildDigest(mk([{ id: "u1", type: "user", text: "在吗" }])) === null)

// 5. 超长答案截断 + 提示行
const longText = "字".repeat(2000)
const dLong = buildDigest(mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: longText }] },
  { id: "u2", type: "user", text: "长文" },
]))
check("超长截断到 600+省略号", (dLong?.includes("…") ?? false) && (dLong?.includes("答案共 2000 字") ?? false))

// 6. 脱敏：答案含 token 不外泄
const dSecret = buildDigest(mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: "执行了 OPENCODE_PASSWORD=supersecret123 的命令" }] },
  { id: "u2", type: "user", text: "带密钥的轮次" },
]))
check("答案已脱敏", (dSecret?.includes("***") ?? false) && !dSecret!.includes("supersecret123"))

// 7. 多段文本拼接
const dMulti = buildDigest(mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] },
  { id: "u2", type: "user", text: "多段" },
]))
check("多段文本均收录", (dMulti?.includes("第一段") ?? false) && (dMulti?.includes("第二段") ?? false))

const fails = results.filter(([, ok]) => !ok)
for (const [n, ok, d] of results) console.log(`${ok ? "ok  " : "FAIL"} ${n}${d ? " — " + d : ""}`)
console.log(fails.length === 0 ? "E1 buildDigest: ALL PASS" : `E1: ${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
