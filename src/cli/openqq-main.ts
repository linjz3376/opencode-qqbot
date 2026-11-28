// @input:  argv（restart | service ...）、core/bot-control、cli/service-main
// @output: (side-effect) 重启/自启注册/状态查询
// @pos:    cli - 运维命令入口（dist/openqq-cli.js）
//
// 用法：
//   node dist/openqq-cli.js restart [--force] [--timeout-min 60]
//   node dist/openqq-cli.js stop [--timeout-min 60]
//   node dist/openqq-cli.js service install|uninstall [--stop-bot] |status
// 2026-11-09 架构红线：取代 safe-restart.ps1 / start-openqq.ps1 / watchdog.ps1，全 TS 跨平台。
import { existsSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { restartBot, stopBot } from "../core/bot-control.js"
import {
  serviceInstall,
  serviceStatus,
  serviceUninstall,
  type CommandResult,
  type ServiceSpec,
} from "./service-main.js"
import { resolveBunCommand, locateOnPath, resolveRuntime } from "../core/bot-launcher.js"

const DEFAULT_INTERVAL_MIN = 10

function sibling(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(here, name), join(here, "..", "dist", name)]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

function runtimeCommand(): string {
  const runtime = resolveRuntime()
  if (runtime === "bun") return resolveBunCommand() ?? throwNoRuntime("bun")
  if (runtime === "node") return locateOnPath("node") ?? throwNoRuntime("node")
  throw new Error("未找到 bun/node 运行时")
}

function throwNoRuntime(kind: string): never {
  throw new Error(`未找到 ${kind} 全路径可执行体——注册动作需要全路径命令（静默红线）`)
}

function printResult(label: string, r: CommandResult): void {
  console.log(`[${label}] ${r.ok ? "OK" : "FAIL"}\n${r.detail}`)
  process.exitCode = r.ok ? 0 : 1
}

function parseFlag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? "") : null
}

async function main(): Promise<void> {
  const [cmd, sub] = process.argv.slice(2)

  if (cmd === "restart") {
    const force = process.argv.includes("--force")
    const timeoutMin = Number(parseFlag(process.argv.slice(2), "--timeout-min"))
    const res = await restartBot({
      force,
      timeoutMs: Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin * 60_000 : undefined,
      spawnFromUrl: import.meta.url,
      log: (line) => console.log(line),
    })
    console.log(`[restart] ${res.action}（${res.reason}）killed=${res.killedPid ?? "-"} spawned=${res.spawnedPid ?? "-"}`)
    process.exitCode = res.action === "restarted" ? 0 : 2
    return
  }

  if (cmd === "stop") {
    const timeoutMin = Number(parseFlag(process.argv.slice(2), "--timeout-min"))
    const res = await stopBot({
      timeoutMs: Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin * 60_000 : undefined,
      log: (line) => console.log(line),
    })
    console.log(`[stop] ${res.action}（${res.reason}）killed=${res.killedPid ?? "-"}`)
    process.exitCode = res.action === "stopped" ? 0 : 2
    return
  }

  if (cmd === "service") {
    const spec: ServiceSpec = {
      runtimeCmd: runtimeCommand(),
      scriptPath: sibling("openqq-watchdog.js"),
      intervalMin: DEFAULT_INTERVAL_MIN,
    }
    if (sub === "install") return printResult("service install", serviceInstall(spec))
    if (sub === "uninstall") {
      const uninstall = serviceUninstall()
      printResult("service uninstall", uninstall)
      if (!process.argv.includes("--stop-bot")) return
      // --stop-bot 是完整停用语义：自启注销失败（含任务本就不存在）不得阻断 bot 停止；
      // 退出码反映两步结果——都成 0，仅停止成 1，停止未成 2。
      const stop = await stopBot({
        timeoutMs: (() => {
          const timeoutMin = Number(parseFlag(process.argv.slice(2), "--timeout-min"))
          return Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin * 60_000 : undefined
        })(),
        log: (line) => console.log(line),
      })
      console.log(`[stop] ${stop.action}（${stop.reason}）killed=${stop.killedPid ?? "-"}`)
      process.exitCode = stop.action === "stopped" ? (uninstall.ok ? 0 : 1) : 2
      return
    }
    if (sub === "status") {
      const r = serviceStatus()
      return printResult("service status", {
        ok: r.ok,
        detail: `runtime=${spec.runtimeCmd}\nscript=${spec.scriptPath}\n${r.detail}`,
      })
    }
    console.error("用法：openqq service install|uninstall [--stop-bot]|status")
    process.exitCode = 2
    return
  }

  console.error("用法：openqq-cli restart [--force] [--timeout-min N] | stop [--timeout-min N] | service install|uninstall [--stop-bot]|status")
  process.exitCode = 2
}

void main().catch((error) => {
  console.error("[openqq-cli] 执行失败:", error instanceof Error ? error.message : error)
  process.exit(1)
})
