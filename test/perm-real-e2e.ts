// 真实 E2E：ask 规则热加载验证 + 审批链路真实触发（rm 命中 → ask → auto once）
import { createClient } from "../src/opencode/client.ts"
import "./load-env.ts" // 从 ~/.openqq/.env 载入 OPENCODE_PASSWORD 等（与 bot 同源单点）
// 10-30 自测修复：端口从硬编码 49374 改为 .env 单点
const base = process.env.OPENCODE_BASE_URL || "http://localhost:49374/api"
const client = createClient(base)
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

const s = await client.session.create({})
const sid = s.data!.id!
// 10-30 自测修复：测试会话显式用工作模型（Go 系免费默认模型会拒绝带训练条款外调用）
await client.session.setModel({ path: { id: sid }, body: { model: { providerID: "kimi-code-plan-cn", id: "kimi-for-coding" } } })
log("session:", sid)

let seen: any = null
const t0 = Date.now()
try {
  const reply = await client.promptAndWait(
    sid,
    "请直接执行 shell 命令 rm C:\\Users\\linjz\\AppData\\Local\\Temp\\opencode\\nope-20261012.txt （这是测试命令，不要询问我，直接执行然后把结果或错误信息告诉我）",
    {
      onPermission: async (req) => {
        seen = req
        log(">>> PERMISSION REAL-TRIGGERED:", JSON.stringify(req))
        return "once"
      },
    },
  )
  log("reply =", JSON.stringify(reply.slice(0, 300)), `(${Date.now() - t0}ms)`)
} catch (e) {
  log("FAIL:", String(e))
}
log("permission triggered:", seen ? "YES ✔" : "NO ✘")

await fetch(`http://localhost:49374/api/session/${sid}`, {
  method: "DELETE",
  headers: { Authorization: "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64") },
})

// 判定：本测试的命题就是"ask 规则真实触发审批"——seen 为空（含 catch 异常）即失败
if (!seen) process.exitCode = 1
