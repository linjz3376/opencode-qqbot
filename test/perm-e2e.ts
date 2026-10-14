// Phase 1.1 E2E: 改造后的 promptAndWait —— 普通轮回归 + 权限审批链路实测
// 运行: bun run test/perm-e2e.ts（密钥从 ~/.openqq/.env 经 load-env 载入；需 opencode 在跑）
// 判定: T1/T2/T3 抛异常 = 失败（exit 1）；permSeen 仅观察（规则 auto-allow 时 NO 属正常）。
import { createClient } from "../src/opencode/client.ts"
import "./load-env.ts" // 从 ~/.openqq/.env 载入 OPENCODE_PASSWORD 等（与 bot 同源单点）

let failed = 0

const client = createClient("http://localhost:49374/api")

function log(...args: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), ...args)
}

async function delSession(id: string) {
  try {
    await fetch(`http://localhost:49374/api/session/${id}`, {
      method: "DELETE",
      headers: { Authorization: "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64") },
    })
  } catch {}
}

// 0) 现有保存的权限规则（看 ask 规则在哪）
try {
  const r = await fetch("http://localhost:49374/api/permission/saved", {
    headers: { Authorization: "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64") },
  })
  const t = await r.text()
  log("saved rules:", t.slice(0, 500))
} catch (e) {
  log("saved rules fetch failed:", String(e))
}

// T1: 普通轮回归（权限轮询加入后不能破坏原路径）
const s1 = await client.session.create({})
const sid1 = s1.data!.id!
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
const s2 = await client.session.create({})
const sid2 = s2.data!.id!
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
  const s3 = await client.session.create({})
  const sid3 = s3.data!.id!
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
