// @input:  node:util
// @output: formatStartupError, startupDiagnosticBundle
// @pos:    core - 启动失败可观测性（DEF-20261120-01a）
//
// 2026-11-20 事故实证：bot 拉起通道 8ms 速死，日志只有「启动失败: {}」——
// 抛出值是非 Error 对象时被 console 序列化成空对象，根因整个丢失，僵尸锁
// 自激 + 看门狗 give-up，引擎恢复后仍长期离线。本模块保证：
// ① 任何抛出值（Error / 字符串 / 任意对象）都以可读形态落日志；
// ② 附一次性环境诊断包（cwd/运行时/argv/env 键清单）——拉起通道与手工
//    环境的 delta 下次自报家门，不用远程二分。
import { inspect } from "util"

export function formatStartupError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  if (typeof error === "string") return error
  return inspect(error, { depth: 6, colors: false, maxArrayLength: 50, maxStringLength: 500 })
}

export function startupDiagnosticBundle(): string {
  return JSON.stringify({
    cwd: process.cwd(),
    execPath: process.execPath,
    argv: process.argv.slice(2),
    envKeys: Object.keys(process.env).sort(),
  })
}
