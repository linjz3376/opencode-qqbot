// HC1（2026-10-26）：opencode 服务端口漂移自动发现。
// 背景：桌面端 2.1.3 后台服务 = opencode-cli.exe serve --service，端口动态分配
//（实证 49374→28894；服务重建/系统重启后可能再变，且无持久化发现文件）。
// bot 配置的 OPENCODE_BASE_URL 失联（ECONNREFUSED）时，扫描本机 TCP 监听口
// 并逐口探测 /api/info 签名：
//   {"version":"2.1.3","pid":44152,"urls":["http://127.0.0.1:28894"],"paths":{...}}
// 签名要求 version 字符串 + urls 数组 + paths 对象三层同构，随机端口误报概率≈0。
// 仅匹配 `${port}/api/info`：bot 的 V2 端点契约即 base=.../api（见 client.ts），
// 无 /api 前缀的形态与本契约不符，不采用。
// @input:  127.0.0.1 监听口（netstat -ano -p tcp）、/api/info 端点
// @output: discoverOpencode, probeOpencodeEndpoint, parseListenPorts, isOpencodeInfo, persistDiscovery
// @pos:    core - 端口发现（HC1，Windows only）
import { exec } from "node:child_process"
import { promisify } from "node:util"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const execAsync = promisify(exec)

export interface OpencodeDiscovery {
  baseUrl: string
  port: number
  version: string
}

type InfoPayload = { version?: unknown; urls?: unknown; paths?: unknown }

// /api/info 签名校验：version(string) + urls(非空数组) + paths(对象) 三层同构。
export function isOpencodeInfo(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false
  const b = body as InfoPayload
  return (
    typeof b.version === "string" &&
    b.version.length > 0 &&
    Array.isArray(b.urls) &&
    b.urls.length > 0 &&
    b.paths !== null &&
    typeof b.paths === "object"
  )
}

// netstat/ss 输出 → 本机监听口列表（去重，保持首次出现序）。
// 跨平台兼容三形态（QQ 官方插件纯 TS 零 OS 分支为参照——我们也要不挑系统）：
//   Windows:  TCP    127.0.0.1:28894   0.0.0.0:0   LISTENING   44152
//   Linux ss: LISTEN 0 128 127.0.0.1:28894 0.0.0.0:*
//   macOS:    tcp4  0  0  127.0.0.1.28894  *.*  LISTEN（注意 macOS 是点分隔）
// 规则：LISTEN(ING) 行内，取含 : 或 . 分隔的地址列，末段数字即端口；
// 裸 IP 末段可能误当端口（如 127.0.0.1 → 1），无害——探测时签名不符即跳过。
export function parseListenPorts(output: string): number[] {
  const ports = new Set<number>()
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!/\bLISTEN(?:ING)?\b/i.test(line)) continue
    for (const col of line.split(/\s+/)) {
      const m = /^[\w.[\]:%*]*[:.](\d+)$/.exec(col)
      if (!m) continue
      const port = Number(m[1])
      if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
    }
  }
  return [...ports]
}

// 跨平台监听口枚举：Windows=netstat -ano -p tcp；Linux=ss -tln（兜底 netstat -tln）；
// macOS=netstat -an -p tcp（兜底 ss）。命令失败→换备选→全灭则记日志返回空。
async function listListenPorts(): Promise<number[]> {
  const platform = process.platform
  const candidates: string[] =
    platform === "win32"
      ? ["netstat -ano -p tcp"]
      : platform === "darwin"
        ? ["netstat -an -p tcp", "ss -tln"]
        : ["ss -tln", "netstat -tln"]
  for (const cmd of candidates) {
    try {
      const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 10_000 })
      const ports = parseListenPorts(stdout)
      if (ports.length > 0) return ports
    } catch (error) {
      console.log(`[discovery] ${cmd.split(" ")[0]} 不可用: ${error instanceof Error ? error.message : error}`)
    }
  }
  console.log("[discovery] 监听口枚举工具全部不可用，跳过端口扫描")
  return []
}

// 探测单个 /api/info URL；命中签名返回版本号，否则 null
//（连接拒/超时/404/非 JSON/签名不符同归 null，永不抛出）。
export async function probeOpencodeEndpoint(
  url: string,
  opts?: { password?: string; timeoutMs?: number },
): Promise<string | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts?.timeoutMs ?? 900)
  try {
    const headers: Record<string, string> = {}
    if (opts?.password) {
      headers.Authorization = `Basic ${Buffer.from(`opencode:${opts.password}`).toString("base64")}`
    }
    const res = await fetch(url, { headers, signal: ac.signal, redirect: "manual" })
    if (!res.ok) return null
    const body: unknown = JSON.parse(await res.text())
    if (!isOpencodeInfo(body)) return null
    return (body as InfoPayload).version as string
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// 端口发现主流程：默认 netstat 自动列口；测试可注入 ports 跳过扫描。
// 建议调用方在外层包 try/catch——本函数不向上抛（内部兜底日志）。
export async function discoverOpencode(opts?: {
  password?: string
  timeoutMs?: number
  ports?: number[]
}): Promise<OpencodeDiscovery | null> {
  const ports = opts?.ports ?? (await listListenPorts())
  if (ports.length === 0) return null
  const started = Date.now()
  let probed = 0
  for (const port of ports) {
    probed++
    const version = await probeOpencodeEndpoint(`http://127.0.0.1:${port}/api/info`, opts)
    if (version !== null) {
      const hit: OpencodeDiscovery = { baseUrl: `http://127.0.0.1:${port}/api`, port, version }
      console.log(
        `[discovery] 命中 opencode 服务：${hit.baseUrl}（v${hit.version}，第 ${probed}/${ports.length} 口，${Date.now() - started}ms）`,
      )
      return hit
    }
  }
  console.log(`[discovery] 扫描 ${ports.length} 个监听口（${Date.now() - started}ms），无签名命中`)
  return null
}

// 发现结果落盘 ~/.openqq/last-discovered.json，供看门狗/排障查看。不写 .env。
export function persistDiscovery(d: OpencodeDiscovery): void {
  try {
    const dir = join(homedir(), ".openqq")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "last-discovered.json"),
      JSON.stringify({ ...d, at: new Date().toISOString() }, null, 2),
    )
  } catch (error) {
    console.log(`[discovery] 发现结果落盘失败: ${error instanceof Error ? error.message : error}`)
  }
}
