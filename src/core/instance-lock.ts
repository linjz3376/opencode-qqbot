// @input:  fs/path/os（锁文件读写）
// @output: acquireInstanceLock, acquireInstanceLockAt（测试用）, waitInstanceLock, INSTANCE_LOCK_DISABLED_ENV
// @pos:    core - 单实例锁（防多开：双实例互踩 QQ 网关会互踢下线）
//
// M 项（2026-10-30，方案吸收竞品 opencode-qq-v2 的 proper-lockfile 设计，
// 零依赖手写以守"官方/三方包不进 dependencies"红线）：
//   - wx 原子创建锁文件（含 pid+启动时间），抢到即宿主
//   - 持锁者每 10s 刷新 mtime 作心跳
//   - 抢锁失败时看 mtime：超 30s 未刷新判僵尸锁（宿主崩溃）→ 删除强抢
//   - 未抢到可进入待命循环，每 5s 重试，宿主退出/暴毙后自动接管
// 锁文件按 appId 隔离：~/.openqq/openqq-<appId>.lock。
import { openSync, readFileSync, readdirSync, writeFileSync, closeSync, unlinkSync, statSync, utimesSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export const INSTANCE_LOCK_DISABLED_ENV = "QQ_INSTANCE_LOCK"

const LOCK_STALE_MS = 30_000 // 30s 无心跳 = 僵尸锁
const LOCK_UPDATE_MS = 10_000 // 持锁心跳间隔
const LOCK_RETRY_MS = 5_000 // 待命抢锁间隔
// 修复⑤（2026-11-03 定案）：持锁自检周期。背景=「暗 believer」事故：旧实例
// 心跳 touch 失败是静默的（锁文件被新实例接管/删除后自己并不知道），双 believer
// 并存造成同 msgId 并发受理（主链）。自检看锁文件里的 pid：不是自己且进程存活
// → 本实例是残留，自杀退出；锁文件消失同样说明被强抢 → 自杀。待命态无锁不检。
// P2-10（2026-11-09）：自杀判定加锁 mtime 新鲜度——真 holder 每 10s 心跳 touch；
// holder pid 存活但锁已陈旧 = 高度疑似 PID 复用（Windows pid 回收快），此时不自杀，
// 交由 stale 强抢流程正常接管（误自杀比双跑代价大，宽进严出）。
const LOCK_SELF_CHECK_MS = 60_000

export interface InstanceLock {
  /** 释放锁（清心跳 + 删锁文件），幂等 */
  release: () => void
}

function lockPathOf(appId: string): string {
  return join(homedir(), ".openqq", `openqq-${appId}.lock`)
}

/**
 * 按 pid 清扫实例锁（2026-11-20 owner 批「修甲乙」：锁即进程）。
 * 单进程多角色持多把 openqq-<appId>.lock，杀进程后应清其持有的全部锁——
 * 调用方不再记角色名单。锁文件内嵌 pid（acquireInstanceLockAt 写入），按 pid
 * 匹配精准清扫：不误清他进程锁、不碰 supervisor.lock 等非实例锁。坏锁/占用
 * 一律跳过（僵尸判定与接管仍由 mtime 机制兜底）。
 */
export function releaseLocksOfPid(pid: number, dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const cleared: string[] = []
  for (const name of names) {
    if (!/^openqq-.+\.lock$/.test(name)) continue
    const p = join(dir, name)
    try {
      const holder = JSON.parse(readFileSync(p, "utf-8")) as { pid?: unknown }
      if (holder.pid === pid) {
        unlinkSync(p)
        cleared.push(p)
      }
    } catch {
      /* 坏锁/读写竞态——跳过，mtime 僵尸机制兜底 */
    }
  }
  return cleared
}

function touch(path: string): void {
  const now = new Date()
  utimesSync(path, now, now)
}

/** 尝试抢锁一次（显式路径版，导出供测试）；成功返回 InstanceLock，被占/异常返回 null
 *  opts 仅供测试注入时序（默认行为与生产一致）：heartbeatMs 心跳间隔、selfCheckMs 自检周期 */
export function acquireInstanceLockAt(
  path: string,
  staleMs: number = LOCK_STALE_MS,
  opts?: { heartbeatMs?: number; selfCheckMs?: number },
): InstanceLock | null {
  const heartbeatMs = opts?.heartbeatMs ?? LOCK_UPDATE_MS
  const selfCheckMs = opts?.selfCheckMs ?? LOCK_SELF_CHECK_MS
  try {
    mkdirSync(join(path, ".."), { recursive: true })
    // wx = 原子排他创建，已存在则抛 EEXIST
    const fd = openSync(path, "wx")
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    closeSync(fd)
  } catch {
    // 已存在：看 mtime 判僵尸（宿主崩溃没来得及释放）
    try {
      const age = Date.now() - statSync(path).mtimeMs
      if (age <= staleMs) return null // 活着的宿主持有
      unlinkSync(path) // 僵尸锁，强抢
      const fd = openSync(path, "wx")
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), tookOverStale: true }))
      closeSync(fd)
      console.warn(`[instance-lock] 检测到僵尸锁（${Math.round(age / 1000)}s 无心跳），已接管`)
    } catch {
      return null // 竞态（另一实例先抢）/文件系统异常 → 视为被占
    }
  }

  const heartbeat = setInterval(() => {
    try {
      touch(path)
    } catch {
      /* 锁文件被外部删除时心跳失败，下轮仍试；不致命 */
    }
  }, heartbeatMs)
  // 测试场景不拖累进程退出
  heartbeat.unref?.()

  // 修复⑤：60s 周期自检——锁被他人接管/锁文件消失 → 本实例即残留 believer，自杀。
  // 判定只看锁内容里的 pid 与进程存活：pid==自己则继续；锁文件缺失=被强抢流程
  // 接管中，同样不可信 → 退出（watchdog/bot-launcher 会待命，不产生双跑）。
  const selfCheck = setInterval(() => {
    try {
      const holder = (JSON.parse(readFileSync(path, "utf-8")) as { pid?: number }).pid
      if (holder === process.pid) return
      try {
        process.kill(holder!, 0)
        // P2-10：holder 存活时分两种情况——锁新鲜=真双 believer（自杀）；锁陈旧=疑 PID 复用（不自杀）
        const lockFresh = Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS
        if (lockFresh) {
          console.error(`[instance-lock] 自检：锁已被 pid=${holder} 持有且进程存活（锁新鲜），本实例为残留 believer，自杀退出`)
          process.exit(1)
        }
        console.warn(`[instance-lock] 自检：holder pid=${holder} 存活但锁已陈旧（疑 PID 复用），不自杀，交由 stale 强抢接管`)
      } catch {
        /* holder 已死：等待其锁被 stale 逻辑回收，本实例继续自检 */
      }
    } catch {
      console.error("[instance-lock] 自检：锁文件已消失（被接管或强抢流程删除），本实例退出")
      process.exit(1)
    }
  }, selfCheckMs)
  selfCheck.unref?.()

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      clearInterval(heartbeat)
      clearInterval(selfCheck)
      try {
        unlinkSync(path)
      } catch {
        /* 已被接管/删除 */
      }
    },
  }
}

/** 尝试抢锁一次；成功返回 InstanceLock，被占/异常返回 null */
export function acquireInstanceLock(appId: string): InstanceLock | null {
  return acquireInstanceLockAt(lockPathOf(appId))
}

/** 观测锁活性（不抢锁）：锁文件存在且心跳新鲜 = bot 活着。插件引导器用。 */
export function isInstanceAlive(appId: string, staleMs: number = LOCK_STALE_MS): boolean {
  return isInstanceAliveAt(lockPathOf(appId), staleMs)
}

/** 显式路径版存活观测（导出供测试） */
export function isInstanceAliveAt(path: string, staleMs: number = LOCK_STALE_MS): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs <= staleMs
  } catch {
    return false
  }
}

// 待命日志节流（2026-10-30 清债 P3）：首次 + 之后每 120 次（=10 分钟）打一条，
// 长期待命不刷爆日志。纯函数导出供测试。
export function shouldLogStandby(attempt: number): boolean {
  return attempt === 0 || attempt % 120 === 0
}

/**
 * 阻塞式抢锁：抢不到就每 5s 重试，直到成为宿主。
 * 用于启动入口——双开时后到实例待命，宿主退出后自动接管。
 */
export async function waitInstanceLock(appId: string): Promise<InstanceLock> {
  for (let attempt = 0; ; attempt++) {
    const lock = acquireInstanceLock(appId)
    if (lock) return lock
    if (shouldLogStandby(attempt)) {
      console.log(`[instance-lock] 已有实例在运行，本实例待命（每 ${LOCK_RETRY_MS / 1000}s 重试抢锁，日志已节流）`)
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
  }
}
