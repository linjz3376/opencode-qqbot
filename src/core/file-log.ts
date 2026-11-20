// @input:  fs（追加写）
// @output: installFileLog, fileLogStatus, formatLocalTimestamp
// @pos:    core - 可选文件日志双写（QQ_LOG_FILE 环境变量开启；2026-11-05 起默认开启）
//
// 背景（2026-10-30 清债 P2）：插件拉起的 detached bot 无控制台，bun 子进程 fd
// 重定向实测不落盘（bot.out.log 0 字节）——改为 bot 进程内 console 双写，
// 不依赖 spawn 侧 fd 语义，跨运行时（bun/node）确定生效。
// 轮转：2026-11-20 起归 core/log-rotate.ts 统一管辖（20MB/保留 4 代/总预算 100MB，
// env QQ_LOG_MAX_MB / QQ_LOG_KEEP / QQ_LOG_TOTAL_MB 可调）——与 watchdog 审计写同一
// 文件 ~/.openqq/openqq.log，一个阈值管全部。
// 2026-11-05：install 返回卸载函数不变；新增 fileLogStatus() 供 /status 展示
// 「日志最后写入时间」，堵住"日志 17:17 后无写入却无人发现"的观测缺口。
import { appendFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join } from "path"
import { inspect } from "util"
import { enforceLogBudget, logLimitsFromEnv, rotateLogIfNeeded } from "./log-rotate.js"

interface ActiveLog {
  path: string
  lastWriteAt: number
}

let active: ActiveLog | null = null

/** 本地时区时间戳（含偏移，如 2026-11-05T21:09:09.292+08:00）——2026-11-05 用户反馈：
 *  日志全是 UTC（Z 结尾），与本地时钟差 8 小时，排障要对表。统一改本地。 */
export function formatLocalTimestamp(d = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0")
  const offMin = -d.getTimezoneOffset() // 本地超前 UTC 的分钟数（中国 = +480）
  const sign = offMin >= 0 ? "+" : "-"
  const abs = Math.abs(offMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 当前生效的文件日志（未安装返回 null）。 */
export function fileLogStatus(): { path: string; lastWriteAt: number } | null {
  return active ? { ...active } : null
}

/** console.log/warn/error 双写到文件；返回卸载函数（测试用） */
export function installFileLog(logPath: string): () => void {
  try {
    mkdirSync(join(logPath, ".."), { recursive: true })
  } catch {
    /* 目录已存在或不可建——写时再兜底 */
  }
  const state: ActiveLog = { path: logPath, lastWriteAt: 0 }
  active = state
  const limits = logLimitsFromEnv()
  const write = (level: string, args: unknown[]): void => {
    try {
      // 轮转+预算闸由 log-rotate 统一管辖；statSync 每行一次沿用既有代价口径
      if (existsSync(logPath) && statSync(logPath).size > limits.maxBytes) {
        if (rotateLogIfNeeded(logPath, limits)) enforceLogBudget(logPath, limits)
      }
      // 2026-11-20 修：非字符串参数用 util.inspect（JSON.stringify(Error)=="{}" 会把
      // 错误消息与堆栈整个吞掉——11-20 启动失败 {} 事故的根因级教训）；breakLength
      // 拉满保持单行，不破坏行级日志结构。
      const line = args
        .map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, maxStringLength: 500, breakLength: Infinity, colors: false })))
        .join(" ")
      appendFileSync(logPath, `${formatLocalTimestamp()} [${level}] ${line}\n`, { mode: 0o600 })
      state.lastWriteAt = Date.now()
    } catch {
      // 日志绝不阻断主流程
    }
  }
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }
  console.log = (...args: unknown[]) => { orig.log(...args); write("log", args) }
  console.warn = (...args: unknown[]) => { orig.warn(...args); write("warn", args) }
  console.error = (...args: unknown[]) => { orig.error(...args); write("error", args) }
  return () => {
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
    if (active === state) active = null
  }
}
