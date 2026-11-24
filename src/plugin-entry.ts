// @input:  ./core/instance-lock（存活观测）, ./core/bot-launcher（拉起）
// @output: default（Plugin.define server 入口）
// @pos:    根层 - D 路径插件入口：安装即常驻的引导器
//
// D 路径（2026-10-30 用户拍板）：插件只做引导器+看门狗，bot 本体永远是
// detached 独立进程。spike 实证"插件约每小时被重载"在此形态下反转为免费巡检：
// 每次 setup 重跑=一次存活检查。插件 unload 绝不碰 bot。
// 多 location 并发加载（spike 实证 3 连实例）：靠 bot 侧 try 模式文件锁仲裁——
// 只有第一个被拉起的 bot 持锁存活，其余自动退出。
import { Plugin } from "@opencode/plugin"
import { join } from "path"
import { homedir } from "os"
import { appendFileSync, existsSync, renameSync, statSync } from "fs"
import { fileURLToPath } from "url"
import { botWatchdogPaths, superviseOnce, appendWatchdogLog } from "./core/watchdog.js"
import { startBot } from "./core/bot-control.js"
import { runNotifyCli } from "./cli/notify.js"
import { readDotEnvField } from "./core/bot-launcher.js"
import { electSupervisor } from "./core/supervisor-election.js"
import { executeQQSendFile } from "./core/send-requests.js"
import { syncQQInstructions } from "./core/qq-instructions.js"

const ENV_FILE = join(homedir(), ".openqq", ".env")
const CHECK_INTERVAL_MS = (() => {
  const n = Number(process.env.QQ_WATCHDOG_INTERVAL_MS ?? "300000")
  return Number.isFinite(n) && n > 0 ? n : 300_000
})() // 看门狗巡检间隔（env QQ_WATCHDOG_INTERVAL_MS 可调；插件重载会重置，兜底是每小时 reload）

// —— 事件探针（2026-10-30 自 qqbot-event-probe.ts 并入，默认关）——
// 原独立探针已完成 spike 取证使命（form/permission 事件流实证）；保留为可选诊断：
// ~/.openqq/.env 里 QQ_EVENT_PROBE=true 开启，全量事件 {ts,type,sessionID} 落
// ~/.openqq/opencode-events.jsonl（5MB 轮转，不记正文=零泄密面）。
const PROBE_FILE = join(homedir(), ".openqq", "opencode-events.jsonl")
const PROBE_ROTATE_BYTES = 5 * 1024 * 1024

function probeAppend(line: string): void {
  try {
    if (existsSync(PROBE_FILE) && statSync(PROBE_FILE).size > PROBE_ROTATE_BYTES) {
      renameSync(PROBE_FILE, PROBE_FILE + ".1")
    }
    appendFileSync(PROBE_FILE, line + "\n")
  } catch {
    // 探针永不阻断宿主
  }
}

export default Plugin.define({
  id: "opencode-qqbot",
  setup(_ctx) {
    // P3（2026-10-30 清债）：阻塞原因告警只在"状态变化"时打——插件每小时重载
    // + 5min 巡检，缺凭据/无运行时不处理会重复喷日志。恢复畅通时复位。
    let lastBlocker: string | null = null
    const warnOnce = (key: string, message: string): void => {
      if (lastBlocker === key) return
      lastBlocker = key
      console.warn(message)
    }
    const ensure = (): void => {
      try {
        // 2026-11-20 应修尽修批：legacy 字段缺省时回退 QQ_BOTS 首角色（纯多角色部署）
        const botsRaw = readDotEnvField(ENV_FILE, "QQ_BOTS")
        let botsFirst: string | null = null
        if (botsRaw) {
          try {
            const arr = JSON.parse(botsRaw) as Array<{ appId?: unknown }>
            const first = Array.isArray(arr) ? arr[0]?.appId : undefined
            if (typeof first === "string" && first) botsFirst = first
          } catch {
            /* 坏 JSON 视为无 */
          }
        }
        const appId = readDotEnvField(ENV_FILE, "QQ_APP_ID") ?? botsFirst
        if (!appId) {
          warnOnce(
            "cred",
            "[opencode-qqbot] 未发现 ~/.openqq/.env 凭据——先运行 npx @linjz/opencode-qqbot setup 扫码绑定（或参考 README 手写 .env），完成后插件将在下次巡检自动拉起 bot",
          )
          return
        }
        // QQ 系统级指令同步（2026-11-24 owner 批准）：entry 优先/hook 降级，状态文件驱动
        // bridge 停用 prompt 正文注入——与 supervisor 租约无关，任何存活实例都可幂等同步。
        void syncQQInstructions(_ctx as never).catch((error) => {
          console.warn("[opencode-qqbot] QQ 系统指令同步失败（下周期重试）:", error instanceof Error ? error.message : error)
        })
        // 双触发器归一（2026-11-20 owner 批）：service（计划任务看门狗）与 plugin
        // （本引导器巡检）租约选主——service 持租约时整轮让贤，连 superviseOnce
        // 都不进（零干扰）；service 停排/死亡后租约过期自动接管，双向自愈。
        if (!electSupervisor("plugin")) return
        // 2026-11-09 重构：巡检升级为 superviseOnce（与计划任务同一监督矩阵 + 认领互斥）：
        // 优雅杀/冷却/重启强度超限 give-up 并告警，杜绝裸「杀旧拉新」循环。
        void superviseOnce({
          paths: botWatchdogPaths(appId),
          spawn: () => startBot(fileURLToPath(import.meta.url), (line) => console.log(line)),
          log: (line) => console.log(line),
          alert: (message) => {
            console.warn(message)
            void runNotifyCli(["--text", message, "--id", `supervisor-giveup-${Date.now()}`]).catch(() => {})
          },
        })
          .then((result) => {
            if (result.action === "restart") {
              console.log(`[opencode-qqbot] bot 已拉起（${result.detail}）`)
            }
            if (result.action === "ok" || result.action === "restart") lastBlocker = null
          })
          .catch((error) => {
            // 2026-11-20 修：静默消除——巡检失败只进引擎 console 曾造成 6 分钟无人拉活空窗无人知
            appendWatchdogLog(`[plugin] 巡检失败: ${error instanceof Error ? error.message : String(error)}`)
            console.error("[opencode-qqbot] 巡检失败:", error instanceof Error ? error.message : error)
          })
      } catch (error) {
        // 引导器永不阻断宿主
        console.error("[opencode-qqbot] 拉起失败:", error instanceof Error ? error.message : error)
      }
    }
    ensure()
    const timer = setInterval(ensure, CHECK_INTERVAL_MS)

    // qq_send_file 工具注册（2026-11-23 owner 批准）：AI 出站发文件从「QQ_SEND_FILE 魔法标记」
    // 升级为一等工具——模型在工具清单读到 schema 与精确错误，不再猜标记/猜路径。
    // 传输=文件队列（core/send-requests），bot 进程消费并回执；权威白名单校验在 bot 侧。
    // 特性探测：旧引擎无 ctx.tool.transform 时静默降级（标记通道仍可用），不阻断宿主。
    const toolApi = (_ctx as unknown as {
      tool?: {
        transform?: (cb: (editor: {
          namespace?: (ns: { name: string; description: string }) => void
          add: (def: {
            name: string
            description: string
            input: Record<string, unknown>
            options?: Record<string, unknown>
            execute: (input: { path: string; caption?: string }, context: { sessionID: string; signal?: AbortSignal }) => Promise<{ content: string }>
          }) => void
        }) => void) => Promise<unknown>
      }
    }).tool
    if (toolApi?.transform) {
      void toolApi.transform((editor) => {
        editor.namespace?.({ name: "qq", description: "QQ 消息通道工具（发送到当前会话绑定的 QQ 用户）" })
        editor.add({
          name: "send_file",
          description:
            "把本机文件/图片发送到当前会话绑定的 QQ 用户。path=本机绝对路径（须在发送白名单内，默认 QQ 图片缓存目录与 bot 工作目录，QQ_SEND_EXTRA_ROOTS 可扩）。失败返回精确原因（含白名单根目录/拒识类型），修正后可重试；相同文件重复调用自动去重。",
          input: {
            type: "object",
            properties: { path: { type: "string" }, caption: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
          options: { namespace: "qq", codemode: true },
          execute: async (input, context) => ({ content: await executeQQSendFile(input, context) }),
        })
      }).catch((error) => {
        console.warn("[opencode-qqbot] qq_send_file 注册失败（降级为 QQ_SEND_FILE 标记通道）:", error)
      })
    }

    // 事件探针（可选，默认关）：QQ_EVENT_PROBE=true 时订阅全量事件流落盘
    let probeAbort: AbortController | null = null
    if (readDotEnvField(ENV_FILE, "QQ_EVENT_PROBE") === "true") {
      probeAbort = new AbortController()
      const signal = probeAbort.signal
      void (async () => {
        probeAppend(JSON.stringify({ ts: new Date().toISOString(), type: "probe.started", sessionID: null }))
        try {
          for await (const event of _ctx.event.subscribe({ signal })) {
            const ev = event as { type: string; data?: { sessionID?: string } }
            probeAppend(
              JSON.stringify({ ts: new Date().toISOString(), type: ev.type, sessionID: ev.data?.sessionID ?? null }),
            )
          }
        } catch {
          // abort 即退出（插件卸载路径）
        }
      })()
      console.log("[opencode-qqbot] 事件探针已开启（QQ_EVENT_PROBE=true）")
    }

    // 卸载只停巡检与探针——bot 是独立进程，继续存活（D 路径核心语义）
    return () => {
      clearInterval(timer)
      probeAbort?.abort()
    }
  },
})
