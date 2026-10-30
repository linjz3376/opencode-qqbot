// @input:  fs/child_process/os（运行时探测、detached 拉起）
// @output: resolveRuntime, buildLaunchPlan, spawnBotDetached, readDotEnvField
// @pos:    core - bot 进程拉起器（D 路径：插件引导器的服务端；跨平台 Windows/Linux/macOS）
//
// 设计：插件（opencode serve 内）检测 bot 不存活时，以 detached 子进程拉起——
// 子进程脱离 serve 生命周期（serve 重载/重启不碰 bot）。运行时解析 bun→node：
// bun 直接跑源码（.js→.ts 映射）；node 跑发布时预打的 dist/openqq-bot.js bundle。
import { spawn, spawnSync } from "child_process"
import { existsSync, mkdirSync, openSync, readFileSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { fileURLToPath } from "url"

export type Runtime = "bun" | "node"

/** 探测命令可用性（跨平台：spawnSync  ENOENT=不存在） */
export function resolveRuntime(probe: (cmd: string) => boolean = defaultProbe): Runtime | null {
  if (probe("bun")) return "bun"
  if (probe("node")) return "node"
  return null
}

function defaultProbe(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore" })
    return r.status === 0
  } catch {
    return false
  }
}

export interface LaunchPlan {
  command: string
  args: string[]
  /** 子进程环境：继承当前环境 + try 模式单实例锁 */
  env: NodeJS.ProcessEnv
}

/**
 * 构造拉起计划（纯函数供测试）。
 * @param runtime 已解析的运行时
 * @param packageRoot 本包根目录（dist/bundle 优先 node 兼容；bun 可直跑 src/index.ts）
 */
export function buildLaunchPlan(runtime: Runtime, packageRoot: string): LaunchPlan {
  const bundle = join(packageRoot, "dist", "openqq-bot.js")
  const entry = runtime === "node" || !existsSync(join(packageRoot, "src", "index.ts"))
    ? bundle // node 只能跑 bundle；bun 下源码缺失（npm 裁剪）也回落 bundle
    : join(packageRoot, "src", "index.ts")
  const env = { ...process.env, QQ_INSTANCE_LOCK: "try" } // 拉起即抢锁，抢不到自动退出
  if (runtime === "bun") return { command: "bun", args: ["run", entry], env }
  return { command: "node", args: [entry], env }
}

/** 插件入口文件的包根推导（src/plugin-entry.ts → 包根） */
export function packageRootOf(importMetaUrl: string): string {
  return join(dirname(fileURLToPath(importMetaUrl)), "..")
}

/** bot 输出日志（detached 后 stdout/stderr 的唯一去向） */
export function botLogPath(): string {
  return join(homedir(), ".openqq", "bot.out.log")
}

/**
 * detached 拉起 bot（跨平台同 API；Windows 隐藏控制台窗口）。
 * 返回 pid；拉起失败抛错（调用方记日志）。
 */
export function spawnBotDetached(plan: LaunchPlan, logPath: string = botLogPath()): number {
  mkdirSync(join(logPath, ".."), { recursive: true })
  const out = openSync(logPath, "a")
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: plan.env,
    windowsHide: true,
  })
  child.unref() // 父进程（serve）退出不带走 bot
  if (typeof child.pid !== "number") throw new Error("spawn 未返回 pid")
  return child.pid
}

/** 极简 .env 字段读取（插件侧用，不经 config 模块——避免其 process.env 副作用与 throw） */
export function readDotEnvField(envPath: string, key: string): string | null {
  try {
    if (!existsSync(envPath)) return null
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq < 0) continue
      if (trimmed.slice(0, eq).trim() === key) return trimmed.slice(eq + 1).trim()
    }
    return null
  } catch {
    return null
  }
}
