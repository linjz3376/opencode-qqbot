// @input:  fs/child_process/os（运行时探测、detached 拉起）
// @output: resolveRuntime, buildLaunchPlan, spawnBotDetached, readDotEnvField
// @pos:    core - bot 进程拉起器（D 路径：插件引导器的服务端；跨平台 Windows/Linux/macOS）
//
// 设计：插件（opencode serve 内）检测 bot 不存活时，以 detached 子进程拉起——
// 子进程脱离 serve 生命周期（serve 重载/重启不碰 bot）。运行时解析 bun→node：
// bun 直接跑源码（.js→.ts 映射）；node 跑发布时预打的 dist/openqq-bot.js bundle。
import { spawn, spawnSync } from "child_process"
import { existsSync, readFileSync, statSync } from "fs"
import { join, dirname, isAbsolute } from "path"
import { homedir } from "os"

export type Runtime = "bun" | "node"

/** 探测命令可用性（跨平台：spawnSync  ENOENT=不存在） */
export function resolveRuntime(probe: (cmd: string) => boolean = defaultProbe): Runtime | null {
  if (resolveBunCommand(probe)) return "bun"
  if (probe("node")) return "node"
  return null
}

/**
 * 文件系统可执行判定（2026-11-09 静默拉起缺陷修复）：
 * 存在于 PATH 的裸名（如 bun.cmd shim）经 CreateProcess 会退化为 cmd.exe /c 中转 →
 * 弹出可见控制台窗口（Windows Terminal 宿主实证）。拉起命令一律归一为全路径。
 * 纯 fs 判定，不 spawn 子进程——探测本身也不许有 cmd 中转副作用。
 */
function isExecutable(p: string): boolean {
  try {
    const st = statSync(p)
    return st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

/** 在 PATH 上定位可执行体并返回全路径；Windows 只认 .exe（.cmd/.bat 必经 cmd 中转，排除） */
export function locateOnPath(cmd: string, pathEnv = process.env.PATH ?? process.env.Path ?? ""): string | null {
  if (isAbsolute(cmd)) return isExecutable(cmd) ? cmd : null
  const isWin = process.platform === "win32"
  for (const dir of pathEnv.split(isWin ? ";" : ":")) {
    if (!dir) continue
    const base = isWin && !/\.[a-z]+$/i.test(cmd) ? `${cmd}.exe` : cmd
    const full = join(dir, base)
    if (isExecutable(full)) return full
  }
  if (isWin) return resolveThroughShim(cmd, pathEnv)
  return null
}

// 两种 npm shim exec 行形态：`%dp0%\x\y.exe`（npm 老式）与 `%~dp0\x\y.exe`（新式）。
// 注意：`~` 必须显式可选（%~?），写成 %~-?dp0 会让 ~ 变字面必选而漏掉 %dp0% 形态。
const SHIM_PATTERN_LINE = /%~?dp0%?\\?([^"\n]+?\.exe)/
const SHIM_PATTERN_ABS = /([A-Za-z]:\\[^\n"]+?\.exe)/

/**
 * .cmd/.bat shim 反查真实 exe（2026-11-09 静默拉起缺陷）：
 * Windows 上 PATH 可能只有 bun.cmd（npm 全局 bin），裸名命中也必须取回真实
 * bun.exe——从 shim 内容提取 %~dp0 相对或全路径，零进程、零 cmd 中转。
 */
export function resolveThroughShim(bare: string, pathEnv = process.env.PATH ?? process.env.Path ?? ""): string | null {
  for (const dir of pathEnv.split(";")) {
    if (!dir) continue
    for (const ext of [".cmd", ".bat"]) {
      const shimPath = join(dir, bare + ext)
      let text: string
      try {
        text = readFileSync(shimPath, "utf-8")
      } catch {
        continue
      }
      const rel = SHIM_PATTERN_LINE.exec(text)
      if (rel) {
        const full = join(dir, rel[1]!)
        if (isExecutable(full)) return full
      }
      const abs = SHIM_PATTERN_ABS.exec(text)
      if (abs) {
        const full = abs[1]!
        if (isExecutable(full)) return full
      }
    }
  }
  return null
}

function bunCandidates(): string[] {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    // 全路径探测先行（bun.exe 直调），裸名 shim（bun.cmd/bun.bat）永不作为拉起命令
    return [
      join(appdata, "npm", "node_modules", "bun", "bin", "bun.exe"),
      join(homedir(), ".bun", "bin", "bun.exe"),
      "bun",
      "bun.exe",
    ]
  }
  return ["/usr/local/bin/bun", "/opt/homebrew/bin/bun", join(homedir(), ".bun", "bin", "bun"), "bun"]
}

/** 解析可用 bun 命令。返回值恒为全路径可执行体（裸名经 locateOnPath 归一）。 */
export function resolveBunCommand(probe: (cmd: string) => boolean = defaultProbe): string | null {
  if (probe !== defaultProbe) {
    // 注入契约（测试用）：probe 决定可用性；裸名命中必须折算全路径（locate 失败时 shim 反查）
    for (const c of bunCandidates()) {
      if (!probe(c)) continue
      if (isAbsolute(c)) return c
      return locateOnPath(c) ?? resolveThroughShim(c) ?? null
    }
    return null
  }
  // 生产：纯 fs 判定——不 spawn 子进程（探测自身不许有 cmd 中转副作用），恒返回全路径
  for (const c of bunCandidates()) {
    const full = locateOnPath(c) ?? (isAbsolute(c) ? null : resolveThroughShim(c))
    if (full) return full
  }
  return null
}

function defaultProbe(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore", windowsHide: true })
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
 * 拉起命令全路径不变量（2026-11-09 静默拉起缺陷）：
 * Plan.command 必须是全路径可执行体——裸名（bun/node）在 Windows 上会命中 .cmd shim
 * 或触发 cmd.exe 中转，弹出可见控制台窗口（Windows Terminal 宿主实证）。
 * 解析失败即抛错，绝不回落裸名。
 */
export function resolveRuntimeCommand(runtime: Runtime): string {
  const cmd = runtime === "bun" ? resolveBunCommand() : locateOnPath("node")
  if (!cmd) throw new Error(`未找到 ${runtime} 可执行体（全路径解析失败），拒绝生成裸名拉起计划`)
  return cmd
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
    join(dir, "bot.js"),                        // 旧双 bundle 形态（兼容已装实例）
    join(dir, "dist", "openqq-bot.js"),         // 形态 1：全量包安装（插件目录=完整 npm 包）
    join(homedir(), ".openqq", "plugin-payload", "bot.js"), // 单文件形态的有效载荷位
    join(dir, "..", "dist", "openqq-bot.js"),   // 形态 2：npm 包（plugin-entry 在 src/ 下）
    join(dir, "..", "src", "index.ts"),         // 形态 3：dev 源码
  ]
  for (const c of candidates) if (exists(c)) return c
  return null
}

/** 构造拉起计划（纯函数供测试）。entry 由 resolveBotEntry 解析。 */
export function buildLaunchPlan(runtime: Runtime, entry: string, logPath?: string): LaunchPlan {
  // T 项（2026-11-02 沙箱时序深度自检）：插件拉起通道剥离我方配置命名空间——
  // 继承的宿主（serve）环境可能残留 QQ_*/OPENCODE_*（沙箱开关尤甚），而 bot 侧
  // .env 加载规则是"继承环境优先于文件"，不剥离会让宿主环境静默覆盖单点配置
  // （反向时序坑：宿主设了沙箱，.env 改回正式反而不生效）。独立部署形态
  // （用户显式跑 openqq）不受影响——那边环境覆盖是合理诉求。
  const CONFIG_KEY = [/^QQ_/, /^OPENCODE_/, /^ALLOWED_USERS$/]
  const inherited: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (CONFIG_KEY.some((r) => r.test(k))) continue
    inherited[k] = v
  }
  // QQ_INSTANCE_LOCK=try：拉起即抢锁，抢不到自动退出（多 location 并发拉起防堆积）
  // QQ_LOG_FILE：bot 进程内文件日志双写（detached 后无控制台，fd 重定向不可靠）
  const env = {
    ...inherited,
    QQ_INSTANCE_LOCK: "try",
    ...(logPath ? { QQ_LOG_FILE: logPath } : {}),
  }
  if (runtime === "bun") {
    return { command: resolveRuntimeCommand("bun"), args: ["run", entry], env }
  }
  return { command: resolveRuntimeCommand("node"), args: [entry], env }
}

/** bot 输出日志（detached 后 stdout/stderr 的唯一去向）。
 *  2026-11-20 合并批：统一为 ~/.openqq/openqq.log（bot 与看门狗同文件，
 *  滚动/预算归 core/log-rotate.ts；旧名 bot.out.log 停止写入保留备查）。 */
export function botLogPath(): string {
  return join(homedir(), ".openqq", "openqq.log")
}

/**
 * detached 拉起 bot（跨平台同 API；Windows 隐藏控制台窗口）。
 * 静默红线（2026-11-09）：Plan.command 恒为全路径可执行体；显式 shell:false——
 * 裸名或 shell 中转会在 Windows 上经 cmd.exe 弹出可见控制台（Windows Terminal 宿主实证）。
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
    shell: false, // 静默红线：禁 shell 中转（cmd.exe 会另开控制台）
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
