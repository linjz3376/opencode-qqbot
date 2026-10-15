// @input:  ./config, ./opencode/*, ./qq/*, ./bridge, @opencode-ai/sdk (createOpencodeServer)
// @output: (side-effect) 启动 Bot 进程
// @pos:    根层 - 入口: 启动编排 + 优雅关闭
import { loadConfig, ensureConfig } from "./config.js"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { createClient, healthCheck } from "./opencode/client.js"
import { SessionManager } from "./opencode/sessions.js"
import { startGateway } from "./qq/gateway.js"
import { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./qq/api.js"
import { createBridge } from "./bridge.js"

// O1（2026-10-15）：开机竞态退避等待——桌面服务未就绪时 20s 重试、15 分钟
// 上限。今晨实证（09:04–09:31）：fail-fast 秒退 → 看门狗 10 分钟粒度空转 4 次；
// 退避后服务就绪即起，不再依赖下个看门狗 tick。
async function waitForOpencode(client: ReturnType<typeof createClient>): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000
  let attempt = 0
  for (;;) {
    try {
      await healthCheck(client)
      return
    } catch (error) {
      attempt++
      if (Date.now() >= deadline) throw error
      console.log(
        `[index] OpenCode 未就绪（第 ${attempt} 次）：${error instanceof Error ? error.message : error} —20s 后重试`,
      )
      await new Promise((r) => setTimeout(r, 20_000))
    }
  }
}

async function main(): Promise<void> {
  await ensureConfig()
  const config = loadConfig()

  if (!config.opencode.baseUrl) {
    throw new Error("缺少 OPENCODE_BASE_URL，指向 OpenCode 桌面版 API（如 http://localhost:49374/api）")
  }

  const client = createClient(config.opencode.baseUrl)
  await waitForOpencode(client)

  startBackgroundTokenRefresh(config.qq.appId, config.qq.clientSecret)

  const sessions = new SessionManager(client)
  const bridge = createBridge(config, client, sessions)

  const gateway = await startGateway({
    appId: config.qq.appId,
    clientSecret: config.qq.clientSecret,
    onMessage: bridge.handleMessage,
    onReady: () => {
      console.log("[index] QQ Gateway 已就绪")
    },
  })

  console.log("[index] OpenCode QQ Bot 已启动")

  // E4 心跳：每 60 秒写一次时间戳 = 事件循环存活证明。
  // 看门狗据此识别"进程在但僵死"的静默僵尸（2-day silent zombie 教训）。
  const heartbeatFile = join(homedir(), ".openqq", "heartbeat")
  const touchHeartbeat = (): void => {
    try {
      mkdirSync(join(homedir(), ".openqq"), { recursive: true })
      writeFileSync(heartbeatFile, String(Date.now()))
    } catch (error) {
      console.error("[index] 心跳写入失败:", error)
    }
  }
  touchHeartbeat()
  const heartbeatTimer = setInterval(touchHeartbeat, 60_000)

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[index] 收到 ${signal}，开始退出...`)
    clearInterval(heartbeatTimer)
    gateway.stop()
    stopBackgroundTokenRefresh()
    setTimeout(() => process.exit(0), 0)
  }

  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch((error) => {
  console.error("[index] 启动失败:", error)
  stopBackgroundTokenRefresh()
  process.exit(1)
})
