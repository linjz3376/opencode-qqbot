// @input:  ~/.openqq 锁文件与心跳文件、process 存活探测、注入的 spawn/kill
// @output: botWatchdogPaths, readBotHealth, isPidAlive, decideWatchdog, healOnce
// @pos:    core - 跨平台看门狗（纯 Node API，无 PowerShell/OS 脚本依赖）
//
// 2026-11-09 架构红线（见 AGENTS.md）：运维代码只随插件包分发、只用 TS/JS，
// 平台差异只允许出现在「自启注册」一处。判活优先级：
//   锁文件 pid（单实例仲裁的唯一真相）+ process.kill(pid,0) + 心跳文件新鲜度。
// 约定：锁 mtime 由 bot 每 10s 刷新（instance-lock）；心跳文件由 bot 每 60s 刷新，
// 且 2026-11-09 起「抢锁后立即写」，因此「进程活但心跳陈旧」= 真僵死，不是启动中。
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { homedir } from "os"
import { enforceLogBudget, logLimitsFromEnv, rotateLogIfNeeded } from "./log-rotate.js"
import { releaseLocksOfPid } from "./instance-lock.js"

/** 心跳超过 5 分钟未刷新 = 事件循环僵死（与既有看门狗阈值一致） */
export const HEARTBEAT_STALE_MS = 5 * 60_000
/** P10：锁 mtime 新鲜阈值（instance-lock 持锁者 10s 刷新；30s=3 倍周期余量）。 */
export const LOCK_MTIME_FRESH_MS = 30_000
/** 锁 mtime 超过 30s 未刷新 = 僵尸锁（与 instance-lock 一致） */
export const LOCK_STALE_MS = 30_000
/** 启动宽限：锁刚建立、心跳尚未落盘的窗口 */
export const STARTUP_GRACE_MS = 60_000

export interface BotWatchdogPaths {
  lockPath: string
  heartbeatPath: string
}

export function botWatchdogPaths(appId: string): BotWatchdogPaths {
  const dir = join(homedir(), ".openqq")
  return { lockPath: join(dir, `openqq-${appId}.lock`), heartbeatPath: join(dir, "heartbeat") }
}

export interface BotHealth {
  /** 锁文件里的 pid；无锁/损坏为 null */
  lockPid: number | null
  /** 锁 mtime 距今毫秒；无锁为 null */
  lockAgeMs: number | null
  /** pid 是否存活；pid 未知为 null */
  pidAlive: boolean | null
  /** 心跳文件距今毫秒；缺失为 null */
  heartbeatAgeMs: number | null
}

export interface WatchdogDecision {
  action: "ok" | "restart"
  reason: string
  /** restart 时若进程仍活着，需要先杀掉的 pid */
  killPid: number | null
}

export interface WatchdogOptions {
  heartbeatStaleMs?: number
  startupGraceMs?: number
}

/** 跨平台进程存活探测：ESRCH=不存在；EPERM=存在但无权限（视为存活） */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function ageOf(path: string, now: number): number | null {
  try {
    return Math.max(0, now - statSync(path).mtimeMs)
  } catch {
    return null
  }
}

export function readBotHealth(paths: BotWatchdogPaths, now = Date.now()): BotHealth {
  const lockAgeMs = ageOf(paths.lockPath, now)
  let lockPid: number | null = null
  if (lockAgeMs !== null) {
    try {
      const raw = JSON.parse(readFileSync(paths.lockPath, "utf-8")) as { pid?: unknown }
      if (typeof raw.pid === "number" && Number.isInteger(raw.pid)) lockPid = raw.pid
    } catch {
      /* 损坏/半写锁 → pid 未知，交给决策当缺失处理 */
    }
  }
  return {
    lockPid,
    lockAgeMs,
    pidAlive: lockPid === null ? null : isPidAlive(lockPid),
    heartbeatAgeMs: ageOf(paths.heartbeatPath, now),
  }
}

/** 纯决策（表驱动，导出供测试）：只回答「要不要重启、要不要先杀谁、为什么」 */
export function decideWatchdog(h: BotHealth, opts?: WatchdogOptions): WatchdogDecision {
  const heartbeatStaleMs = opts?.heartbeatStaleMs ?? HEARTBEAT_STALE_MS
  const startupGraceMs = opts?.startupGraceMs ?? STARTUP_GRACE_MS

  if (h.lockPid === null) {
    return {
      action: "restart",
      reason: h.lockAgeMs === null ? "进程缺失（无锁文件）" : "锁文件无可读 pid",
      killPid: null,
    }
  }
  if (h.pidAlive === false) {
    return { action: "restart", reason: `锁定进程已退出（pid=${h.lockPid}）`, killPid: null }
  }
  if (h.heartbeatAgeMs === null) {
    const lockAge = h.lockAgeMs ?? 0
    if (lockAge < startupGraceMs) {
      return { action: "ok", reason: `启动中（心跳未落盘，锁龄 ${Math.round(lockAge / 1000)}s）`, killPid: null }
    }
    // DEF-20261119-P10 第一层守卫：锁 mtime 由持锁者每 10s 刷新（instance-lock 契约，
    // index.ts 注释明言「锁活性另由 instance-lock 的 mtime 心跳承担」）。锁新鲜=进程
    // 必有进展——heartbeat 文件可能因 IO 抖动/启动边缘未落盘，不得据此杀真 holder。
    // 2026-11-19 实证：CLI/引导器拉起的健康 spawn 被「心跳文件缺失」分支误杀 10+ 次，
    // 锁 mtime 全程新鲜。阈值对齐僵尸锁口径（30s=3×10s 刷新周期）。
    if (h.lockAgeMs !== null && h.lockAgeMs < LOCK_MTIME_FRESH_MS) {
      return {
        action: "ok",
        reason: `锁心跳新鲜（${Math.round(h.lockAgeMs / 1000)}s）——进程有进展，heartbeat 文件缺失不杀`,
        killPid: null,
      }
    }
    return { action: "restart", reason: "心跳文件缺失（进程存活但无进展）", killPid: h.lockPid }
  }
  if (h.heartbeatAgeMs > heartbeatStaleMs) {
    // P10 第二层守卫：同上——heartbeat 文件停滞但锁 mtime 新鲜 = 文件写入链路故障，
    // 进程实际存活，按「无进展」杀属于误杀。锁也陈旧才真是僵死。
    if (h.lockAgeMs !== null && h.lockAgeMs < LOCK_MTIME_FRESH_MS) {
      return {
        action: "ok",
        reason: `锁心跳新鲜（${Math.round(h.lockAgeMs / 1000)}s）——heartbeat 文件停滞按写入故障处理，不杀`,
        killPid: null,
      }
    }
    return {
      action: "restart",
      reason: `心跳陈旧 ${Math.round(h.heartbeatAgeMs / 60_000)} 分钟（进程疑似僵死）`,
      killPid: h.lockPid,
    }
  }
  return { action: "ok", reason: "健康", killPid: null }
}

export interface HealDeps {
  paths: BotWatchdogPaths
  /** 拉起 bot，返回 pid */
  spawn: () => number
  /** 杀掉残留 pid（默认 process.kill） */
  kill?: (pid: number) => void
  now?: () => number
  log?: (line: string) => void
  opts?: WatchdogOptions
}

export interface HealResult {
  action: "ok" | "restart"
  reason: string
  killedPid: number | null
  spawnedPid: number | null
}

const defaultKill = (pid: number): void => {
  try {
    process.kill(pid)
  } catch {
    /* 已退出 */
  }
}

/** 单次巡检：判活 →（必要时）杀残留 → 拉起。副作用全部经注入，便于测试。 */
export function healOnce(deps: HealDeps): HealResult {
  const now = deps.now?.() ?? Date.now()
  const health = readBotHealth(deps.paths, now)
  const decision = decideWatchdog(health, deps.opts)
  if (decision.action === "ok") return { action: "ok", reason: decision.reason, killedPid: null, spawnedPid: null }

  let killedPid: number | null = null
  if (decision.killPid !== null && decision.killPid !== process.pid) {
    ;(deps.kill ?? defaultKill)(decision.killPid)
    killedPid = decision.killPid
  }
  const spawnedPid = deps.spawn()
  return { action: "restart", reason: decision.reason, killedPid, spawnedPid }
}

/** 极简 .env 读取（与 bot-launcher.readDotEnvField 同语义；此处避免循环依赖） */
export function readEnvField(envPath: string, key: string): string | null {
  try {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq < 0) continue
      if (trimmed.slice(0, eq).trim() === key) return trimmed.slice(eq + 1).trim()
    }
    return null
  } catch {
    return null
  }
}

/** bot 是否失能（无锁 / 持锁进程已死）——选主让贤的破格判据：bot 失能时任何通道都不许礼貌让贤。 */
export function isBotDown(health: BotHealth): boolean {
  return health.lockPid === null || health.pidAlive === false
}

/** 追加一行巡检日志到统一日志 ~/.openqq/openqq.log（数据目录，不是代码；
 *  2026-11-20 合并批：bot 与看门狗同文件，一眼归因全链路） */
export function appendWatchdogLog(line: string): void {
  try {
    const logPath = join(homedir(), ".openqq", "openqq.log")
    const limits = logLimitsFromEnv()
    if (existsSync(logPath) && statSync(logPath).size > limits.maxBytes) {
      if (rotateLogIfNeeded(logPath, limits)) enforceLogBudget(logPath, limits)
    }
    writeFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { flag: "a" })
  } catch {
    /* 日志失败不阻断巡检 */
  }
}

/**
 * 诛杀审计日志（DEF-20261120 墙 owner 当轮令「决策可审计」）：独立文件 ~/.openqq/kills.log。
 *
 * 设计判据（审计三问）——每条诛杀记录必须可回答：
 *   ①判据是什么（为何判死：心跳陈旧 N 分钟/锁死/进程退出，附当时健康度快照）
 *   ②动作是什么（杀谁：pid；怎么杀：TERM→KILL 升级链；结果：确认死亡/无法终止）
 *   ③后果是什么（拉起了谁：新 pid；强度账现状：窗口内第几次）
 *
 * 与统一日志（openqq.log）的分工：openqq.log=全链路时间线（bot 输出+巡检混排，事后按时间归因）；
 * kills.log=诛杀决策专线（只有杀戮级动作，事后审计免捞沙）。两处都写不冗余——
 * 审计场景下 openqq.log 会被 bot 高频输出冲刷稀释（11-20 实证：30 分钟卡死现场被
 * 后续日志淹没，诛杀归因只能靠 supervisor 片段倒推），kills.log 保证决策记录永不被稀释。
 */
export function appendKillLog(entry: KillAuditEntry, logPath = join(homedir(), ".openqq", "kills.log")): void {
  try {
    // 单行 JSONL：机器可解析（工具审计）+人类可读（字段名自释）。
    // 轮转归 log-rotate 统一管辖（与 openqq.log 同口径 20MB×4 代/100MB 总预算；
    // 量级=决策级事件每天数条，statSync 每次诛杀一次可忽略）。
    writeFileSync(logPath, `${JSON.stringify(entry)}\n`, { flag: "a" })
    const limits = logLimitsFromEnv()
    if (existsSync(logPath) && statSync(logPath).size > limits.maxBytes) {
      if (rotateLogIfNeeded(logPath, limits)) enforceLogBudget(logPath, limits)
    }
  } catch {
    /* 审计日志失败不阻断监督主流程——监督本身即最后防线 */
  }
}

/** 诛杀审计记录（字段=审计三问的机器形态；@ts 这里的时间一律 epoch ms） */
export interface KillAuditEntry {
  /** 记录类型：decision=完整决策审计；liveness-check=拉起后存活确认 */
  kind: "decision" | "liveness-check"
  /** ①判据：触发动作的原始原因（如「心跳陈旧 30 分钟」） */
  reason: string
  /** ①判据附证：动刀时刻的健康度快照（判死依据的原始数据，审计不复算） */
  health: {
    lockPid: number | null
    pidAlive: boolean | null
    heartbeatAgeMs: number | null
    lockAgeMs: number | null
  }
  /** ②动作：杀掉的 pid（null=本次为纯拉起/复核类记录） */
  killedPid: number | null
  /** ②动作：升级链终点（TERM 快速退出 / KILL 强杀 / 无法终止） */
  killEscalation: "TERM" | "KILL" | "unterminated" | "n/a"
  /** ③后果：拉起的新 pid */
  spawnedPid: number | null
  /** ③后果：强度账（窗口内重启次数/上限） */
  restartIntensity: string
  /** ③后果：拉起后存活复核结论（liveness-check 专用；decision 记录取证时为 null） */
  livenessVerdict: string | null
  at: number
}

// ===== 监督层（2026-11-09 重构，替代裸 healOnce 的「无脑杀旧拉新」）=====
// 设计对标（当日检索实证）：
//  - Erlang OTP supervisor：maximum restart intensity——窗口内重启超限 → 放弃并上报，
//    「防止同因反复死亡反复重启」；
//  - fleet-guard（Claude Code 生态）：升级杀 SIGTERM→宽限→SIGKILL，且 fail-open
//    「守卫绝不能拖死被守卫者」；
//  - k8s 教训：liveness 误杀瞬时态 → 冷却窗口（冷却期内的重复判死直接跳过）；
//  - claude-code#85206：杀掉后必须保留工作并对操作者可感（give-up 必告警）。

export interface SupervisorPolicy {
  /** 距上次重启不足该值 → 冷却跳过（防插件引导器与计划任务互踢、防抖动） */
  cooldownMs: number
  /** windowMs 内最多重启次数（OTP intensity） */
  maxRestarts: number
  /** 重启强度统计窗口（OTP period） */
  windowMs: number
  /** SIGTERM 后等待退出的宽限，超时升级强杀（fleet-guard 升级杀） */
  graceMs: number
  /** 监督者认领锁的有效期：持锁期间其他监督者让行 */
  claimTtlMs: number
}

export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
  cooldownMs: 2 * 60_000,
  maxRestarts: 3,
  windowMs: 15 * 60_000,
  graceMs: 8_000,
  claimTtlMs: 90_000,
}

export interface SupervisorState {
  /** 重启时间戳（升序）；滑动窗口统计强度 */
  restartLog: number[]
  /** 上次 give-up 告警时间（30 分钟内不重复轰炸操作者） */
  alertedAt?: number
}

export type SuperviseAction =
  | { kind: "ok" }
  | { kind: "yield"; reason: string } // 其他监督者持锁
  | { kind: "cooldown"; untilMs: number }
  | { kind: "spawn"; reason: string }
  | { kind: "grace-kill-spawn"; killPid: number; reason: string }
  | { kind: "give-up"; restarts: number }

/** 纯决策矩阵（导出供测试）：健康 → 强度 → 冷却 → 处置方式。 */
export function decideSupervise(
  health: BotHealth,
  state: SupervisorState,
  now: number,
  policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY,
): SuperviseAction {
  const staleHeartbeat = health.heartbeatAgeMs !== null && health.heartbeatAgeMs > HEARTBEAT_STALE_MS
  const needsRestart =
    health.lockPid === null || health.pidAlive === false || staleHeartbeat
  if (!needsRestart) return { kind: "ok" }

  // OTP intensity：窗口内已达上限 → 放弃循环，上报人工（不给故障进程当永动机）
  const windowStart = now - policy.windowMs
  const recentRestarts = state.restartLog.filter((t) => t > windowStart).length
  if (recentRestarts >= policy.maxRestarts) return { kind: "give-up", restarts: recentRestarts }

  // 冷却：刚重启过又判死 → 大概率是瞬时/叠加判死，跳过本轮（k8s 误杀教训）
  const last = state.restartLog[state.restartLog.length - 1] ?? null
  if (last !== null && now - last < policy.cooldownMs) return { kind: "cooldown", untilMs: last + policy.cooldownMs }

  if (health.lockPid !== null && health.pidAlive !== false && staleHeartbeat) {
    return {
      kind: "grace-kill-spawn",
      killPid: health.lockPid,
      reason: `心跳陈旧 ${Math.round((health.heartbeatAgeMs ?? 0) / 60_000)} 分钟（进程活但事件循环无进展）`,
    }
  }
  return { kind: "spawn", reason: health.lockPid === null ? "无实例锁（bot 未运行）" : "锁定进程已退出" }
}

export interface SuperviseDeps {
  paths: BotWatchdogPaths
  spawn: () => number
  policy?: SupervisorPolicy
  /**
   * 触发形态：health-check=周期巡检（默认）；manual-restart=openqq restart
   * 人工请求（design §3.9.1：restart 是 superviseOnce 的调用方而非独立实现）。
   * manual-restart 下健康实例也会被优雅杀后拉起，并跳过「杀前复核」（人工意图
   * 即权威，复核只防监督者误杀）；强度账/冷却/认领互斥/审计分家全部照旧。
   */
  request?: "health-check" | "manual-restart"
  now?: () => number
  kill?: (pid: number, signal?: "SIGTERM" | "SIGKILL") => void
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  /** give-up 时上报操作者（QQ 通知等）；缺省只落日志 */
  alert?: (message: string) => void
  statePath?: string
  claimPath?: string
  /** 监督动作审计日志路径（测试注入临时文件，避免污染真实 watchdog.log） */
  auditLogPath?: string
  /**
   * 拉起后存活确认（DEF-20261120 墙二次追击层）注入点：
   * 缺省=生产行为（10s 后复核进程+锁，失败二次拉起）；测试注入 false=整层跳过
   *（fake spawn 返回假 pid、锁不落盘，生产复核在测试环境必判死，旧用例语义不变）。
   */
  livenessCheck?: boolean
}

export interface SuperviseResult {
  action: string
  detail: string
  killedPid: number | null
  spawnedPid: number | null
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const defaultSupervisorKill = (pid: number, signal?: "SIGTERM" | "SIGKILL"): void => {
  try {
    process.kill(pid, signal)
  } catch {
    /* 已退出 */
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(path, "utf-8")) as T) }
  } catch {
    return fallback
  }
}

/**
 * 单次监督：认领锁 → 判健康 → 决策 → 执行（优雅杀/拉起/放弃上报）→ 记强度账。
 * 插件引导器与计划任务共用本函数，互斥靠 claim 文件，杜绝双开竞争。
 */
export async function superviseOnce(deps: SuperviseDeps): Promise<SuperviseResult> {
  const policy = deps.policy ?? DEFAULT_SUPERVISOR_POLICY
  const now = deps.now?.() ?? Date.now()
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? defaultSleep
  const kill = deps.kill ?? defaultSupervisorKill
  const isAlive = deps.isAlive ?? isPidAlive
  const statePath = deps.statePath ?? join(homedir(), ".openqq", "supervisor.json")
  const claimPath = deps.claimPath ?? join(homedir(), ".openqq", "supervisor.lock")
  const audit = (line: string): void => {
    if (deps.auditLogPath) {
      try {
        writeFileSync(deps.auditLogPath, `${new Date().toISOString()} ${line}\n`, { flag: "a" })
        return
      } catch {
        /* fallthrough 到默认日志 */
      }
    }
    appendWatchdogLog(line)
  }

  // —— 监督者认领（进程内互斥；持锁者崩溃后 claimTtlMs 可被接管）——
  const claim = readJson<{ pid: number; ts: number }>(claimPath, { pid: 0, ts: 0 })
  if (claim.ts && now - claim.ts < policy.claimTtlMs && claim.pid !== process.pid) {
    return { action: "yield", detail: `监督者 pid=${claim.pid} 持锁中`, killedPid: null, spawnedPid: null }
  }
  try {
    writeFileSync(claimPath, JSON.stringify({ pid: process.pid, ts: now }))
  } catch {
    return { action: "yield", detail: "认领锁不可写", killedPid: null, spawnedPid: null }
  }
  const release = (): void => {
    try {
      writeFileSync(claimPath, JSON.stringify({ pid: 0, ts: 0 }))
    } catch {
      /* 残留由 TTL 接管 */
    }
  }

  try {
    const health = readBotHealth(deps.paths, now)
    const state = readJson<SupervisorState>(statePath, { restartLog: [] })
    let action = decideSupervise(health, state, now, policy)

    // 人工请求重启（design §3.9.1 入口 3）：健康实例也要优雅杀后拉起；
    // bot 未运行/已死则只拉起。强度与冷却约束在 decideSupervise 内已经生效
    //（needsRestart 为 false 时同样先查 give-up/cooldown，再走到这里覆盖动作）。
    if (deps.request === "manual-restart" && action.kind === "ok") {
      // 强度/冷却约束对人工入口同样生效（design §3.9.1「复用…强度约束」）：
      // decideSupervise 的 ok 分支不查强度账，这里补齐同口径检查。
      const windowStart = now - policy.windowMs
      const recentRestarts = state.restartLog.filter((t) => t > windowStart).length
      if (recentRestarts >= policy.maxRestarts) {
        return {
          action: "give-up",
          detail: `15 分钟内已重启 ${recentRestarts} 次（监督强度上限），人工重启亦被拦截，请排查根因`,
          killedPid: null,
          spawnedPid: null,
        }
      }
      const last = state.restartLog[state.restartLog.length - 1] ?? null
      if (last !== null && now - last < policy.cooldownMs) {
        return { action: "cooldown", detail: `距上次重启不足 ${Math.round(policy.cooldownMs / 1000)}s（冷却期），人工重启跳过`, killedPid: null, spawnedPid: null }
      }
      action =
        health.lockPid !== null && health.pidAlive !== false
          ? { kind: "grace-kill-spawn", killPid: health.lockPid, reason: "人工请求重启（openqq restart）" }
          : { kind: "spawn", reason: "人工请求重启（bot 未运行，直接拉起）" }
    }

    if (action.kind === "ok") return { action: "ok", detail: "健康", killedPid: null, spawnedPid: null }
    if (action.kind === "cooldown") {
      log(`[supervisor] 冷却中（上次重启 ${Math.round((now - (action.untilMs - policy.cooldownMs)) / 1000)}s 前），本轮跳过`)
      return { action: "cooldown", detail: "冷却跳过", killedPid: null, spawnedPid: null }
    }
    if (action.kind === "yield") {
      return { action: "yield", detail: action.reason, killedPid: null, spawnedPid: null }
    }
    if (action.kind === "give-up") {
      const message = `⚠️ QQBot 看门狗已达重启强度上限：${action.restarts} 次/${Math.round(policy.windowMs / 60_000)} 分钟仍不健康（同因反复死亡）。降频重试继续——巡检不会停，强度窗口滑动后自动恢复，引擎/环境自愈即自行好转；若持续收到此告警，请检查 ~/.openqq/openqq.log（bot 与看门狗统一日志）。`
      audit(`give-up：${message}`)
      log(`[supervisor] give-up：${action.restarts} 次重启仍异常，降频重试继续并上报（不再永动猛拉）`)
      // 告警去抖：30 分钟内只报一次（计划任务每 10 分钟一轮，防止轰炸）
      const lastAlert = state.alertedAt ?? 0
      if (now - lastAlert > 30 * 60_000) {
        try {
          deps.alert?.(message)
          state.alertedAt = now
          writeFileSync(statePath, JSON.stringify(state))
        } catch {
          /* 上报失败不阻断 */
        }
      }
      return { action: "give-up", detail: message, killedPid: null, spawnedPid: null }
    }

    // spawn / grace-kill-spawn
    let killedPid: number | null = null
    if (action.kind === "grace-kill-spawn" && action.killPid !== process.pid) {
      const pid = action.killPid
      // —— 杀前复核（2026-11-09 加固红线）：decide 与执行之间 bot 可能刚恢复心跳
      //（事件循环解堵/冷启动落盘延迟），此时直接杀=误杀良民（合法杀掉干活中的 bot）。
      // 复核前先给 bot 的心跳写入一个短暂到达窗口（300ms）：读健康度与动刀之间
      // 若有心跳落盘必须被看见；随后重读一次，转新鲜即改判 ok、放弃本轮，全程审计留痕。
      // 心跳「缺失」不豁免（语义同 decide：缺失视为未恢复，维持原判）。——
      // 例外：manual-restart（人工意图即权威，不存在"误杀"）。——
      if (deps.request !== "manual-restart") {
        await sleep(300)
        const recheck = readBotHealth(deps.paths, Date.now())
        const recheckFresh =
          recheck.heartbeatAgeMs !== null && recheck.heartbeatAgeMs <= HEARTBEAT_STALE_MS
        if (recheck.pidAlive !== false && recheckFresh) {
          const ageSec = Math.round((recheck.heartbeatAgeMs ?? 0) / 1000)
          audit(`杀前复核改判 ok：pid=${pid} 心跳已恢复（年龄 ${ageSec}s），放弃误杀`)
          log(`[supervisor] 杀前复核改判 ok：心跳已恢复（${ageSec}s），放弃杀 pid=${pid}`)
          return { action: "ok", detail: `杀前复核：心跳已恢复，放弃误杀 pid=${pid}`, killedPid: null, spawnedPid: null }
        }
      }
      // 升级杀（fleet-guard）：TERM → 宽限轮询 → KILL。
      // Windows 上 Node 的 SIGTERM≈立即终止（无 handler 语义），宽限主要服务 posix；
      // 但轮询仍统一：确认死亡后才拉起，绝不「边杀边拉」。
      kill(pid, "SIGTERM")
      const deadline = now + policy.graceMs
      let alive = isAlive(pid)
      while (alive && Date.now() < deadline) {
        await sleep(250)
        alive = isAlive(pid)
      }
      if (alive) {
        kill(pid, "SIGKILL")
        const hardDeadline = Date.now() + 3_000
        while (alive && Date.now() < hardDeadline) {
          await sleep(250)
          alive = isAlive(pid)
        }
      }
      if (alive) {
        audit(`give-up-kill：pid=${pid} 无法终止（权限/系统级），本次不拉起`)
        return { action: "give-up", detail: `pid=${pid} 无法终止`, killedPid: null, spawnedPid: null }
      }
      killedPid = pid
    }
    // design §3.9.1 监督矩阵行 2「无锁 / 锁 pid 已死 → 清锁 → 拉起」：
    // 死 bot 的锁文件由监督者在拉起前清理。否则刚死（锁 mtime<30s）时
    // 新实例 try 模式判锁新鲜而拒绝接管，本轮拉起空转，须再等一个巡检周期。
    // 甲乙统一（2026-11-20 owner 批「修甲乙」）：单进程多角色持多把锁——
    // 杀进程即按 pid 清扫其持有的全部实例锁（锁即进程，调用方不再记角色名单；
    // 多角色改造前只清单把，残留锁曾把 restart 的新实例弹飞——ceshi 僵尸锁
    // 挡道 11-20 激活亲历）。已知锁路径兜底直删，兼容非 openqq-* 命名与
    // pid 读不到的边角。
    try {
      const locksDir = dirname(deps.paths.lockPath)
      let cleared: string[] = []
      if (killedPid !== null) {
        cleared = releaseLocksOfPid(killedPid, locksDir)
      } else if (health.pidAlive === false && health.lockPid !== null) {
        cleared = releaseLocksOfPid(health.lockPid, locksDir)
      }
      if (existsSync(deps.paths.lockPath)) {
        try {
          unlinkSync(deps.paths.lockPath)
          if (!cleared.includes(deps.paths.lockPath)) cleared.push(deps.paths.lockPath)
        } catch {
          /* 锁不存在或删除失败：新实例 try 模式仍按 mtime 仲裁，不阻断拉起 */
        }
      }
      if (cleared.length > 0) audit(`清锁：${cleared.join("、")}（${action.reason}）`)
    } catch {
      /* 清锁失败不阻断拉起 */
    }
    const spawnedPid = deps.spawn()
    state.restartLog.push(Date.now())
    state.restartLog = state.restartLog.filter((t) => t > Date.now() - policy.windowMs * 2)
    try {
      writeFileSync(statePath, JSON.stringify(state))
    } catch {
      log("[supervisor] 强度账落盘失败（不影响本次拉起）")
    }

    // ===== 拉起后存活确认（DEF-20261120 墙二次追击层）=====
    // 背景（2026-11-20 修订时更正注记）：立项时引用的「11-20 15:17 主杀后拉起 7001
    // 秒死」实系 lock-sweep 测试泄漏的假审计行（假 pid 7001，已在测试补 auditLogPath
    // 隔离后根治）——该时刻真实 bot 存活。本层保留立项，因为「拉起后秒死」这一失败类
    // 当日真实存在（早晨 8ms 速死群，根因未钉、仪器已埋）：监督者要等下轮巡检
    //（计划任务 3min/常驻 10min）才能再拉，期间 bot 继续失能；若死因未消（dist
    // 混合态等），将进入「杀-拉-死-等-杀」的慢循环，每轮空转一个巡检周期直至 give-up。
    // 修复：拉起后立即做 10s 存活确认（进程在 + 锁建立），失败=立刻二次拉起（仅一次，
    // 防递归爆炸——二次拉起交由下轮巡检接力，与强度账协同防永动）。
    // 强度账语义不变：本函数每进场只记 1 次重启（上方 restartLog.push），存活确认
    // 的二次拉起不另记账——它是「本次重启的完整性收尾」而非新重启。
    // 测试注入：livenessCheck=false 跳过整层（fake 环境判死恒真）。
    let livenessVerdict = "alive"
    let respawnPid: number | null = null
    if (deps.livenessCheck !== false) {
      const graceWaitMs = 10_000
      await sleep(graceWaitMs)
      const liveness = readBotHealth(deps.paths, Date.now())
      if (!isPidAlive(spawnedPid) || liveness.lockPid === null) {
        // 拉起失败两种形态：进程即死（spawn 竞态/依赖缺失）或进程在但 10s 内锁未建立
        //（启动路径卡死——等价于「生而无魂」）。先清残留锁再二次拉起，防 try 锁挡道。
        livenessVerdict = `dead-after-spawn（10s 复核：进程${isPidAlive(spawnedPid) ? "在但锁未建立" : "已退出"}）`
        audit(`二次追击：拉起 pid=${spawnedPid} 失败（${livenessVerdict}），立即重拉`)
        try {
          const locksDir2 = dirname(deps.paths.lockPath)
          let cleared2: string[] = []
          if (!isPidAlive(spawnedPid) && existsSync(deps.paths.lockPath)) {
            cleared2 = releaseLocksOfPid(spawnedPid, locksDir2)
          }
          if (existsSync(deps.paths.lockPath)) {
            try {
              unlinkSync(deps.paths.lockPath)
              if (!cleared2.includes(deps.paths.lockPath)) cleared2.push(deps.paths.lockPath)
            } catch { /* mtime 仲裁兜底 */ }
          }
          if (cleared2.length > 0) audit(`清锁：${cleared2.join("、")}（二次追击前清场）`)
        } catch { /* 清锁失败不阻断二次拉起 */ }
        respawnPid = deps.spawn()
        // 二次拉起同样确认（但不再追击——三次交下轮巡检，防递归）
        await sleep(graceWaitMs)
        const liveness2 = readBotHealth(deps.paths, Date.now())
        if (!isPidAlive(respawnPid) || liveness2.lockPid === null) {
          livenessVerdict += `；二次拉起 pid=${respawnPid} 仍失败——交下轮巡检接力（强度账 ${state.restartLog.length}/${policy.maxRestarts}）`
        } else {
          livenessVerdict += `；二次拉起 pid=${respawnPid} 成功`
        }
      }
    }
    // 诛杀审计（决策可审计三问全要素）：杀戮级动作落 kills.log 专线
    if (killedPid !== null || livenessVerdict !== "alive") {
      appendKillLog({
        kind: "decision",
        reason: action.reason,
        health: {
          lockPid: health.lockPid,
          pidAlive: health.pidAlive,
          heartbeatAgeMs: health.heartbeatAgeMs,
          lockAgeMs: health.lockAgeMs,
        },
        killedPid,
        killEscalation: killedPid !== null ? "TERM" : "n/a",
        spawnedPid: respawnPid ?? spawnedPid,
        restartIntensity: `${state.restartLog.length}/${policy.maxRestarts}`,
        livenessVerdict: livenessVerdict !== "alive" ? livenessVerdict : "alive",
        at: Date.now(),
      })
    }

    const detail = `${action.reason}；${killedPid ? `已优雅停 pid=${killedPid}；` : ""}已拉起 pid=${respawnPid ?? spawnedPid}${livenessVerdict !== "alive" ? `；${livenessVerdict}` : ""}`
    // 审计分家（2026-11-09 加固红线）：「主动杀」与「验尸拉新」必须在日志里一眼可辨——
    // 历史上两者同文案导致无声死亡无法归因（2026-11-09 他杀排查实证：审计缺陷遮蔽真凶）。
    audit(killedPid ? `主动杀：${detail}` : `验尸拉新：${detail}`)
    return { action: "restart", detail, killedPid, spawnedPid: respawnPid ?? spawnedPid }
  } finally {
    release()
  }
}
