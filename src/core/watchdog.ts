// @input:  ~/.openqq 锁文件与心跳文件、process 存活探测、注入的 spawn/kill
// @output: botWatchdogPaths, readBotHealth, isPidAlive, decideWatchdog, healOnce
// @pos:    core - 跨平台看门狗（纯 Node API，无 PowerShell/OS 脚本依赖）
//
// 2026-11-09 架构红线（见 AGENTS.md）：运维代码只随插件包分发、只用 TS/JS，
// 平台差异只允许出现在「自启注册」一处。判活优先级：
//   锁文件 pid（单实例仲裁的唯一真相）+ process.kill(pid,0) + 心跳文件新鲜度。
// 约定：锁 mtime 由 bot 每 10s 刷新（instance-lock）；心跳文件由 bot 每 60s 刷新，
// 且 2026-11-09 起「抢锁后立即写」，因此「进程活但心跳陈旧」= 真僵死，不是启动中。
import { readFileSync, statSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/** 心跳超过 5 分钟未刷新 = 事件循环僵死（与既有看门狗阈值一致） */
export const HEARTBEAT_STALE_MS = 5 * 60_000
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
    return { action: "restart", reason: "心跳文件缺失（进程存活但无进展）", killPid: h.lockPid }
  }
  if (h.heartbeatAgeMs > heartbeatStaleMs) {
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

/** 追加一行巡检日志到 ~/.openqq/watchdog.log（数据目录，不是代码） */
export function appendWatchdogLog(line: string): void {
  try {
    const dir = join(homedir(), ".openqq")
    writeFileSync(join(dir, "watchdog.log"), `${new Date().toISOString()} ${line}\n`, { flag: "a" })
  } catch {
    /* 日志失败不阻断巡检 */
  }
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
      const message = `⚠️ QQBot 看门狗已放弃：${action.restarts} 次重启/${Math.round(policy.windowMs / 60_000)} 分钟仍不健康。继续自动重启没有意义（同因反复死亡），请人工检查 %TEMP%\\opencode 下 bot.out.log 与 ~/.openqq/watchdog.log。`
      audit(`give-up：${message}`)
      log(`[supervisor] give-up：${action.restarts} 次重启仍异常，停止循环并上报`)
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
    // 仅当锁 pid 已死/无锁才删（grace-kill 路径已确认死亡，killedPid 非空）。
    try {
      if (killedPid !== null || health.lockPid === null || health.pidAlive === false) {
        unlinkSync(deps.paths.lockPath)
        audit(`清锁：${deps.paths.lockPath}（${action.reason}）`)
      }
    } catch {
      /* 锁不存在或删除失败：新实例 try 模式仍按 mtime 仲裁，不阻断拉起 */
    }
    const spawnedPid = deps.spawn()
    state.restartLog.push(Date.now())
    state.restartLog = state.restartLog.filter((t) => t > Date.now() - policy.windowMs * 2)
    try {
      writeFileSync(statePath, JSON.stringify(state))
    } catch {
      log("[supervisor] 强度账落盘失败（不影响本次拉起）")
    }
    const detail = `${action.reason}；${killedPid ? `已优雅停 pid=${killedPid}；` : ""}已拉起 pid=${spawnedPid}`
    // 审计分家（2026-11-09 加固红线）：「主动杀」与「验尸拉新」必须在日志里一眼可辨——
    // 历史上两者同文案导致无声死亡无法归因（2026-11-09 他杀排查实证：审计缺陷遮蔽真凶）。
    audit(killedPid ? `主动杀：${detail}` : `验尸拉新：${detail}`)
    return { action: "restart", detail, killedPid, spawnedPid }
  } finally {
    release()
  }
}
