// @input:  fs/child_process/os（运行时探测、detached 拉起）
// @output: resolveRuntime, buildLaunchPlan, spawnBotDetached, readDotEnvField
// @pos:    core - bot 进程拉起器（D 路径：插件引导器的服务端；跨平台 Windows/Linux/macOS）
//
// 设计：插件（opencode serve 内）检测 bot 不存活时，以 detached 子进程拉起——
// 子进程脱离 serve 生命周期（serve 重载/重启不碰 bot）。运行时解析 bun→node：
// bun 直接跑源码（.js→.ts 映射）；node 跑发布时预打的 dist/openqq-bot.js bundle。
import { spawn, spawnSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"

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
 * 解析 bot 入口文件（按安装形态探测，纯函数供测试）：
 * 1. 插件同目录 bot.js（plugins 目录自包含安装形态——官方规范的一键安装）
 * 2. 包根 dist/openqq-bot.js（npm 包形态，prepublish 预打）
 * 3. 包根 src/index.ts（dev 形态，需 bun 直跑 TS）
 * 全缺 → null（调用方给指引）
 */
export function resolveBotEntry(
  pluginFilePath: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const dir = dirname(pluginFilePath)
  const candidates = [
    join(dir, "bot.js"),                        // 形态 1：自包含插件目录（bot.js 是同目录兄弟）
    join(homedir(), ".openqq", "plugin-payload", "bot.js"), // 形态 1b：单文件形态的有效载荷位
    join(dir, "..", "dist", "openqq-bot.js"),   // 形态 2：npm 包（plugin-entry 在 src/ 下）
    join(dir, "..", "src", "index.ts"),         // 形态 3：dev 源码
  ]
  for (const c of candidates) if (exists(c)) return c
  return null
}

/** 构造拉起计划（纯函数供测试）。entry 由 resolveBotEntry 解析。 */
export function buildLaunchPlan(runtime: Runtime, entry: string, logPath?: string): LaunchPlan {
  // QQ_INSTANCE_LOCK=try：拉起即抢锁，抢不到自动退出（多 location 并发拉起防堆积）
  // QQ_LOG_FILE：bot 进程内文件日志双写（detached 后无控制台，fd 重定向不可靠）
  const env = {
    ...process.env,
    QQ_INSTANCE_LOCK: "try",
    ...(logPath ? { QQ_LOG_FILE: logPath } : {}),
  }
  if (runtime === "bun") return { command: "bun", args: ["run", entry], env }
  return { command: "node", args: [entry], env }
}

/** bot 输出日志（detached 后 stdout/stderr 的唯一去向） */
export function botLogPath(): string {
  return join(homedir(), ".openqq", "bot.out.log")
}

/**
 * detached 拉起 bot（跨平台同 API；Windows 隐藏控制台窗口）。
 * 日志由 bot 进程内文件双写承担（QQ_LOG_FILE，见 buildLaunchPlan）——
 * spawn 侧 fd 重定向在 bun 下实测不落盘（2026-10-30 清债 P2），不再依赖。
 * 返回 pid；拉起失败抛错（调用方记日志）。
 */
export function spawnBotDetached(plan: LaunchPlan): number {
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: "ignore",
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
