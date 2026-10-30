// 一键安装到全局插件目录（自包含目录形态，官方插件规范）：
//   ~/.config/opencode/plugins/opencode-qqbot/
//   ├─ package.json   （name + exports "." → index.js，目录形态插件的标识）
//   ├─ index.js       （插件引导器 bundle）
//   └─ bot.js         （bot 本体 bundle，拉起时跑同目录文件，不依赖任何外部地址）
// 跨平台：纯 node/bun fs API，无 shell 命令。
import { copyFileSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const targetDir = join(homedir(), ".config", "opencode", "plugins", "opencode-qqbot")
mkdirSync(targetDir, { recursive: true })

// 清掉旧版单文件形态（若存在），避免双插件并存
const legacySingleFile = join(homedir(), ".config", "opencode", "plugins", "opencode-qqbot.js")
rmSync(legacySingleFile, { force: true })

writeFileSync(
  join(targetDir, "package.json"),
  JSON.stringify(
    {
      name: "opencode-qqbot",
      type: "module",
      exports: { ".": "./index.js" },
    },
    null,
    2,
  ) + "\n",
)
copyFileSync("dist/opencode-qqbot-plugin.js", join(targetDir, "index.js"))
copyFileSync("dist/openqq-bot.js", join(targetDir, "bot.js"))
console.log(`已安装到 ${targetDir}（index.js + bot.js + package.json）`)
