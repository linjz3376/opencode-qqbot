// @input:  process.env, ~/.openqq/.env
// @output: Config, loadConfig, ensureConfig
// @pos:    根层 - 环境变量加载 + 首次运行交互式引导
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { createInterface } from "readline"
import { applyConfigOverlay } from "./core/bot-config.js"

export interface Config {
  qq: {
    appId: string
    clientSecret: string
    sandbox: boolean
  }
  opencode: {
    baseUrl: string
    externalUrl: boolean
  }
  allowedUsers: string[]
}

/**
 * 多角色（2026-11-17 owner 裁定：单进程挂多个 QQ bot 身份，参考 openclaw-qqbot
 * 具名账号表）。一个 Role = 一个 appId 身份：自己的凭证/沙箱开关/白名单/
 * 网关连接/数据分桶（~/.openqq/roles/<appId>/）。openid 按 app 隔离，
 * 因此各角色的用户体系天然不相交。
 */
export interface RoleConfig {
  /** 角色名（日志前缀用，可选） */
  name: string
  appId: string
  clientSecret: string
  sandbox: boolean
  allowedUsers: string[]
}

/**
 * 解析多角色配置。来源：env QQ_BOTS（JSON 数组，见 parseRolesJson）。
 * 未配置时回退 legacy 单角色（QQ_APP_ID/QQ_APP_SECRET/QQ_SANDBOX/ALLOWED_USERS），
 * 行为与 2026-11-17 之前完全一致——存量部署零迁移。
 * 多角色模式下 ALLOWED_USERS/QQ_SANDBOX/QQ_APP_* 只作兜底缺项，不再单独生效。
 */
/**
 * 可用凭据判定（纯函数，2026-11-20 应修尽修批）：legacy 字段齐全 或 QQ_BOTS
 * 解析出 ≥1 合法角色。ensureConfig 用它做早退——纯 QQ_BOTS 部署（无 legacy 字段）
 * 不再掉进交互提问分支（detached 进程 stdin 无TTY会挂起）。
 */
export function hasUsableCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.QQ_APP_ID ?? "").trim() && (env.QQ_APP_SECRET ?? "").trim()) return true
  const raw = (env.QQ_BOTS ?? "").trim()
  if (!raw) return false
  return parseRolesJson(raw).length > 0
}

/**
 * 主角色 appId（纯函数）：legacy QQ_APP_ID 优先，缺省回退 QQ_BOTS 首角色——
 * restart/看门狗/插件引导器等单点探活调用方的锁路径锚点，在纯多角色部署下不再瞎。
 */
export function primaryAppId(env: NodeJS.ProcessEnv = process.env): string | null {
  const legacy = (env.QQ_APP_ID ?? "").trim()
  if (legacy) return legacy
  const raw = (env.QQ_BOTS ?? "").trim()
  if (!raw) return null
  return parseRolesJson(raw)[0]?.appId ?? null
}

export function loadRoles(): RoleConfig[] {  const raw = (process.env.QQ_BOTS ?? "").trim()
  if (raw) {
    const roles = parseRolesJson(raw)
    if (roles.length > 0) return roles
    console.warn("[config] QQ_BOTS 配置存在但解析结果为空，回退 legacy 单角色模式")
  }
  const single = loadConfig()
  console.warn(
    "[config] legacy 单角色配置（QQ_APP_ID/QQ_APP_SECRET）已弃用——QQ_BOTS 多角色表是唯一角色源；" +
      "legacy 兜底将于 2026-12-31 移除，请迁移 .env：QQ_BOTS=[{\"appId\":\"…\",\"secret\":\"…\",\"sandbox\":false,\"name\":\"角色名\"}]",
  )
  return [{
    name: single.qq.appId,
    appId: single.qq.appId,
    clientSecret: single.qq.clientSecret,
    sandbox: single.qq.sandbox,
    allowedUsers: single.allowedUsers,
  }]
}

/**
 * QQ_BOTS JSON 解析与校验（纯函数）。形态：
 * [{"appId":"...","secret":"...","sandbox":false,"name":"开发角色","allowedUsers":["..."]}]
 * 校验规则：必须是数组、每项必含非空 appId/secret；sandbox 默认 false；
 * allowedUsers 默认 []; name 默认 appId。非法项跳过并 warn，全非法返回 []。
 */
export function parseRolesJson(raw: string): RoleConfig[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn("[config] QQ_BOTS 不是合法 JSON，已忽略")
    return []
  }
  if (!Array.isArray(parsed)) {
    console.warn("[config] QQ_BOTS 必须是数组，已忽略")
    return []
  }
  const roles: RoleConfig[] = []
  for (const [i, item] of parsed.entries()) {
    const r = item as Partial<Record<"appId" | "secret" | "sandbox" | "name" | "allowedUsers", unknown>>
    const appId = typeof r?.appId === "string" ? r.appId.trim() : ""
    const secret = typeof r?.secret === "string" ? r.secret.trim() : ""
    if (!appId || !secret) {
      console.warn(`[config] QQ_BOTS[${i}] 缺少 appId/secret，已跳过`)
      continue
    }
    const allowedUsers = Array.isArray(r?.allowedUsers)
      ? r.allowedUsers.filter((u): u is string => typeof u === "string" && !!u.trim()).map((u) => u.trim())
      : []
    roles.push({
      name: typeof r?.name === "string" && r.name.trim() ? r.name.trim() : appId,
      appId,
      clientSecret: secret,
      sandbox: r?.sandbox === true,
      allowedUsers,
    })
  }
  // 同 appId 重复=配置错误，后者覆盖前者（日志可见），防双连接互踢
  const seen = new Map<string, RoleConfig>()
  for (const role of roles) {
    if (seen.has(role.appId)) console.warn(`[config] QQ_BOTS 中 appId=${role.appId} 重复，后者覆盖前者`)
    seen.set(role.appId, role)
  }
  return [...seen.values()]
}

const CONFIG_DIR = join(homedir(), ".openqq")
export const ENV_FILE = join(CONFIG_DIR, ".env")

function askTwo(q1: string, q2: string): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    let done = false
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on("close", () => { if (!done) reject(new Error("输入被中断")) })
    rl.question(q1, (a1) => {
      rl.question(q2, (a2) => {
        done = true
        rl.close()
        resolve([a1.trim(), a2.trim()])
      })
    })
  })
}

export async function ensureConfig(): Promise<void> {
  // P2 配置分层（2026-11-23 owner 裁定）：config.json 最低用户层，先叠加——
  // 「已设不覆盖」使其落在继承环境与 .env 之下（.env 在其后加载自然覆盖它）。
  applyConfigOverlay()

  if (hasUsableCredentials()) return

  if (existsSync(ENV_FILE)) {
    loadEnvFile(ENV_FILE)
    if (hasUsableCredentials()) return
  }

  const localEnv = join(process.cwd(), ".env")
  if (existsSync(localEnv)) {
    loadEnvFile(localEnv)
    if (hasUsableCredentials()) return
  }

  console.log("首次运行，需要配置 QQ 机器人凭证")
  console.log("(从 https://q.qq.com 机器人管理 -> 开发设置 获取)\n")

  const [appId, appSecret] = await askTwo("QQ App ID: ", "QQ App Secret: ")

  if (!appId || !appSecret) {
    throw new Error("App ID 和 App Secret 不能为空")
  }

  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }) // POSIX 凭据目录仅本人可入
  const envContent = [
    `# 多角色（唯一角色源，推荐）：QQ_BOTS=[{"appId":"…","secret":"…","sandbox":false,"name":"开发角色","allowedUsers":[]}]`,
    `# 以下 legacy 单角色字段已弃用，将于 2026-12-31 移除`,
    `QQ_APP_ID=${appId}`,
    `QQ_APP_SECRET=${appSecret}`,
    `QQ_SANDBOX=false`,
    `# OPENCODE_BASE_URL=http://127.0.0.1:<端口>/api（桌面 2.1.x 端口动态，失联时启动流程会自动发现）`,
    `ALLOWED_USERS=`,
  ].join("\n") + "\n"

  writeFileSync(ENV_FILE, envContent, { mode: 0o600 }) // POSIX 凭据文件仅本人可读
  console.log(`\n配置已保存到 ${ENV_FILE}`)

  process.env.QQ_APP_ID = appId
  process.env.QQ_APP_SECRET = appSecret
}

export function loadEnvFile(path: string): void {
  const content = readFileSync(path, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

export function loadConfig(): Config {
  const appId = process.env.QQ_APP_ID
  const clientSecret = process.env.QQ_APP_SECRET

  if (!appId) throw new Error("缺少 QQ_APP_ID，运行 openqq 重新配置")
  if (!clientSecret) throw new Error("缺少 QQ_APP_SECRET，运行 openqq 重新配置")

  const allowedRaw = process.env.ALLOWED_USERS?.trim() ?? ""
  const allowedUsers = allowedRaw
    ? allowedRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
    : []

  return {
    qq: {
      appId,
      clientSecret,
      sandbox: process.env.QQ_SANDBOX === "true",
    },
    opencode: {
      baseUrl: process.env.OPENCODE_BASE_URL?.trim() || "",
      externalUrl: !!process.env.OPENCODE_BASE_URL?.trim(),
    },
    allowedUsers,
  }
}
