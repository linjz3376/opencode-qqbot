// @input:  fs、环境变量（QQ_LOG_MAX_MB / QQ_LOG_KEEP / QQ_LOG_TOTAL_MB）
// @output: logLimitsFromEnv, rotateLogIfNeeded, enforceLogBudget
// @pos:    core - 统一日志滚动与预算闸（2026-11-20 owner 批「openqq.log 合并批」）
//
// 背景：bot 双写日志（openqq.log/bot.out.log 同源）+ watchdog 审计（watchdog.log）
// 三路各自为政、零预算约束。合并后单文件由本模块统一管辖：
//   滚动：active 超 QQ_LOG_MAX_MB（默认 20MB）→ 依次改名 .1←active、.2←.1…，
//         超过 QQ_LOG_KEEP（默认 4）代的最旧档直接删除。
//   预算：openqq.log* 全部世代合计超 QQ_LOG_TOTAL_MB（默认 100MB）时，从最旧
//         世代起删到达标——正常滚动下结构上限 20×(4+1)=100MB 天然达标，本闸
//         兜「调参后遗留大文件 / 脏命名」异常态。
// 并发：bot 与 watchdog 双进程同写一个文件，轮转的 rename/rm 竞态全程容忍
//（try/catch，失败即本轮放弃，下个写者再试），绝不阻断日志与主流程。
import { existsSync, renameSync, rmSync, statSync } from "fs"

export interface LogLimits {
  maxBytes: number
  keepBackups: number
  totalBudgetBytes: number
}

const MB = 1024 * 1024

const num = (v: string | undefined, d: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}

export function logLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): LogLimits {
  return {
    maxBytes: num(env.QQ_LOG_MAX_MB, 20) * MB,
    keepBackups: Math.floor(num(env.QQ_LOG_KEEP, 4)),
    totalBudgetBytes: num(env.QQ_LOG_TOTAL_MB, 100) * MB,
  }
}

/** 超阈轮转：active→.1→.2…，超 keepBackups 的最旧档先删。返回本轮是否轮转过。 */
export function rotateLogIfNeeded(logPath: string, limits: LogLimits = logLimitsFromEnv()): boolean {
  try {
    if (!existsSync(logPath) || statSync(logPath).size <= limits.maxBytes) return false
    try {
      rmSync(`${logPath}.${limits.keepBackups}`, { force: true })
    } catch {
      /* 最旧档不存在或占用——容忍 */
    }
    for (let i = limits.keepBackups - 1; i >= 1; i--) {
      const from = `${logPath}.${i}`
      if (!existsSync(from)) continue
      try {
        renameSync(from, `${logPath}.${i + 1}`)
      } catch {
        /* 占用/竞态——容忍，下轮再移 */
      }
    }
    try {
      renameSync(logPath, `${logPath}.1`)
    } catch {
      return false
    }
    return true
  } catch {
    return false
  }
}

/** 总预算闸：logPath* 全世代合计超总预算时从最旧世代删起，直至达标或只剩 active。 */
export function enforceLogBudget(logPath: string, limits: LogLimits = logLimitsFromEnv()): void {
  try {
    const sizes = new Map<number, number>()
    let total = 0
    for (let i = 0; i <= 64; i++) {
      const p = i === 0 ? logPath : `${logPath}.${i}`
      if (!existsSync(p)) break
      const s = statSync(p).size
      sizes.set(i, s)
      total += s
    }
    for (let i = limits.keepBackups; i >= 1 && total > limits.totalBudgetBytes; i--) {
      const s = sizes.get(i)
      if (s === undefined) continue
      try {
        rmSync(`${logPath}.${i}`, { force: true })
        total -= s
      } catch {
        /* 占用——容忍 */
      }
    }
  } catch {
    /* 预算闸绝不阻断 */
  }
}
