// D1 E2E：subagent（task 工具子会话）内触发 ask → promptAndWait 必须捕获该请求
// 断言：(a) onPermission 触发 (b) 请求 sessionID ≠ 主会话 (c) 该会话 parentID = 主会话
// (d) 菜单标注"子会话" (e) reject 后轮次正常收敛
import { createClient } from "../src/opencode/client.ts"
import { formatPermissionPrompt } from "../src/bridge.ts"
import "./load-env.ts" // 从 ~/.openqq/.env 载入 OPENCODE_PASSWORD 等（与 bot 同源单点）

const base = "http://localhost:49374/api"
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64")
const H = { Authorization: auth, "Content-Type": "application/json" }

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const client = createClient(base)
const s = await (await fetch(`${base}/session`, { method: "POST", headers: H, body: JSON.stringify({ title: "d1-e2e" }) })).json()
const sid: string = s.data.id
console.log("main session:", sid)

const fired: any[] = []
const conflictCalls: string[] = []
const replied: string[] = []

const promptP = client.promptAndWait(
  sid,
  "请调用 task 工具启动一个子代理（agent: general），子代理只做一件事：在 shell 中执行命令 `rm D:\\OpenCode\\new-snmp\\.tmp\\d1-e2e-nonexistent.txt`（文件不存在，删除会报错没关系，关键是执行这条命令），然后返回。你本人不要直接执行这条 rm 命令，等子代理返回后简单汇报即可。",
  {
    onPermission: async (req) => {
      fired.push(req)
      console.log("[E2E] onPermission fired:", req.id, "sessionID:", req.sessionID, "action:", req.action)
      return "reject" // 立即拒绝，解除子会话挂起
    },
    onPermissionReplied: (d) => replied.push(d),
    onPermissionConflict: () => conflictCalls.push("conflict"),
  },
)

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("promptAndWait 120s 超时")), 120000))
let finalText = ""
try {
  finalText = await Promise.race([promptP, timeout]) as string
  check("轮次收敛", true, (finalText || "").slice(0, 80).replace(/\n/g, " "))
} catch (e: any) {
  check("轮次收敛", false, e.message)
}

check("onPermission 被触发", fired.length >= 1, `触发 ${fired.length} 次`)

if (fired.length > 0) {
  const foreign = fired.filter((r) => r.sessionID !== sid)
  check("请求来自非主会话（subagent）", foreign.length === fired.length, `foreign=${foreign.length}/${fired.length}`)
  // 双重确认父链
  const detail = await (await fetch(`${base}/session/${fired[0].sessionID}`, { headers: H })).json()
  check("子会话 parentID 指向主会话", detail?.data?.parentID === sid, `parentID=${detail?.data?.parentID}`)
  const menu = formatPermissionPrompt(fired[0], sid)
  check("菜单标注子会话来源", menu.includes("子会话"), menu.split("\n").find((l) => l.includes("来源")) ?? "(无来源行)")
  check("reject 回执已回调", replied.includes("reject"), JSON.stringify(replied))
}

// 清理
await fetch(`${base}/session/${sid}`, { method: "DELETE", headers: H })

const fails = results.filter(([, ok]) => !ok)
for (const [n, ok, d] of results) console.log(`${ok ? "ok  " : "FAIL"} ${n} ${d ? "— " + d : ""}`)
console.log(fails.length === 0 ? "D1 E2E: ALL PASS" : `D1 E2E: ${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
