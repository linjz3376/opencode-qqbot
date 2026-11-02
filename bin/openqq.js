#!/usr/bin/env node
// openqq 入口（2026-11-02 应用者体验补齐）：运行时自适应——
//   有 bun → bun run src/index.ts（源码语义，dev 友好）
//   无 bun → node dist/openqq-bot.js（发布 bundle，零额外依赖）
// 应用者 npm i -g 后只有 node 也能跑；开发者有 bun 时始终跑源码。
// 注意：本文件必须保持纯 JS（无类型标注）——node 用户直接执行它。
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// bun 探测要覆盖全形态：npm 装的 bun 在 PATH 上只有 bun.ps1（CreateProcess 起不来），
// 真正可执行体在 npm\bun 包内 bin\bun.exe；官方安装则直接是 bun/bun.exe。
function detectBun() {
  const candidates = ["bun", "bun.exe", "bun.cmd", "bun.bat"]
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming")
    candidates.push(join(appdata, "npm", "node_modules", "bun", "bin", "bun.exe"))
  } else {
    candidates.push("/usr/local/bin/bun", "/opt/homebrew/bin/bun", join(process.env.HOME || "", ".bun", "bin", "bun"))
  }
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["--version"], { stdio: "ignore" })
      if (r.status === 0) return c
    } catch {
      /* 下一个 */
    }
  }
  return null
}
const bunCmd = detectBun()

const entry = bunCmd && existsSync(join(root, "src", "index.ts"))
  ? join(root, "src", "index.ts")
  : join(root, "dist", "openqq-bot.js")
const cmd = bunCmd && entry.endsWith(".ts") ? bunCmd : "node"
const args = entry.endsWith(".ts") ? ["run", entry] : [entry]

if (!existsSync(entry)) {
  console.error(`[openqq] 入口不存在：${entry}（包安装不完整，请重装 @linjz/opencode-qqbot）`)
  process.exit(1)
}
const r = spawnSync(cmd, args, { stdio: "inherit" })
process.exit(r.status ?? 1)
