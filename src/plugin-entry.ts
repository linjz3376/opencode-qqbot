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
import { fileURLToPath } from "url"
import { isInstanceAlive } from "./core/instance-lock.js"
import { resolveRuntime, buildLaunchPlan, spawnBotDetached, resolveBotEntry, readDotEnvField } from "./core/bot-launcher.js"

const ENV_FILE = join(homedir(), ".openqq", ".env")
const CHECK_INTERVAL_MS = 5 * 60 * 1000 // 看门狗巡检间隔（插件重载会重置，兜底是每小时 reload）

export default Plugin.define({
  id: "opencode-qqbot",
  setup(_ctx) {
    const ensure = (): void => {
      try {
        const appId = readDotEnvField(ENV_FILE, "QQ_APP_ID")
        if (!appId) {
          console.warn(
            "[opencode-qqbot] 未发现 ~/.openqq/.env 凭据——先运行 npx @linjz/opencode-qqbot setup 扫码绑定（或参考 README 手写 .env），完成后插件将在下次巡检自动拉起 bot",
          )
          return
        }
        if (isInstanceAlive(appId)) return // 活着，不动
        const entry = resolveBotEntry(fileURLToPath(import.meta.url))
        if (!entry) {
          console.warn("[opencode-qqbot] 未找到 bot 入口（bot.js / dist/openqq-bot.js / src/index.ts 全缺）——插件安装不完整")
          return
        }
        const runtime = resolveRuntime()
        if (!runtime) {
          console.warn("[opencode-qqbot] 未找到 bun/node 运行时，无法拉起 bot——请安装其中之一（https://bun.sh）")
          return
        }
        const pid = spawnBotDetached(buildLaunchPlan(runtime, entry))
        console.log(`[opencode-qqbot] bot 已拉起（pid=${pid}，runtime=${runtime}，entry=${entry}）`)
      } catch (error) {
        // 引导器永不阻断宿主
        console.error("[opencode-qqbot] 拉起失败:", error instanceof Error ? error.message : error)
      }
    }
    ensure()
    const timer = setInterval(ensure, CHECK_INTERVAL_MS)
    // 卸载只停巡检——bot 是独立进程，继续存活（D 路径核心语义）
    return () => clearInterval(timer)
  },
})
