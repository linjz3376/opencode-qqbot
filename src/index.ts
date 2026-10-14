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

async function main(): Promise<void> {
  await ensureConfig()
  const config = loadConfig()

  if (!config.opencode.baseUrl) {
    throw new Error("缺少 OPENCODE_BASE_URL，指向 OpenCode 桌面版 API（如 http://localhost:49374/api）")
  }

  const client = createClient(config.opencode.baseUrl)
  await healthCheck(client)

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
