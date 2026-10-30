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
import { isInstanceAlive } from "./core/instance-lock.js"
import { resolveRuntime, buildLaunchPlan, spawnBotDetached, resolveBotEntry, readDotEnvField, botLogPath } from "./core/bot-launcher.js"

const ENV_FILE = join(homedir(), ".openqq", ".env")
const CHECK_INTERVAL_MS = 5 * 60 * 1000 // 看门狗巡检间隔（插件重载会重置，兜底是每小时 reload）

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
        const appId = readDotEnvField(ENV_FILE, "QQ_APP_ID")
        if (!appId) {
          warnOnce(
            "cred",
            "[opencode-qqbot] 未发现 ~/.openqq/.env 凭据——先运行 npx @linjz/opencode-qqbot setup 扫码绑定（或参考 README 手写 .env），完成后插件将在下次巡检自动拉起 bot",
          )
          return
        }
        if (isInstanceAlive(appId)) {
          lastBlocker = null // 畅通复位
          return
        }
        const entry = resolveBotEntry(fileURLToPath(import.meta.url))
        if (!entry) {
          warnOnce("entry", "[opencode-qqbot] 未找到 bot 入口（bot.js / dist/openqq-bot.js / src/index.ts 全缺）——插件安装不完整")
          return
        }
        const runtime = resolveRuntime()
        if (!runtime) {
          warnOnce("runtime", "[opencode-qqbot] 未找到 bun/node 运行时，无法拉起 bot——请安装其中之一（https://bun.sh）")
          return
        }
        const pid = spawnBotDetached(buildLaunchPlan(runtime, entry, botLogPath()))
        console.log(`[opencode-qqbot] bot 已拉起（pid=${pid}，runtime=${runtime}，entry=${entry}）`)
        lastBlocker = null
      } catch (error) {
        // 引导器永不阻断宿主
        console.error("[opencode-qqbot] 拉起失败:", error instanceof Error ? error.message : error)
      }
    }
    ensure()
    const timer = setInterval(ensure, CHECK_INTERVAL_MS)

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
