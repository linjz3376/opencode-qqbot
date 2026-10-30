// Phase 1.1 E2E: 改造后的 promptAndWait —— 普通轮回归 + 权限审批链路实测
// 运行: bun run test/perm-e2e.ts（密钥从 ~/.openqq/.env 经 load-env 载入；需 opencode 在跑）
// 判定: T1/T2/T3 抛异常 = 失败（exit 1）；permSeen 仅观察（规则 auto-allow 时 NO 属正常）。
import { createClient } from "../src/opencode/client.ts"
import "./load-env.ts" // 从 ~/.openqq/.env 载入 OPENCODE_PASSWORD 等（与 bot 同源单点）
// 10-30 深度自测修复：端口从硬编码 49374 改为 .env 单点
const base = process.env.OPENCODE_BASE_URL || "http://localhost:49374/api"

let failed = 0

const client = createClient(base)

function log(...args: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), ...args)
}

async function delSession(id: string) {
  try {
    await fetch(`${base}/session/${id}`, {
      method: "DELETE",
      headers: { Authorization: "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64") },
    })
  } catch {}
}

// 0) 现有保存的权限规则（看 ask 规则在哪）
try {
  const r = await fetch(`${base}/permission/saved`, {
    headers: { Authorization: "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64") },
  })
  const t = await r.text()
  log("saved rules:", t.slice(0, 500))
} catch (e) {
  log("saved rules fetch failed:", String(e))
}

// 10-30 自测修复：测试会话显式用工作模型（Go 系免费默认模型会拒绝带训练条款外调用）
async function newSession(): Promise<string> {
  const s = await client.session.create({})
  const sid = s.data!.id!
  await client.session.setModel({ path: { id: sid }, body: { model: { providerID: "kimi-code-plan-cn", id: "kimi-for-coding" } } })
  return sid
}

// T1: 普通轮回归（权限轮询加入后不能破坏原路径）
const sid1 = await newSession()
log("T1 session:", sid1)
const t1 = Date.now()
try {
  const r1 = await client.promptAndWait(sid1, "只回复两个字：正常", {})
  log("T1 OK reply =", JSON.stringify(r1), `(${Date.now() - t1}ms)`)
} catch (e) {
  log("T1 FAIL:", String(e))
  failed++
}
await delSession(sid1)

// T2: 触发权限审批（shell 命令）
const sid2 = await newSession()
log("T2 session:", sid2)
let permSeen: unknown = null
const t2 = Date.now()
try {
  const r2 = await client.promptAndWait(sid2, "请执行 shell 命令：echo e2e-perm-test，然后告诉我它的输出", {
    onPermission: async (req) => {
      permSeen = req
      log("T2 >>> PERMISSION DETECTED:", JSON.stringify(req))
      log("T2 >>> auto-deciding: once")
      return "once"
    },
  })
  log("T2 OK reply =", JSON.stringify(r2.slice(0, 200)), `(${Date.now() - t2}ms)`)
} catch (e) {
  log("T2 FAIL:", String(e))
  failed++
}
log("T2 permission seen:", permSeen ? "YES" : "NO", `(${Date.now() - t2}ms)`)
await delSession(sid2)

// T3: 若 T2 没触发（规则可能 auto-allow），再试写文件
if (!permSeen) {
  const sid3 = await newSession()
  log("T3 session:", sid3)
  const t3 = Date.now()
  try {
    const r3 = await client.promptAndWait(sid3, '请创建文件 C:\\Users\\linjz\\AppData\\Local\\Temp\\opencode\\e2e-perm.txt 内容为 hello，然后告诉我完成', {
      onPermission: async (req) => {
        permSeen = req
        log("T3 >>> PERMISSION DETECTED:", JSON.stringify(req))
        return "once"
      },
    })
    log("T3 OK reply =", JSON.stringify(r3.slice(0, 200)), `(${Date.now() - t3}ms)`)
  } catch (e) {
    log("T3 FAIL:", String(e))
    failed++
  }
  log("T3 permission seen:", permSeen ? "YES" : "NO")
  await delSession(sid3)
}
log("DONE", failed > 0 ? `failures=${failed}` : "all rounds ok")
if (failed > 0) process.exitCode = 1
