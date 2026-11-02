// 一键安装到全局插件目录（2026-11-02 改版：全量包安装，用户拍板形态）：
//   ~/.config/opencode/plugins/opencode-qqbot/ = npm 发布包的完整解包
//   （package.json + bin/ + src/ + dist/ + README + tsconfig）
// 即"模拟插件形态"：整个安装物就是一个官方插件目录；插件加载走 exports "."，
// 独立服务由插件从包内 dist/openqq-bot.js 拉起，全部文件自足，不引用任何外部路径。
// 手段：npm pack（触发 prepublishOnly 构建 dist）+ tar 解包（与应用者收到的内容逐字节一致）。
import { rmSync, mkdirSync, readdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { spawnSync } from "child_process"

const targetDir = join(homedir(), ".config", "opencode", "plugins", "opencode-qqbot")
const repo = process.cwd()

// 1. 打包（prepublishOnly 自动构建 dist 双产物）
const pack = spawnSync("npm", ["pack"], { cwd: repo, encoding: "utf-8" })
if (pack.status !== 0) {
  console.error("npm pack 失败：", pack.stderr || pack.stdout)
  process.exit(1)
}
const tgz = pack.stdout.trim().split("\n").pop()
console.log(`打包完成：${tgz}`)

// 2. 清空目标目录（含旧单文件/双 bundle 形态残留）并重建
rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })

// 3. 解包（-C 目标目录本身 + strip package/ 前缀；tar=系统 bsdtar，Win10+ 自带）
const tar = spawnSync("tar", ["-xzf", join(repo, tgz), "-C", targetDir, "--strip-components=1"], {
  encoding: "utf-8",
})
rmSync(join(repo, tgz), { force: true })
if (tar.status !== 0) {
  console.error("解包失败：", tar.stderr)
  process.exit(1)
}

const installed = readdirSync(targetDir)

// 4. loader 友好化覆盖（2026-11-02 实证定案）：2.2.1 全局插件目录扫描器对目录
//    插件的 exports 解析有洞——只认根级目标（./index.js 命中，./dist/xxx.js 跳过）。
//    因此安装态 package.json 用最小形态指根 index.js（npm 包内的 exports→dist 不受影响，
//    走 plugins 数组解析的 npm 用户照常用 dist bundle）。
import { writeFileSync } from "fs"
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
// 根 shim：扫描器命中的入口，转发到包内 dist bundle
writeFileSync(
  join(targetDir, "index.js"),
  '// 自动扫描 shim（2.2.1 全局目录扫描器只认根级 exports 目标，实证见复盘档）\nexport { default } from "./dist/opencode-qqbot-plugin.js"\n',
)

console.log(`已安装到 ${targetDir}`)
console.log(`内容：${installed.concat("package.json(loader 友好形态)", "index.js(shim)").join(", ")}`)
