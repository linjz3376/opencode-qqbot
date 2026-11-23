// @input:  fs/path/crypto + ./storage (storageRoot) + ./send-media (sendLocalFile/normalizeLocalPath)
// @output: SendFileRequest, SendFileResult, sendRequestsDirFor, findQQBinding, dedupeKeyOf,
//          writeSendRequest, awaitSendResult, startSendRequestConsumer
// @pos:    core - AI→QQ 出站发送的文件队列协议（qq_send_file 工具化，owner 2026-11-23 批准）
//
// 背景：AI 出站发文件原先只有「QQ_SEND_FILE: <路径>」魔法标记，且语法从未注入 prompt——
// 模型只能猜标记/猜路径，反复尝试才成功。工具化后：插件侧（引擎宿主）注册 qq_send_file
// 一等工具，经本文件队列把请求交给 bot 进程消费——插件与 bot 是两个进程，文件队列与
// outbox 离线通知同构，满足状态落盘红线，不新增端口与攻击面。
// 权威安全校验（白名单/拒识名单/20MB 上限）只在 bot 侧 sendLocalFile 内执行——
// 插件宿主与 bot 的 process.cwd() 不同，白名单绝不在插件侧预判。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { storageRoot } from "./storage.js"
import { normalizeLocalPath, sendLocalFile } from "./send-media.js"
import type { MessageContext } from "../qq/types.js"

export interface SendFileRequest {
  id: string
  sessionId: string
  userId: string
  /** 多角色时目标角色；legacy 单角色为空 */
  appId?: string
  path: string
  caption?: string
  at: number
  /** 幂等键：sessionId+规范化路径+mtime+size——同文件同内容重试不重复发 */
  dedupeKey: string
}

export interface SendFileResult {
  id: string
  ok: boolean
  detail?: string
  error?: string
  deduped?: boolean
  at: number
}

export function sendRequestsDirFor(appId?: string): string {
  return join(storageRoot(appId), "send-requests")
}

/** 会话→QQ 绑定查找（插件侧用）：扫 legacy sessions.json 与 roles/*\/sessions.json。
 *  映射形状 { [userId]: { sessionId } }（sessions.ts）；找不到=null（未绑定会话不得发送）。 */
export function findQQBinding(sessionId: string, root = storageRoot()): { userId: string; appId?: string } | null {
  const candidates: Array<{ file: string; appId?: string }> = [{ file: join(root, "sessions.json") }]
  const rolesDir = join(root, "roles")
  if (existsSync(rolesDir)) {
    for (const role of readdirSync(rolesDir)) {
      candidates.push({ file: join(rolesDir, role, "sessions.json"), appId: role })
    }
  }
  for (const { file, appId } of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, { sessionId?: string }>
      for (const [userId, v] of Object.entries(parsed)) {
        if (v?.sessionId === sessionId) return appId ? { userId, appId } : { userId }
      }
    } catch {
      // 单文件缺失/坏 JSON 不阻断其余角色查找
    }
  }
  return null
}

export function dedupeKeyOf(sessionId: string, normalizedPath: string, st: { mtimeMs: number; size: number }): string {
  return `${sessionId}:${normalizedPath}:${st.mtimeMs}:${st.size}`
}

export function writeSendRequest(dir: string, req: SendFileRequest): string {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${req.id}.tmp`)
  writeFileSync(tmp, JSON.stringify(req), "utf-8")
  renameSync(tmp, join(dir, `${req.id}.json`))
  return join(dir, `${req.id}.json`)
}

/** 插件侧等回执：轮询 <id>.result.json；超时/取消返回 null（结果未知如实上报，不编造）。 */
export async function awaitSendResult(
  dir: string,
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<SendFileResult | null> {
  const timeoutMs = opts.timeoutMs ?? 45_000
  const intervalMs = opts.intervalMs ?? 500
  const file = join(dir, `${id}.result.json`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf-8")) as SendFileResult
      } catch {
        // 结果文件写半截（原子 rename 前不应发生）——下一轮再读
      }
    }
    if (opts.signal?.aborted) return null
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export interface SendRequestConsumerOptions {
  /** 消费目录（按角色隔离）；缺省 sendRequestsDirFor(appId) */
  dir?: string
  appId?: string
  ctxForUser: (userId: string) => MessageContext
  getToken: () => Promise<string>
  /** 测试注入：替换真实发送（默认 sendLocalFile 全量安全链） */
  sendFile?: (ctx: MessageContext, path: string) => Promise<string>
  intervalMs?: number
  log?: (line: string) => void
}

/**
 * bot 侧消费器：轮询请求目录 → 逐条发送 → 结果回写。
 * 幂等：启动时从既有 result 文件重建去重账（重启不洗白）；同 dedupeKey 直接回旧结果不重发。
 * 坏请求改名 .bad.json 防毒丸卡队列；返回停止函数。
 */
export function startSendRequestConsumer(opts: SendRequestConsumerOptions): () => void {
  const dir = opts.dir ?? sendRequestsDirFor(opts.appId)
  const intervalMs = opts.intervalMs ?? 1500
  const log = opts.log ?? (() => {})
  const seen = new Map<string, SendFileResult>()
  mkdirSync(dir, { recursive: true })
  // 启动重建去重账 + 清理 24h 前结果文件（先读后删，重启不重复发）
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".result.json")) continue
    const full = join(dir, f)
    try {
      const result = JSON.parse(readFileSync(full, "utf-8")) as SendFileResult & { dedupeKey?: string }
      const key = (result as { dedupeKey?: string }).dedupeKey
      if (key) seen.set(key, result)
      if (Date.now() - statSync(full).mtimeMs > 24 * 60 * 60_000) renameSync(full, full + ".old")
    } catch {
      // 单文件损坏忽略
    }
  }
  const sendFile =
    opts.sendFile ?? ((ctx: MessageContext, path: string) => sendLocalFile(ctx, path, { getToken: opts.getToken }))

  async function consumeOne(file: string): Promise<void> {
    const full = join(dir, file)
    let req: SendFileRequest
    try {
      req = JSON.parse(readFileSync(full, "utf-8")) as SendFileRequest
    } catch {
      renameSync(full, full + ".bad.json")
      log(`[send-requests] 坏请求已隔离: ${file}`)
      return
    }
    const prior = seen.get(req.dedupeKey)
    const base: SendFileResult = { id: req.id, ok: true, at: Date.now() }
    let result: SendFileResult
    if (prior) {
      result = { ...base, ok: prior.ok, detail: prior.detail, error: prior.error, deduped: true }
    } else {
      try {
        const ctx = opts.ctxForUser(req.userId)
        const detail = await sendFile(ctx, normalizeLocalPath(req.path))
        result = { ...base, ok: true, detail }
      } catch (error) {
        result = { ...base, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      seen.set(req.dedupeKey, { ...result, dedupeKey: req.dedupeKey } as SendFileResult)
    }
    // 结果文件带上 dedupeKey 供重启后重建账；原子写
    const payload = JSON.stringify({ ...result, dedupeKey: req.dedupeKey })
    writeFileSync(join(dir, `${req.id}.result.tmp`), payload, "utf-8")
    renameSync(join(dir, `${req.id}.result.tmp`), join(dir, `${req.id}.result.json`))
    // 请求本体归档（防重复消费；保留 24h 由启动清理归并）
    renameSync(full, full + ".done")
    log(`[send-requests] ${result.ok ? "已发送" : "发送失败"}${result.deduped ? "（去重）" : ""} user=${req.userId.slice(0, 8)}… path=${req.path}`)
  }

  const timer = setInterval(() => {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".result.json") && !f.endsWith(".bad.json") && !f.endsWith(".done"))
    } catch {
      return
    }
    for (const f of files) {
      void consumeOne(f).catch((error) => log(`[send-requests] 消费失败 ${f}: ${error instanceof Error ? error.message : error}`))
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** 插件侧工具执行体（plugin-entry 调用）：绑定查找 → 落请求 → 等回执 → 结构化文案。 */
export async function executeQQSendFile(
  input: { path: string; caption?: string },
  context: { sessionID: string; signal?: AbortSignal },
): Promise<string> {
  const binding = findQQBinding(context.sessionID)
  if (!binding) {
    return "发送失败：此 OpenCode 会话未绑定 QQ 用户——只有从 QQ 发起的会话（或已 /sessions 切入绑定会话）才能发送到 QQ。"
  }
  const normalized = normalizeLocalPath(input.path)
  let st: { mtimeMs: number; size: number }
  try {
    const s = statSync(normalized)
    st = { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return `发送失败：文件不存在或不可读——${normalized}（请先用写文件工具生成到本机绝对路径，再调用本工具）`
  }
  const dir = sendRequestsDirFor(binding.appId)
  const req: SendFileRequest = {
    id: randomUUID(),
    sessionId: context.sessionID,
    userId: binding.userId,
    appId: binding.appId,
    path: normalized,
    caption: input.caption,
    at: Date.now(),
    dedupeKey: dedupeKeyOf(context.sessionID, normalized, st),
  }
  writeSendRequest(dir, req)
  const result = await awaitSendResult(dir, req.id, { signal: context.signal })
  if (!result) {
    return "请求已受理但 45s 内未获回执——发送结果未知（bot 可能忙或离线，恢复后仍会消费）。请勿盲目重试；可先 /status 核查 bot 状态。"
  }
  if (result.ok) return `已发送到 QQ：${result.detail ?? req.path}${result.deduped ? "（相同文件此前已发，本次去重未重复发送）" : ""}`
  return `发送失败：${result.error ?? "未知原因"}——请按原因修正后重试（若是白名单拒绝，可先把文件复制到允许的根目录内再发）。`
}
