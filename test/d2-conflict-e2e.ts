// D2 E2E：审批双端竞态——外部端点先受理（模拟桌面端），本地 reply 必得 404，
// 期望：onPermissionConflict 触发、onPermissionReplied 不触发、轮次正常收敛。
import { createClient } from "../src/opencode/client.ts"
import "./load-env.ts" // 从 ~/.openqq/.env 载入 OPENCODE_PASSWORD 等（与 bot 同源单点）

const base = "http://localhost:49374/api"
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64")
const H = { Authorization: auth, "Content-Type": "application/json" }

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const client = createClient(base)
const s = await (await fetch(`${base}/session`, { method: "POST", headers: H, body: JSON.stringify({ title: "d2-e2e" }) })).json()
const sid: string = s.data.id
console.log("main session:", sid)

const replied: string[] = []
const conflicts: number[] = []

const promptP = client.promptAndWait(
  sid,
  "执行 shell 命令：`rm D:\\OpenCode\\new-snmp\\.tmp\\d2-e2e-nonexistent.txt`（文件不存在，直接执行即可，不要问我）。执行完简单汇报。",
  {
    onPermission: async (req) => {
      console.log("[E2E] ask 出现:", req.id, "→ 模拟桌面端先批准…")
      // 模拟另一端（桌面）抢先受理
      const r = await fetch(`${base}/session/${req.sessionID}/permission/${req.id}/reply`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ decision: "once" }),
      })
      console.log("[E2E] 外部 reply status:", r.status)
      check("外部端点先受理成功", r.status === 204 || r.status === 200, `status=${r.status}`)
      // 让本地再回一次 → 必然 404 → 冲突路径
      return "once"
    },
    onPermissionReplied: (d) => replied.push(d),
    onPermissionConflict: () => conflicts.push(1),
  },
)

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("120s 超时")), 120000))
try {
  const t = await Promise.race([promptP, timeout]) as string
  check("轮次收敛", true, (t || "").slice(0, 60).replace(/\n/g, " "))
} catch (e: any) {
  check("轮次收敛", false, e.message)
}

check("conflict 回调触发（404 被如实上报）", conflicts.length === 1, `conflicts=${conflicts.length}`)
check("replied 回调未触发（不再误报'已允许'）", replied.length === 0, JSON.stringify(replied))

await fetch(`${base}/session/${sid}`, { method: "DELETE", headers: H })

const fails = results.filter(([, ok]) => !ok)
for (const [n, ok, d] of results) console.log(`${ok ? "ok  " : "FAIL"} ${n} ${d ? "— " + d : ""}`)
console.log(fails.length === 0 ? "D2 E2E: ALL PASS" : `D2 E2E: ${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
