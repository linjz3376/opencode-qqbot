#!/usr/bin/env node
// F 项（2026-10-30，吸收竞品 opencode-qq bin/setup.mjs 的零依赖思路）：
// 扫码绑定引导——动态 import 官方 @tencent-connect/qqbot-connector（不进
// dependencies，守红线：官方包只做参考/用户自选安装），手机 QQ 扫码拿到
// appId/appSecret 后合并写入 ~/.openqq/.env（保留其余既有配置行）。
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const CONFIG_DIR = path.join(os.homedir(), ".openqq")
const ENV_FILE = path.join(CONFIG_DIR, ".env")

let connector
try {
  connector = await import("@tencent-connect/qqbot-connector")
} catch {
  console.error("缺少依赖 @tencent-connect/qqbot-connector")
  console.error("请先执行: npm install -g @tencent-connect/qqbot-connector")
  process.exit(1)
}

console.log("请使用手机 QQ 扫描终端二维码完成绑定…")
const credsList = await connector.qrConnect({ source: "opencode-qqbot" })
const creds = credsList?.[0]
if (!creds?.appId || !creds?.appSecret) {
  console.error("扫码未返回凭据")
  process.exit(1)
}

// 合并写入 .env：替换已有 QQ_APP_ID/QQ_APP_SECRET 行，其余行原样保留
let lines = []
try {
  lines = fs.readFileSync(ENV_FILE, "utf8").split("\n")
} catch {
  /* 首次运行无文件 */
}
const seen = new Set()
const merged = lines.map((line) => {
  const m = /^\s*(QQ_APP_ID|QQ_APP_SECRET)\s*=/.exec(line)
  if (!m) return line
  seen.add(m[1])
  return m[1] === "QQ_APP_ID" ? `QQ_APP_ID=${creds.appId}` : `QQ_APP_SECRET=${creds.appSecret}`
})
if (!seen.has("QQ_APP_ID")) merged.push(`QQ_APP_ID=${creds.appId}`)
if (!seen.has("QQ_APP_SECRET")) merged.push(`QQ_APP_SECRET=${creds.appSecret}`)

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
fs.writeFileSync(ENV_FILE, merged.join("\n"), { mode: 0o600 })
console.log(`凭据已写入 ${ENV_FILE}`)

// 形态分流（2026-11-28 owner 裁定：默认插件形态安装，--standalone 显式独立部署）
const { parseSetupArgs, registerPluginForm } = await import("./setup-flavor.mjs")
const { standalone } = parseSetupArgs(process.argv.slice(2))
if (standalone) {
  console.log("独立部署形态（显式选择）：`openqq` 前台运行；常驻用 `openqq service install` 注册 OS 自启。")
  console.log("提示：service 通道在监督选举中优先于插件通道；回插件默认执行 `openqq service uninstall` 即可。")
} else {
  const r = await registerPluginForm({})
  if (!r.ok) {
    console.log("请手动完成插件注册（二选一）：")
    console.log("  1) opencode plugin add @linjz/opencode-qqbot")
    console.log('  2) 在 opencode.json(c) 的 plugins 数组加入 "@linjz/opencode-qqbot"')
  } else {
    // 存量独立部署扭转：注册只完成一半，检出 service 自启则给三步迁移指引
    const { printMigrationHintIfNeeded } = await import("./setup-flavor.mjs")
    await printMigrationHintIfNeeded({})
  }
  console.log("如确需独立部署形态（无桌面 opencode 的服务器/自管守护）：openqq-setup --standalone")
  console.log("若曾 npm i -g 安装本包：插件形态下全局副本不参与运行，可 npm uninstall -g @linjz/opencode-qqbot 清理（保留亦无冲突）。")
}
