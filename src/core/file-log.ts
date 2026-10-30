// @input:  fs（追加写）
// @output: installFileLog
// @pos:    core - 可选文件日志双写（QQ_LOG_FILE 环境变量开启）
//
// 背景（2026-10-30 清债 P2）：插件拉起的 detached bot 无控制台，bun 子进程 fd
// 重定向实测不落盘（bot.out.log 0 字节）——改为 bot 进程内 console 双写，
// 不依赖 spawn 侧 fd 语义，跨运行时（bun/node）确定生效。
// 轮转：超 5MB 改名 .1（单代备份足够排障）。
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "fs"
import { join } from "path"

const ROTATE_BYTES = 5 * 1024 * 1024

/** console.log/warn/error 双写到文件；返回卸载函数（测试用） */
export function installFileLog(logPath: string): () => void {
  try {
    mkdirSync(join(logPath, ".."), { recursive: true })
  } catch {
    /* 目录已存在或不可建——写时再兜底 */
  }
  const write = (level: string, args: unknown[]): void => {
    try {
      if (existsSync(logPath) && statSync(logPath).size > ROTATE_BYTES) {
        renameSync(logPath, `${logPath}.1`)
      }
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
      appendFileSync(logPath, `${new Date().toISOString()} [${level}] ${line}\n`)
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
  }
}
