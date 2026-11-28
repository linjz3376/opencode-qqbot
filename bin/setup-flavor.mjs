// openqq-setup 形态分流（2026-11-28 owner 裁定：默认插件形态安装，--standalone 显式独立部署）。
// 纯 JS 零依赖（与 openqq-setup.mjs 同纪律）；run/log/detect 可注入供测试。
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

export const PLUGIN_PACKAGE = "@linjz/opencode-qqbot"
// 已知问题：opencode plugin add 偶发静默挂起 >3min（README 已知问题#4）——自动注册必须带超时。
export const PLUGIN_ADD_TIMEOUT_MS = 150_000

export function parseSetupArgs(argv) {
  return { standalone: argv.includes("--standalone") }
}

/** 默认实现：spawn `opencode plugin add`；CLI 缺失/非零退出/超时均归一为 { ok:false, detail }。 */
export function runPluginAdd(timeoutMs = PLUGIN_ADD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn("opencode", ["plugin", "add", PLUGIN_PACKAGE], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: true, // Windows 上 opencode 是 .cmd shim，须经 shell 解析
      })
    } catch (error) {
      resolve({ ok: false, detail: `spawn 失败：${error?.message ?? error}` })
      return
    }
    let out = ""
    child.stdout?.on("data", (d) => { out += d })
    child.stderr?.on("data", (d) => { out += d })
    let settled = false
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch { /* 已退出 */ }
      done({ ok: false, detail: `超时（>${Math.round(timeoutMs / 1000)}s，plugin add 已知偶发挂起）` })
    }, timeoutMs)
    child.on("error", (error) => done({ ok: false, detail: `opencode CLI 不可用：${error?.message ?? error}` }))
    child.on("close", (code) => {
      done(code === 0
        ? { ok: true, detail: out.trim().slice(-200) }
        : { ok: false, detail: `退出码 ${code}：${out.trim().slice(-200)}` })
    })
  })
}

/** 默认形态注册：成功 {ok:true}；任何失败（含 run 抛异常）归一 {ok:false}+原因——
 *  调用方打印手动指引，不阻断 setup 主流程。本函数永不抛出。 */
export async function registerPluginForm({ run = runPluginAdd, log = console.log } = {}) {
  log("默认形态：注册 OpenCode 插件（opencode plugin add）…")
  let r
  try {
    r = await run()
  } catch (error) {
    r = { ok: false, detail: `注册调用异常：${error?.message ?? error}` }
  }
  if (r.ok) {
    log("插件注册完成——OpenCode 在线时插件巡检自动拉起 bot（opencode plugin list 可见）。")
    return { ok: true }
  }
  log(`自动注册未成功（${r.detail}）`)
  return { ok: false }
}

/** 默认实现：经包内 CLI `service status` 判定 OS 自启是否已注册（退出码 0=已注册）。 */
export function runServiceStatus() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [join(PKG_ROOT, "dist", "openqq-cli.js"), "service", "status"], { stdio: "ignore" })
    } catch {
      resolve(1)
      return
    }
    child.on("error", () => resolve(1))
    child.on("close", (code) => resolve(code ?? 1))
  })
}

/** 检测独立部署自启（service 通道）：true=已注册。检测失败按未注册（fail-quiet，不误报迁移）。 */
export async function detectServiceAutostart({ run = runServiceStatus } = {}) {
  try {
    return (await run()) === 0
  } catch {
    return false
  }
}

/** 插件注册成功后的迁移指引（2026-11-28 owner 问「npm 默认安装能否扭转到插件形态」）：
 *  检出独立自启才打印——注册插件只完成一半，service 通道仍赢选举，必须显式摘除才归位；
 *  不自动摘除（显式动作留给用户，守「不强制扭转」红线）。返回是否打印。 */
export async function printMigrationHintIfNeeded({ detect = detectServiceAutostart, log = console.log } = {}) {
  let registered = false
  try {
    registered = await detect()
  } catch {
    registered = false
  }
  if (!registered) return false
  log("检测到本机已注册独立部署自启（service 通道优先于插件——不摘除则本次扭转不生效）：")
  log("  1) openqq service uninstall                # 摘除 OS 自启，service 通道让位")
  log("  2) openqq restart                          # 等空闲重启，此后插件巡检接管保活")
  log("  3) npm uninstall -g @linjz/opencode-qqbot  # 可选：清理旧全局副本，下次拉起即插件副本")
  return true
}
