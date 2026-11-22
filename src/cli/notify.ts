// @input:  node:fs/homedir/join、../config（ENV_FILE/loadEnvFile）、../qq/api（getAccessToken 校准用不入队）、./outbox.ts、../core/notify-sink.ts（resolveNotifyRecipients/defaultOutboxPath）
// @output: runNotifyCli(argv)（供 bin/openqq.js 与测试调用），只入队不发送。
// @pos:    cli - openqq notify 外部入队通道（feature：headless 定时任务结果推送）。
//          BOT（notify-sink）进程消费投递；CLI 不取 token、不连 OpenCode、不抢实例锁。
// @note:   设计文档：Desktop `opencode-qqbot-feature-request.md` Part 1；
//          收件人 fail-closed：缺省取 ALLOWED_USERS 唯一项；显式 --user 必须命中名单。
import { existsSync, readFileSync } from "node:fs"
import { createOutbox } from "../core/outbox.js"
import { ENV_FILE, loadEnvFile } from "../config.js"
import { applyConfigOverlay } from "../core/bot-config.js"
import { defaultOutboxPath, resolveNotifyRecipients } from "../core/notify-sink.js"

export interface NotifyCliOptions {
  filePath?: string
  now?: number
  env?: { allowedUsers: readonly string[] }
}

/** CLI 结果（--json 输出同 shape；dry-run 时 queued=false 并附 wouldEnqueue）。 */
export interface NotifyCliResult {
  ok: boolean
  queued: boolean
  id: string
  user: string
  chars: number
  truncated: boolean
  dryRun: boolean
  json: boolean
  reason?: string
}

/** 保守截断：默认 1500 字（主动消息日配额 100/天——长输出拆几十条会吃光）；0=不截断。 */
export const NOTIFY_DEFAULT_MAX_CHARS = 1500

interface ParsedArgs {
  text?: string
  filePath?: string
  stdin?: boolean
  user?: string
  id?: string
  maxChars: number
  ttlHours?: number
  dryRun: boolean
  json: boolean
  help: boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { maxChars: NOTIFY_DEFAULT_MAX_CHARS, dryRun: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    switch (a) {
      case "--text": parsed.text = next; i++; break
      case "--file": parsed.filePath = next; i++; break
      case "--stdin": parsed.stdin = true; break
      case "--user": parsed.user = next; i++; break
      case "--id": parsed.id = next; i++; break
      case "--max-chars": parsed.maxChars = Number(next); i++; break
      case "--ttl-hours": parsed.ttlHours = Number(next); i++; break
      case "--dry-run": parsed.dryRun = true; break
      case "--json": parsed.json = true; break
      case "--help": case "-h": parsed.help = true; i++; break
      default:
        throw new Error(`未知参数：${a}（用法：openqq notify --text "…" | --file <p> | --stdin）`)
    }
  }
  if (!parsed.help && !parsed.text && !parsed.filePath && !parsed.stdin) {
    throw new Error("必须提供正文来源：--text / --file / --stdin 三选一")
  }
  if (!Number.isFinite(parsed.maxChars) || parsed.maxChars < 0) {
    throw new Error("--max-chars 必须是 >= 0 的有限数（0=不截断）")
  }
  return parsed
}

/** 收件人 fail-closed：显式 --user 必须命中名单；缺省仅取 ALLOWED_USERS 唯一项。 */
export function resolveUser(envAllowed: readonly string[], explicit?: string): string {
  return resolveNotifyRecipients(envAllowed, explicit)
}

/** 正文来源：--text / --file / --stdin；--file - 读 stdin（同步可读）。 */
function readBody(parsed: ParsedArgs): string {
  if (parsed.text !== undefined) return parsed.text
  if (parsed.filePath !== undefined) {
    if (parsed.filePath === "-") return readFileSync(0 as unknown as number, "utf8")
    if (!existsSync(parsed.filePath)) throw new Error(`--file 不存在：${parsed.filePath}`)
    return readFileSync(parsed.filePath, "utf8")
  }
  if (parsed.stdin) return readFileSync(0 as unknown as number, "utf8")
  return ""
}

export async function runNotifyCli(
  argv: readonly string[],
  options: NotifyCliOptions = {},
): Promise<NotifyCliResult> {
  const now = options.now ?? Date.now()
  const parsed = parseArgs(argv)
  if (parsed.help) {
    const help = [
      "用法：openqq notify --text \"…\" | --file <路径> | --stdin",
      "  --user <openid>      收件人；缺省取 ALLOWED_USERS 唯一项（多用户必须显式指定）",
      "  --id <key>           幂等键（同 key 不重复投递）",
      "  --max-chars <n>      截断上限，默认 1500，0 不截断",
      "  --ttl-hours <n>      队列等待上限，默认 24（env QQ_NOTIFY_TTL_HOURS 兜底）",
      "  --dry-run / --json   不入队 / 机器可读输出",
    ].join("\n")
    console.log(help)
    return { ok: true, queued: false, id: "", user: "", chars: 0, truncated: false, dryRun: true, json: parsed.json, reason: "help" }
  }
  // .env 注入：bot 进程入口已做；CLI 独立进程需自行加载（ALLOWED_USERS/凭据同源单点）。
  // config.json 先叠加（最低层），.env 后加载自然覆盖它——与 bot 入口同一层级序。
  applyConfigOverlay()
  if (!options.env && existsSync(ENV_FILE)) loadEnvFile(ENV_FILE)
  const allowedUsers = options.env ? [...options.env.allowedUsers] : String(process.env.ALLOWED_USERS ?? "")
    .split(/[,\s]+/).filter(Boolean)
  const user = resolveUser(allowedUsers, parsed.user)
  if (!user) {
    throw new Error(
      allowedUsers.length === 0
        ? "ALLOWED_USERS 为空——fail-closed 不允许无名单入队（先在 ~/.openqq/.env 配置）"
        : parsed.user
          ? `收件人不在名单：${parsed.user}（ALLOWED_USERS 共 ${allowedUsers.length} 项，--user 必须精确命中；请核对 openid）`
          : "多用户名单必须用 --user <openid> 显式指定收件人",
    )
  }
  const raw = readBody(parsed)
  const max = parsed.maxChars
  const content = max === 0 ? raw : raw.length > max ? `${raw.slice(0, max)}…` : raw
  const id = parsed.id || `notify-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const filePath = options.filePath ?? defaultOutboxPath()
  if (parsed.dryRun) {
    return { ok: true, queued: false, id, user, chars: content.length, truncated: content.length !== raw.length, dryRun: true, json: parsed.json }
  }
  const ttlHours =
    parsed.ttlHours ?? Number(process.env.QQ_NOTIFY_TTL_HOURS ?? 24)
  const nextAttemptAt = parsed.ttlHours !== undefined && Number.isFinite(ttlHours) && ttlHours > 0
    ? now + ttlHours * 60 * 60 * 1000
    : now
  const outbox = createOutbox({ filePath, pollIntervalMs: 0 })
  const entry = await outbox.enqueue({
    ...(parsed.id ? { id: parsed.id } : {}),
    kind: "notify",
    payload: { text: content },
    ctx: { type: "c2c", userId: user, msgId: "", content: "(openqq notify)", timestamp: String(now) },
    sessionId: "",
    nextAttemptAt,
  })
  return { ok: true, queued: true, id: entry.id, user, chars: content.length, truncated: content.length !== raw.length, dryRun: false, json: parsed.json }
}

/** bin/openqq.js 入口：返回进程退出码（0=已入队；1=参数/配置错误）。 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    const result = await runNotifyCli(argv)
    if (result.reason === "help") return 0
    if (result.json) {
      console.log(JSON.stringify(result))
    } else if (result.queued && !result.dryRun) {
      console.log(`[notify] 已入队 id=${result.id} user=${result.user} chars=${result.chars}${result.truncated ? "（已截断）" : ""}`)
    } else if (result.dryRun) {
      console.log(`[notify] dry-run：将入队 user=${result.user} chars=${result.chars}${result.truncated ? "（已截断）" : ""}`)
    }
    return result.ok ? 0 : 1
  } catch (error) {
    console.error(`[notify] 入队失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
