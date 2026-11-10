// @input:  ~/.openqq/.env、实例锁、在途台账、core/bot-launcher（运行时解析与 detached 拉起）、
//          core/watchdog（superviseOnce 杀/拉唯一权威）
// @output:  resolveInstalledBotEntry, readAppId, countInflight, waitUntilIdle, startBot, restartBot
// @pos:    core - bot 生命周期控制（跨平台；替代 safe-restart.ps1 / start-openqq.ps1）
//
// 2026-11-09 架构红线：重启是运维代码，必须随插件包分发且跨平台。
// 单实例真相=锁文件 pid（不再按命令行正则枚举进程，避免 OS 命令与误杀）。
// 2026-11-10 design §3.9.1 归一：杀/拉唯一权威 = superviseOnce。restartBot 只是它的
// 调用方（等空闲 → 同一 grace-kill+spawn 原语 + supervisor.json 强度账 + 审计分家 +
// 认领互斥），本文件不再实现任何独立杀逻辑（原 stopLockedBot 已删除）。
import { existsSync, readFileSync } from "fs"
import { dirname, join } from "path"
import { homedir } from "os"
import { fileURLToPath } from "url"
import {
  buildLaunchPlan,
  botLogPath,
  resolveRuntime,
  spawnBotDetached,
} from "./bot-launcher.js"
import { botWatchdogPaths, superviseOnce } from "./watchdog.js"

/** 从任意入口文件定位同包内的 bot 产物：dist 同目录 → 包根 dist → dev 源码 */
export function resolveInstalledBotEntry(fromUrl: string, exists: (p: string) => boolean = existsSync): string | null {
  const here = dirname(fileURLToPath(fromUrl))
  const candidates = [
    join(here, "openqq-bot.js"), // 打包后：dist/ 同级
    join(here, "..", "dist", "openqq-bot.js"), // src/cli/ → 包根 dist/
    join(here, "..", "src", "index.ts"), // dist/ → 包根 src/（dev）
    join(here, "..", "..", "src", "index.ts"), // src/cli/ → src/index.ts（dev）
  ]
  for (const c of candidates) if (exists(c)) return c
  return null
}

export function readAppId(envPath = join(homedir(), ".openqq", ".env")): string | null {
  try {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq > 0 && t.slice(0, eq).trim() === "QQ_APP_ID") return t.slice(eq + 1).trim() || null
    }
  } catch {
    /* 无 .env */
  }
  return null
}

export function inflightPath(): string {
  return join(homedir(), ".openqq", "inflight.json")
}

/** 在途回合数（safe-restart 的空闲判据：state=inflight 即算活跃） */
export function countInflight(path = inflightPath()): number {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown
    if (!Array.isArray(raw)) return 0
    return raw.filter((e) => (e as { state?: string }).state === "inflight").length
  } catch {
    return 0
  }
}

export async function waitUntilIdle(opts?: {
  timeoutMs?: number
  pollMs?: number
  onWait?: (inflight: number, elapsedMs: number) => void
}): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 60 * 60_000
  const pollMs = opts?.pollMs ?? 10_000
  const started = Date.now()
  for (;;) {
    const n = countInflight()
    if (n === 0) return true
    const elapsed = Date.now() - started
    if (elapsed >= timeoutMs) return false
    opts?.onWait?.(n, elapsed)
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/** 按安装形态拉起 bot（detached，日志走 QQ_LOG_FILE） */
export function startBot(fromUrl: string, log: (line: string) => void = () => {}): number {
  const entry = resolveInstalledBotEntry(fromUrl)
  if (!entry) throw new Error("未找到 bot 入口（dist/openqq-bot.js 或 src/index.ts）——安装不完整")
  const runtime = resolveRuntime()
  if (!runtime) throw new Error("未找到 bun/node 运行时")
  const plan = buildLaunchPlan(runtime, entry, botLogPath())
  const pid = spawnBotDetached(plan)
  log(`[bot-control] 已拉起 pid=${pid}（runtime=${runtime}，entry=${entry}）`)
  return pid
}

export interface RestartOptions {
  force?: boolean
  timeoutMs?: number
  spawnFromUrl: string
  log?: (line: string) => void
}

export interface RestartResult {
  action: "restarted" | "skipped"
  killedPid: number | null
  spawnedPid: number | null
  reason: string
}

/**
 * 安全重启：默认等空闲；-Force 跳过等待。跨平台，等价于旧 safe-restart.ps1。
 * design §3.9.1 归一：杀/拉唯一权威 = superviseOnce（request=manual-restart）。
 * 复用同一 grace-kill（TERM→宽限→KILL→确认死亡才拉）+ spawn 原语，
 * 受 supervisor.json 强度账（15min/3 次 give-up、2min 冷却）与认领互斥约束，
 * 审计分家（主动杀/验尸拉新）落 watchdog.log——restart 不再有独立杀逻辑。
 */
export async function restartBot(opts: RestartOptions): Promise<RestartResult> {
  const log = opts.log ?? (() => {})
  const appId = readAppId()
  if (!appId) throw new Error("缺少 ~/.openqq/.env 的 QQ_APP_ID，无法定位实例锁")
  if (!opts.force) {
    const idle = await waitUntilIdle({
      timeoutMs: opts.timeoutMs,
      onWait: (n, elapsed) => log(`[bot-control] 仍在途 ${n} 条（已等 ${Math.round(elapsed / 1000)}s），继续等待空闲`),
    })
    if (!idle) {
      log("[bot-control] 等待空闲超时：本次不重启（需要时用 --force）")
      return { action: "skipped", killedPid: null, spawnedPid: null, reason: "等待空闲超时" }
    }
  }
  const r = await superviseOnce({
    paths: botWatchdogPaths(appId),
    request: "manual-restart",
    spawn: () => startBot(opts.spawnFromUrl, log),
    log,
  })
  switch (r.action) {
    case "restart":
      return { action: "restarted", killedPid: r.killedPid, spawnedPid: r.spawnedPid, reason: opts.force ? "force（经监督矩阵）" : "idle（经监督矩阵）" }
    case "cooldown":
      return { action: "skipped", killedPid: null, spawnedPid: null, reason: `监督矩阵冷却跳过：${r.detail}` }
    case "give-up":
      return { action: "skipped", killedPid: null, spawnedPid: null, reason: `监督矩阵 give-up：${r.detail}` }
    case "yield":
      return { action: "skipped", killedPid: null, spawnedPid: null, reason: `认领互斥：${r.detail}` }
    default:
      return { action: "skipped", killedPid: null, spawnedPid: null, reason: `无需动作：${r.detail}` }
  }
}
