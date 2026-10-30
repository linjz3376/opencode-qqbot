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
import { openSync, writeFileSync, closeSync, unlinkSync, statSync, utimesSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export const INSTANCE_LOCK_DISABLED_ENV = "QQ_INSTANCE_LOCK"

const LOCK_STALE_MS = 30_000 // 30s 无心跳 = 僵尸锁
const LOCK_UPDATE_MS = 10_000 // 持锁心跳间隔
const LOCK_RETRY_MS = 5_000 // 待命抢锁间隔

export interface InstanceLock {
  /** 释放锁（清心跳 + 删锁文件），幂等 */
  release: () => void
}

function lockPathOf(appId: string): string {
  return join(homedir(), ".openqq", `openqq-${appId}.lock`)
}

function touch(path: string): void {
  const now = new Date()
  utimesSync(path, now, now)
}

/** 尝试抢锁一次（显式路径版，导出供测试）；成功返回 InstanceLock，被占/异常返回 null */
export function acquireInstanceLockAt(path: string, staleMs: number = LOCK_STALE_MS): InstanceLock | null {
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
  }, LOCK_UPDATE_MS)
  // 测试场景不拖累进程退出
  heartbeat.unref?.()

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      clearInterval(heartbeat)
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
