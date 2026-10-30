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

fs.mkdirSync(CONFIG_DIR, { recursive: true })
fs.writeFileSync(ENV_FILE, merged.join("\n"))
console.log(`凭据已写入 ${ENV_FILE}`)
console.log("现在可以运行 openqq 启动 bot 了。")
