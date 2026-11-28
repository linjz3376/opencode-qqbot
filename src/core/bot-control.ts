// @input:  ~/.openqq/.env、实例锁、在途台账、core/bot-launcher（运行时解析与 detached 拉起）、
//          core/watchdog（superviseOnce 杀/拉唯一权威）
// @output:  resolveInstalledBotEntry, readAppId, countInflight, waitUntilIdle, startBot, restartBot, stopBot
// @pos:    core - bot 生命周期控制（跨平台；替代 safe-restart.ps1 / start-openqq.ps1）
//
// 2026-11-09 架构红线：重启是运维代码，必须随插件包分发且跨平台。
// 单实例真相=锁文件 pid（不再按命令行正则枚举进程，避免 OS 命令与误杀）。
// 2026-11-10 design §3.9.1 归一：杀/拉唯一权威 = superviseOnce。restartBot 只是它的
// 调用方（等空闲 → 同一 grace-kill+spawn 原语 + supervisor.json 强度账 + 审计分家 +
// 认领互斥），本文件不再实现任何独立杀逻辑（原 stopLockedBot 已删除）。
import { existsSync, readFileSync, readdirSync } from "fs"
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
  // 2026-11-20 应修尽修批：legacy 字段优先，缺省回退 QQ_BOTS 首角色（纯多角色部署的
  // restart/探活锚点——此前只认 legacy 字段，纯 QQ_BOTS 部署下 restart/看门狗全瞎）。
  let botsRaw: string | null = null
  try {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq < 0) continue
      const key = t.slice(0, eq).trim()
      if (key === "QQ_APP_ID") {
        const v = t.slice(eq + 1).trim()
        if (v) return v
      }
      if (key === "QQ_BOTS") botsRaw = t.slice(eq + 1).trim()
    }
  } catch {
    /* 无 .env */
  }
  if (botsRaw) {
    try {
      const arr = JSON.parse(botsRaw) as Array<{ appId?: unknown }>
      const first = Array.isArray(arr) ? arr[0]?.appId : undefined
      if (typeof first === "string" && first) return first
    } catch {
      /* 坏 JSON 视为无 */
    }
  }
  return null
}

export function inflightPath(): string {
  return join(homedir(), ".openqq", "inflight.json")
}

/** 全部角色在途台账路径：legacy 根 + roles/<appId>/（多角色停止/重启的空闲判据必须看全量）。 */
export function inflightPaths(): string[] {
  const root = join(homedir(), ".openqq")
  const paths = [join(root, "inflight.json")]
  try {
    for (const name of readdirSync(join(root, "roles"))) {
      const path = join(root, "roles", name, "inflight.json")
      if (existsSync(path)) paths.push(path)
    }
  } catch {
    /* 无 roles 目录=legacy 单角色 */
  }
  return paths
}

/** 在途回合数（safe-restart/stop 的空闲判据：state=inflight 即算活跃；默认全角色合计）。 */
export function countInflight(paths: string | string[] = inflightPaths()): number {
  const list = Array.isArray(paths) ? paths : [paths]
  let total = 0
  for (const path of list) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown
      if (!Array.isArray(raw)) continue
      total += raw.filter((e) => (e as { state?: string }).state === "inflight").length
    } catch {
      /* 单文件损坏不阻断其他角色判活 */
    }
  }
  return total
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
 * 审计分家（主动杀/验尸拉新）落统一日志 openqq.log——restart 不再有独立杀逻辑。
 */
export async function restartBot(opts: RestartOptions): Promise<RestartResult> {
  const log = opts.log ?? (() => {})
  const appId = readAppId()
  if (!appId) throw new Error("缺少 ~/.openqq/.env 的角色凭据（QQ_APP_ID 或 QQ_BOTS 首角色），无法定位实例锁")
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

export interface StopOptions {
  timeoutMs?: number
  log?: (line: string) => void
}

export interface StopResult {
  action: "stopped" | "skipped"
  killedPid: number | null
  reason: string
}

/**
 * 受控停止：默认等空闲；复用 superviseOnce 的 manual-stop（认领互斥 + 优雅杀 + 清锁 + 审计），
 * 不拉起、不计重启强度账。bot 独立存活是故障隔离，不是脱离用户控制——stop 是显式生命周期终点。
 */
export async function stopBot(opts: StopOptions = {}): Promise<StopResult> {
  const log = opts.log ?? (() => {})
  const appId = readAppId()
  if (!appId) throw new Error("缺少 ~/.openqq/.env 的角色凭据（QQ_APP_ID 或 QQ_BOTS 首角色），无法定位实例锁")
  const idle = await waitUntilIdle({
    timeoutMs: opts.timeoutMs,
    onWait: (n, elapsed) => log(`[bot-control] 仍在途 ${n} 条（已等 ${Math.round(elapsed / 1000)}s），继续等待空闲后停止`),
  })
  if (!idle) {
    log("[bot-control] 等待空闲超时：本次不停止（请稍后重试，或先处理在途回合）")
    return { action: "skipped", killedPid: null, reason: "等待空闲超时" }
  }
  const r = await superviseOnce({
    paths: botWatchdogPaths(appId),
    request: "manual-stop",
    spawn: () => {
      throw new Error("manual-stop 不应拉起 bot")
    },
    log,
  })
  if (r.action === "stopped") {
    return {
      action: "stopped",
      killedPid: r.killedPid,
      reason: r.killedPid ? "已优雅停止并持有（巡检不拉起，restart 解除）" : "bot 未运行，已清锁并持有（巡检不拉起）",
    }
  }
  return { action: "skipped", killedPid: null, reason: r.detail }
}
