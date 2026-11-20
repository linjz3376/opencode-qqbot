// @input:  argv（--once | --loop | --interval-min N）、~/.openqq 锁/心跳、core/watchdog(superviseOnce)、core/bot-control
// @output: (side-effect) 巡检并在必要时重启 bot；give-up 时 QQ 告警
// @pos:    cli - 跨平台监督者入口（dist/openqq-watchdog.js）
//
// 用法：
//   node dist/openqq-watchdog.js --once            # 单次巡检（自启项/timer 调这个）
//   node dist/openqq-watchdog.js --loop            # 常驻循环（默认 10 分钟）
//   node dist/openqq-watchdog.js --interval-min 5  # 自定义周期
// 退出码：0=正常（含"健康/冷却/让行"）；1=运行时/配置错误。
//
// 2026-11-09 重构：裸 healOnce 升级为 superviseOnce——优雅杀（TERM→宽限→KILL）、
// 冷却（防互踢）、重启强度（超限 give-up 并告警，不当永动机）、监督者认领互斥。
import { botWatchdogPaths, appendWatchdogLog, superviseOnce, readBotHealth, isBotDown } from "../core/watchdog.js"
import { readAppId, startBot } from "../core/bot-control.js"
import { electSupervisor } from "../core/supervisor-election.js"
import { runNotifyCli } from "./notify.js"

const DEFAULT_INTERVAL_MIN = 10

function parseArgs(argv: string[]): { loop: boolean; intervalMin: number } {
  const loop = argv.includes("--loop")
  const idx = argv.indexOf("--interval-min")
  const raw = idx >= 0 ? Number(argv[idx + 1]) : Number.NaN
  const intervalMin = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MIN
  return { loop, intervalMin }
}

function currentAppId(): string | null {
  // readAppId 已含 QQ_BOTS 首角色回退（2026-11-20 应修尽修批）
  return readAppId()
}

/** give-up 上报：入队 QQ 通知（bot 恢复后送达）＋本进程日志；失败静默（fail-open）。 */
function alert(message: string): void {
  void runNotifyCli(["--text", message, "--id", `supervisor-giveup-${Date.now()}`]).then(
    (r) => console.log(`[supervisor] 告警已入队 user=${r.user}`),
    (error) => console.error("[supervisor] 告警入队失败:", error instanceof Error ? error.message : error),
  )
}

async function tick(appId: string): Promise<void> {
  const paths = botWatchdogPaths(appId)
  // 双触发器归一（2026-11-20 owner 批）：service 与 plugin 两通道租约选主。
  // 破格条款（11-20 灵魂不在线复发实证）：让贤仅当 bot 健康——bot 失能时无人
  // 监督的空窗比双触发干扰致命（14:56-15:07 bot 死而两通道互相让贤实录）。
  if (!electSupervisor("service")) {
    if (!isBotDown(readBotHealth(paths, Date.now()))) {
      appendWatchdogLog("[supervisor] 让贤：plugin 通道持监督租约中，本轮跳过")
      return
    }
    appendWatchdogLog("[supervisor] 破格接管：plugin 持租约但 bot 失能——让贤条款不适用")
  }
  const result = await superviseOnce({
    paths,
    spawn: () => startBot(import.meta.url, (line) => console.log(line)),
    log: (line) => console.log(line),
    alert,
  })
  console.log(`[supervisor] ${result.action}：${result.detail}`)
  // 健康时静默落盘（避免每 10 分钟一行膨胀日志），异常必记
  if (result.action !== "ok") appendWatchdogLog(`[supervisor] ${result.action}：${result.detail}`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const appId = currentAppId()
  if (!appId) {
    console.error("[watchdog] 未找到任何角色凭据（~/.openqq/.env 缺 QQ_APP_ID/QQ_APP_SECRET 且 QQ_BOTS 无合法角色），无法定位实例锁")
    process.exit(1)
  }
  console.log(`[watchdog] 模式=${args.loop ? `loop/${args.intervalMin}min` : "once"}（监督矩阵：冷却2m/强度3次15m/优雅杀8s）`)
  await tick(appId)
  if (!args.loop) return
  const timer = setInterval(() => {
    void tick(appId).catch((error) => {
      appendWatchdogLog(`[watchdog] 巡检失败: ${error instanceof Error ? error.message : String(error)}`)
      console.error("[watchdog] 巡检失败:", error instanceof Error ? error.message : error)
    })
  }, args.intervalMin * 60_000)
  const stop = (): void => {
    clearInterval(timer)
    process.exit(0)
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

void main().catch((error) => {
  appendWatchdogLog(`[watchdog] 致命错误: ${error instanceof Error ? error.message : String(error)}`)
  console.error("[watchdog] 致命错误:", error instanceof Error ? error.message : error)
  process.exit(1)
})
