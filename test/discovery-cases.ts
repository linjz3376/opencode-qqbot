// HC1 行为断言（2026-10-26）：opencode 端口漂移自动发现。
// 覆盖：netstat 解析（IPv4/IPv6/噪声滤除）、/api/info 签名（结构/鉴权/超时）、
// 发现编排骨架（注入 ports 跳过 netstat，防真服串扰）。
// 只在 bun 下运行（Bun.serve 起临时假服）；不进 tsc 范围。
import {
  parseListenPorts,
  probeOpencodeEndpoint,
  discoverOpencode,
  isOpencodeInfo,
} from "../src/core/discovery.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

// —— 1) netstat 输出解析 ——
const FIX = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:28894        0.0.0.0:0              LISTENING       44152",
  "  TCP    0.0.0.0:4548           0.0.0.0:0              LISTENING       1548",
  "  TCP    [::1]:42050            [::]:0                 LISTENING       8264",
  "  TCP    127.0.0.1:53152        127.0.0.1:28894        ESTABLISHED     8476",
  "  TCPv6  [::]:4310              [::]:0                 LISTENING       38168",
  "  TCP    127.0.0.1:53000        127.0.0.1:53001        TIME_WAIT       0",
  "  TCP    127.0.0.1:28894        0.0.0.0:0              LISTENING       44152",
  "  UDP    127.0.0.1:1900         *:*",
].join("\n")
const ports = parseListenPorts(FIX)
check(
  "解析出 4 个监听口（去重、滤非监听态与 UDP/表头）",
  JSON.stringify(ports) === JSON.stringify([28894, 4548, 42050, 4310]),
  JSON.stringify(ports),
)
check("空输出 → 空数组", parseListenPorts("").length === 0)

// —— 2) /api/info 签名 ——
check("签名通过（完整桌面版形态）", isOpencodeInfo({ version: "2.1.3", pid: 44152, urls: ["http://127.0.0.1:28894"], paths: { tmp: "/tmp" } }))
check("签名拒绝：缺 urls", !isOpencodeInfo({ version: "x", paths: {} }))
check("签名拒绝：version 非字符串", !isOpencodeInfo({ version: 42, urls: [], paths: {} }))
check("签名拒绝：空对象/非对象", !isOpencodeInfo({}) && !isOpencodeInfo(null))

// —— 3) 假服探测 ——
const INFO = {
  version: "2.1.3-test",
  pid: 44152,
  urls: ["http://127.0.0.1:28894"],
  paths: { tmp: "C:\\tmp" },
  capabilities: { persistentPty: true },
}

let stoppers: Array<() => void> = []
function serveInfo(handler: (url: URL, req: Request) => Response | Promise<Response>): { port: number; stop(): void } {
  const srv = Bun.serve({
    port: 0,
    fetch: (req) => handler(new URL(req.url), req),
  })
  stoppers.push(() => srv.stop(true))
  // 端口值构造期取基础类型快照，避开 Server 的 getter 属性
  return { port: srv.port, stop: () => srv.stop(true) }
}
process.on("exit", () => stoppers.forEach((s) => s()))

// 3a) 正常签名 + 无鉴权要求（按真实服行为路由：仅 /api/info 命中，其余 404）
const good = serveInfo((url) =>
  url.pathname === "/api/info"
    ? new Response(JSON.stringify(INFO), { headers: { "content-type": "application/json" } })
    : new Response("not found", { status: 404 }),
)
const v1 = await probeOpencodeEndpoint(`http://127.0.0.1:${good.port}/api/info`)
check("正常签名 → 返回版本号", v1 === "2.1.3-test", String(v1))

// 3b) 签名不符（其他应用碰巧 200 的 JSON）
const badSig = serveInfo(() => new Response(JSON.stringify({ ok: true, version: 123 })))
const v2 = await probeOpencodeEndpoint(`http://127.0.0.1:${badSig.port}/api/info`)
check("签名不符 → null", v2 === null, String(v2))

// 3c) 非 JSON 文本（HTML/其他协议）
const htmlSrv = serveInfo(() => new Response("<!doctype html><html></html>"))
const v3 = await probeOpencodeEndpoint(`http://127.0.0.1:${htmlSrv.port}/api/info`)
check("非 JSON → null", v3 === null, String(v3))

// 3d) 404（同服非 /api/info 路径）
const v4 = await probeOpencodeEndpoint(`http://127.0.0.1:${good.port}/info`)
check("同服错路径 → null", v4 === null, String(v4))

// 3e) 鉴权（桌面服务 Basic auth）：错误密码 401 → null，正确密码 → 版本号
const PW = "hc1-test-password"
const authSrv = serveInfo((url, req) => {
  if ((req.headers.get("authorization") ?? "") !== `Basic ${Buffer.from(`opencode:${PW}`).toString("base64")}`) {
    return new Response("unauthorized", { status: 401 })
  }
  return new Response(JSON.stringify(INFO))
})
const v5 = await probeOpencodeEndpoint(`http://127.0.0.1:${authSrv.port}/api/info`, { password: "wrong-password" })
const v6 = await probeOpencodeEndpoint(`http://127.0.0.1:${authSrv.port}/api/info`, { password: PW })
check("错误密码（401）→ null", v5 === null, String(v5))
check("正确密码 → 版本号", v6 === "2.1.3-test", String(v6))

// 3f) 超时（服务端挂起 10s，客户端 300ms 熔断）
const slow = serveInfo(async () => {
  await new Promise((r) => setTimeout(r, 10_000))
  return new Response(JSON.stringify(INFO))
})
const t0 = Date.now()
const v7 = await probeOpencodeEndpoint(`http://127.0.0.1:${slow.port}/api/info`, { timeoutMs: 300 })
check("挂起服务 → 熔断 null", v7 === null && Date.now() - t0 < 2000, `${String(v7)} ${Date.now() - t0}ms`)

// —— 4) 发现编排骨架（注入端口，禁用 netstat）——
const d1 = await discoverOpencode({ ports: [good.port] })
check(
  "发现命中：base+port+version",
  d1 !== null && d1.baseUrl === `http://127.0.0.1:${good.port}/api` && d1.port === good.port && d1.version === "2.1.3-test",
  JSON.stringify(d1),
)

const badSrv = serveInfo(() => new Response(JSON.stringify({ nope: true })))
const d2 = await discoverOpencode({ ports: [badSrv.port, good.port] })
check("噪声口在前仍能命中（顺序扫描）", d2 !== null && d2.port === good.port, JSON.stringify(d2))

const d3 = await discoverOpencode({ ports: [] })
check("零候选 → null", d3 === null, JSON.stringify(d3))

const d4 = await discoverOpencode({ ports: [badSrv.port] })
check("全不匹配 → null", d4 === null, JSON.stringify(d4))

// —— 汇总 ——
stoppers.forEach((s) => s())
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\ndiscovery-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
