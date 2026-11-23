// 安装仓库 git 钩子：core.hooksPath -> scripts/hooks（commit-msg 落点闸）。
// 每台克隆后的开发机执行一次：bun run hooks:install
// 依据：2026-11-23 一次性缺陷报告误入 docs/，规则层歧义需机械兜底。
import { execFileSync } from "node:child_process"

try {
  execFileSync("git", ["config", "core.hooksPath", "scripts/hooks"], { stdio: "inherit" })
  console.log("[hooks] core.hooksPath = scripts/hooks（commit-msg 落点闸已生效）")
} catch (error) {
  console.error("[hooks] 安装失败:", error instanceof Error ? error.message : error)
  process.exit(1)
}
