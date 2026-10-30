// @input:  ./config, ./opencode/*, ./qq/*, ./bridge, @opencode-ai/sdk (createOpencodeServer)
// @output: (side-effect) 启动 Bot 进程
// @pos:    根层 - 入口: 启动编排 + 优雅关闭
import { loadConfig, ensureConfig } from "./config.js"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { createClient, healthCheck, type OpencodeClient } from "./opencode/client.js"
import { discoverOpencode, persistDiscovery } from "./core/discovery.js"
import { startLinkWatch } from "./core/linkwatch.js"
import { getAccessToken, sendC2CMessage, getNextMsgSeq } from "./qq/api.js"
import { SessionManager } from "./opencode/sessions.js"
import { startGateway } from "./qq/gateway.js"
import { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./qq/api.js"
import { createBridge } from "./bridge.js"
import { waitInstanceLock, INSTANCE_LOCK_DISABLED_ENV, type InstanceLock } from "./core/instance-lock.js"

// O1（2026-10-15）：开机竞态退避等待——桌面服务未就绪时 20s 重试、15 分钟
// 上限。今晨实证（09:04–09:31）：fail-fast 秒退 → 看门狗 10 分钟粒度空转 4 次；
// 退避后服务就绪即起，不再依赖下个看门狗 tick。
// HC1（2026-10-26）：2.1.3 服务端口动态化（实证 49374→28894）。连不上时在
// 第 1/4/7… 次重试前触发回环端口签名扫描，命中即重建 client 并落盘
// ~/.openqq/last-discovered.json。.env 配置仍是第一优先，配置可达时零扫描。
async function waitForOpencode(
  clientFactory: (url: string) => OpencodeClient,
  initialUrl: string,
): Promise<OpencodeClient> {
  const deadline = Date.now() + 15 * 60 * 1000
  let attempt = 0
  let url = initialUrl
  let client = clientFactory(url)
  for (;;) {
    try {
      await healthCheck(client)
      return client
    } catch (error) {
      attempt++
      if (Date.now() >= deadline) throw error
      console.log(
        `[index] OpenCode 未就绪（第 ${attempt} 次）：${error instanceof Error ? error.message : error} —20s 后重试`,
      )
      if (attempt === 1 || attempt % 3 === 0) {
        const found = await discoverOpencode({ password: process.env.OPENCODE_PASSWORD })
        if (found && found.baseUrl !== url) {
          console.log(`[index] 端口漂移自动发现：${url} → ${found.baseUrl}（v${found.version}），改用之`)
          persistDiscovery(found)
          url = found.baseUrl
          client = clientFactory(url)
        }
      }
      await new Promise((r) => setTimeout(r, 20_000))
    }
  }
}

async function main(): Promise<void> {
  await ensureConfig()
  const config = loadConfig()

  // M 项（2026-10-30，吸收竞品 proper-lockfile 方案零依赖手写）：单实例锁防多开——
  // 双实例同 bot 会被 QQ 网关互踢。后到实例待命轮询，宿主退出/暴毙（30s 僵尸判定）
  // 后自动接管。QQ_INSTANCE_LOCK=false 可关闭（如部署层已有单实例语义）。
  let instanceLock: InstanceLock | null = null
  if (process.env[INSTANCE_LOCK_DISABLED_ENV] !== "false") {
    instanceLock = await waitInstanceLock(config.qq.appId)
  }

  if (!config.opencode.baseUrl) {
    throw new Error("缺少 OPENCODE_BASE_URL，指向 OpenCode 桌面版 API（如 http://127.0.0.1:<端口>/api；2.1.x 端口动态，失联时启动流程会自动发现）")
  }

  const client = await waitForOpencode((u) => createClient(u), config.opencode.baseUrl)

  startBackgroundTokenRefresh(config.qq.appId, config.qq.clientSecret)

  const sessions = new SessionManager(client)
  const bridge = createBridge(config, client, sessions)
  const { eventStream } = bridge

  // HC2（2026-10-26）：运行中链路自愈巡检 + QQ 告警。
  // 告警走主动消息（allowlist 首个用户），markdown 失败回退纯文本；
  // 去重由 linkwatch 状态机保证（每事故 open + fixed 各 ≤1 条）。
  const alarm = async (text: string): Promise<void> => {
    const uid = config.allowedUsers[0]
    if (!uid) return
    const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    const seq = getNextMsgSeq("")
    try {
      await sendC2CMessage(token, uid, text, undefined, seq, true)
    } catch (error) {
      console.warn("[index] 告警 markdown 发送失败，回退纯文本:", error instanceof Error ? error.message : error)
      await sendC2CMessage(token, uid, text, undefined, seq, false)
    }
  }
  const linkWatch = startLinkWatch({ client, onRebase: (url) => eventStream.rebase(url), alarm })

  const gateway = await startGateway({
    appId: config.qq.appId,
    clientSecret: config.qq.clientSecret,
    onMessage: bridge.handleMessage,
    onInteraction: (event) => bridge.handleInteraction(event),
    onReady: () => {
      console.log("[index] QQ Gateway 已就绪")
    },
  })

  console.log("[index] OpenCode QQ Bot 已启动")

  // R 项（2026-10-30）：启动对账——恢复重启窗口内"已派发未回答"的在途回合
  //（补投答案/重挂后台等待/重派丢失消息）。异步执行不阻塞心跳建立。
  void bridge.recoverInflightRounds()

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
    instanceLock?.release()
    linkWatch.stop()
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
  process.exit(1) // 锁文件随之成僵尸，30s 后待命实例自动接管
})
