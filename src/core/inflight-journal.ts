// @input:  fs/path/os（台账落盘）
// @output: claimInflight, recordInflight, settleInflight, pendingInflight, classifyInflight（纯函数供测试）,
//          markInflightStage, listInflightView, pruneInflightEntries（保留策略纯函数）, newInflightAttemptId,
//          resetInflightJournal（测试用）,
//          INFLIGHT_MAX_AGE_MS, SETTLED_RETENTION_MS, SETTLED_RETENTION_LIMIT, redispatchMaxAgeMs
// @pos:    core - 在途台账（重启换代丢消息修复：QQ 消息派发落账、答复送达销账、启动对账）
//
// 事故背景（2026-10-30，用户实证）：bot 重启/网关静默死亡窗口内到达的 QQ 消息
// 丢失无反馈——在途回合状态全在内存，进程换代即蒸发。本模块把"派发→送达"责任
// 落盘到 ~/.openqq/inflight.json，启动时对账恢复（bridge.recoverInflightRounds）。
import { storageFile } from "./storage.js"
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, statSync } from "fs"
import { join } from "path"
import { admissionDecision } from "./inbound-dedupe.js"

export interface InflightEntry {
  /** 跟踪键：真实 QQ msgId；重派回合为合成键 redispatch-<sessionId>-<ts> */
  msgId: string
  userId: string
  sessionId: string
  /** 用户消息原文（截 300 字，对账匹配与通知展示用） */
  text: string
  at: number
  state: "inflight" | "settled"
  /**
   * 投递代次：settled 允许重新认领后，旧回合迟到的销账/落账回调不得
   * 作用到新代次。settle 带 attemptId 时必须 msgId+attemptId 双匹配。
   */
  attemptId?: string
  /** K2 内容指纹（messageFingerprint；受理时原子写入，随 settle 释放） */
  fingerprint?: string
  /** 本回合的 prompt 用户消息 id（修复⑧直答归属的回合边界锚点） */
  promptId?: string
  /**
   * 可观测细化阶段（2026-11-05 队列/台账可观测性）：
   * claimed=已受理未入队 | queued=已入队 | dispatched=已派发未落 promptId
   * running=执行中 | background=后台等待 | settled=已结清。
   * state 仍是权威二元态；stage 只做诊断，缺失时按 sessionId/promptId 推导。
   */
  stage?: InflightStage
  /** 与内存队列 #id 对齐（重启恢复 FIFO 顺序用） */
  queueId?: number
  /** 入队时刻（重启按此排序重建队列） */
  enqueuedAt?: number
  /** 最后一次状态变更时刻 */
  updatedAt?: number
  /** 结清原因（诊断"为什么没答"） */
  settleReason?: SettleReason
  /** 受理/更新所属进程（跨进程归属诊断） */
  ownerPid?: number
  /** 最近一次失败摘要（截 200 字） */
  lastError?: string
  /** 死回合自动续作已消耗次数（2026-11-19 owner 裁定：单任务续作上限 3 次，落盘防重启洗白） */
  resumeCount?: number
}

export type InflightStage = "claimed" | "queued" | "dispatched" | "running" | "background" | "settled"

export type SettleReason =
  | "answered"
  | "error"
  | "queue-full"
  | "duplicate-msgid"
  | "duplicate-intent"
  | "cancelled"
  | "dropped"
  | "blocked"
  | "superseded"
  | "expired"
  | "redispatch"
  | "manual"

export interface InflightView {
  inflight: InflightEntry[]
  settled: InflightEntry[]
}

/** 生成新的投递代次 ID（bridge 显式新回合/显式重投时调用） */
export function newInflightAttemptId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// 启动对账年龄上限：超 24h 的在途账仍保留在文件中，但恢复时不再追溯（由恢复流程销账）。
export const INFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000
// settled 记录只保留 24h 内、按 at 最新的 20 条；inflight 不受年龄或数量限制。
export const SETTLED_RETENTION_MS = INFLIGHT_MAX_AGE_MS
export const SETTLED_RETENTION_LIMIT = 20

/**
 * 台账保留策略（纯函数）：保留全部 inflight；settled 先按 24h 过滤，再按 at 取最新 20 条。
 * 输出按 at 升序；at 相同时保持输入相对顺序。数量上限并列时保留输入中靠后的记录。
 */
export function pruneInflightEntries(entries: InflightEntry[], now = Date.now()): InflightEntry[] {
  const indexed = entries.map((entry, index) => ({ entry, index }))
  const retainedSettled = new Set(
    indexed
      .filter(({ entry }) => entry.state === "settled" && now - entry.at <= SETTLED_RETENTION_MS)
      .sort((a, b) => b.entry.at - a.entry.at || b.index - a.index)
      .slice(0, SETTLED_RETENTION_LIMIT)
      .map(({ index }) => index),
  )
  return indexed
    .filter(({ entry, index }) => entry.state === "inflight" || retainedSettled.has(index))
    .sort((a, b) => a.entry.at - b.entry.at || a.index - b.index)
    .map(({ entry }) => entry)
}

// 丢失消息自动重派窗口（2026-10-30 用户拍板：默认 2 小时，env QQ_REDISPATCH_MAX_AGE_MS
// 可调；0=关闭自动重派一律通知）。窗口内视为"意图仍然新鲜"自动重派；超期只通知请用户
// 重发——防"陈旧意图"在重启时被意外执行。
export function redispatchMaxAgeMs(): number {
  const n = Number(process.env.QQ_REDISPATCH_MAX_AGE_MS ?? "7200000")
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7_200_000
}

// 路径解析：显式注入（多角色 createInflightJournal(file)）> env 覆盖（测试）> legacy 全局。
function journalPath(file?: string): string {
  return file || process.env.QQ_INFLIGHT_FILE || storageFile("inflight.json")
}

function load(file?: string): InflightEntry[] {
  let entries: InflightEntry[] = []
  const path = journalPath(file)
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"))
      if (Array.isArray(raw)) entries = raw
    }
  } catch {
    entries = [] // 损坏即空，不阻塞启动
  }
  // 读取始终走磁盘：多个 bot 执行体可能共享台账，进程内 cache 会看不到彼此的认领。
  return pruneInflightEntries(entries)
}

function save(file: string | undefined, entries: InflightEntry[]): void {
  const path = journalPath(file)
  mkdirSync(join(path, ".."), { recursive: true })
  const retained = pruneInflightEntries(entries)
  // 临时文件带进程与随机后缀：并发执行体不会互相覆盖对方的 tmp。
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(retained, null, 2), { mode: 0o600 }) // 台账含用户消息，POSIX 仅本人可读
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 已改名或清理失败 */ }
    throw error
  }
}

// 所有台账 mutation 共用一把短临界区文件锁。仅原子 rename 不够：两个进程仍可能
// 基于各自旧快照互相覆盖。锁内重新读盘，保证跨进程 claim/settle 不丢更新。
const JOURNAL_LOCK_STALE_MS = 30_000
const JOURNAL_LOCK_WAIT_MS = 5_000
const sleepArray = new Int32Array(new SharedArrayBuffer(4))

function withJournalLock<T>(file: string | undefined, fn: () => T): T {
  const path = journalPath(file)
  mkdirSync(join(path, ".."), { recursive: true })
  const lockPath = `${path}.lock`
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + JOURNAL_LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600)
      try {
        writeFileSync(fd, token)
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > JOURNAL_LOCK_STALE_MS) unlinkSync(lockPath)
      } catch { /* 锁不存在/另一进程正在接管，下轮重试 */ }
      if (Date.now() >= deadline) {
        throw new Error(`在途台账锁等待超时: ${error instanceof Error ? error.message : error}`)
      }
      Atomics.wait(sleepArray, 0, 0, 10)
    }
  }

  try {
    return fn()
  } finally {
    // 只释放自己持有的锁； stale 接管后，旧持有者不能误删新锁。
    try {
      if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath)
    } catch { /* 已被 stale 清理 */ }
  }
}

function mutate<T>(file: string | undefined, fn: (entries: InflightEntry[]) => T): T {
  return withJournalLock(file, () => {
    const entries = load(file)
    const result = fn(entries)
    save(file, entries)
    return result
  })
}

/** 受理结果：K1/K2 细分给调用方决定回执纪律（msgid 静默 / intent 给短提示） */
export type ClaimOutcome = "ok" | "duplicate-msgid" | "duplicate-intent"

/**
 * AI 派发前原子认领（修复①）：withinJournalLock 单临界区内同时做 K1+K2——
 * - K1：同 msgId 已在途（任何进程认领的都算）→ duplicate-msgid；
 * - K2：同用户同内容指纹在同窗在途（不同 msgId 的相同意图）→ duplicate-intent；
 * 判定与写入原子，杜绝「两进程都看到无占位→双双放行」的竞态。
 * 窗口=in-flight：settle 即释放指纹与 msgId 占位，重投/重发重新放行（用户拍板）。
 * 已销账记录允许重新投递，并原位复用、更新为传入的新在途回合（代次 = 传入
 * attemptId；未传则生成新代次）；不另建去重文件。
 * 被 24h/20 条保留策略裁掉的旧 msgId 也可正常认领。
 */
export function claimInflightDetailed(entry: Omit<InflightEntry, "state">, opts?: { fingerprint?: string; file?: string }): ClaimOutcome {
  return mutate(opts?.file, (entries) => {
    const fingerprint = opts?.fingerprint ?? entry.fingerprint ?? ""
    const decision = admissionDecision({
      hasSameMsgIdInflight: entries.some((e) => e.msgId === entry.msgId && e.state === "inflight"),
      fingerprint,
      inflightFingerprints: entries
        .filter((e) => e.state === "inflight" && e.fingerprint)
        .map((e) => e.fingerprint as string),
    })
    if (decision !== "ok") return decision
    const attempt = entry.attemptId ?? newInflightAttemptId()
    const now = Date.now()
    const existing = entries.find((e) => e.msgId === entry.msgId)
    if (existing) {
      Object.assign(existing, entry, {
        fingerprint,
        attemptId: attempt,
        state: "inflight" as const,
        stage: entry.stage ?? "claimed",
        updatedAt: now,
        ownerPid: entry.ownerPid ?? process.pid,
      })
    } else {
      entries.push({
        ...entry,
        fingerprint,
        attemptId: attempt,
        state: "inflight" as const,
        stage: entry.stage ?? "claimed",
        updatedAt: now,
        ownerPid: entry.ownerPid ?? process.pid,
      })
    }
    return "ok"
  })
}

/** 兼容旧布尔签名的认领（测试与既有调用方） */
export function claimInflight(entry: Omit<InflightEntry, "state">, file?: string): boolean {
  return claimInflightDetailed(entry, { file }) === "ok"
}

/**
 * 派发落账：
 * - 同 msgId + 同 attemptId 且在途：幂等，仅允许后补 sessionId；
 * - attemptId 不匹配：迟到回调，不得覆盖新回合；
 * - 已 settled：显式重投重新激活（换新代次与新的 at/user/session/text）；
 * - 无记录：新增在途。
 */
export function recordInflight(entry: Omit<InflightEntry, "state">, file?: string): void {
  mutate(file, (entries) => {
    const now = Date.now()
    const existing = entries.find((e) => e.msgId === entry.msgId)
    if (existing) {
      if (existing.state === "inflight") {
        if (entry.attemptId && existing.attemptId && entry.attemptId !== existing.attemptId) return
        if (!existing.sessionId && entry.sessionId) existing.sessionId = entry.sessionId
        if (!existing.promptId && entry.promptId) existing.promptId = entry.promptId
        // 派发落账 = 已进入会话；stage 只前进不回退（queued → dispatched）
        if (entry.sessionId) existing.stage = existing.stage === "running" || existing.stage === "background" ? existing.stage : "dispatched"
        existing.updatedAt = now
        if (!existing.ownerPid) existing.ownerPid = process.pid
        return
      }
      // settled：视为显式重投，重新激活为新在途回合
      const attempt = entry.attemptId ?? newInflightAttemptId()
      Object.assign(existing, entry, {
        attemptId: attempt,
        state: "inflight" as const,
        stage: entry.stage ?? (entry.sessionId ? "dispatched" : "claimed"),
        updatedAt: now,
        settleReason: undefined,
        ownerPid: entry.ownerPid ?? process.pid,
      })
      return
    }
    entries.push({
      ...entry,
      attemptId: entry.attemptId ?? newInflightAttemptId(),
      state: "inflight" as const,
      stage: entry.stage ?? (entry.sessionId ? "dispatched" : "claimed"),
      updatedAt: now,
      ownerPid: entry.ownerPid ?? process.pid,
    })
  })
}

/**
 * 销账：答复已送达（或已转入有接管的后台等待/已给用户终态反馈）。
 * 传入 attemptId 时必须 msgId + attemptId 双匹配才销账——settled 重新认领后，
 * 旧代次的迟到 settle 不得把新在途回合误销。返回是否实际销账。
 * reason 记录"为什么结束"，供 /ledger 区分 answered 与 rejected。
 */
export function settleInflight(msgId: string, attemptId?: string, reason: SettleReason = "answered", file?: string): boolean {
  return mutate(file, (entries) => {
    const entry = entries.find(
      (e) => e.msgId === msgId && e.state === "inflight" && (!attemptId || !e.attemptId || e.attemptId === attemptId),
    )
    if (!entry) return false
    entry.state = "settled"
    entry.stage = "settled"
    entry.settleReason = reason
    entry.updatedAt = Date.now()
    return true
  })
}

/** 待对账清单（启动恢复用） */
export function pendingInflight(file?: string): InflightEntry[] {
  return load(file).filter((e) => e.state === "inflight")
}

/** 台账快照（/queue 与 /ledger 派生视图的数据源；不做用户过滤） */
export function listInflightView(file?: string): InflightView {
  const entries = load(file)
  return {
    inflight: entries.filter((e) => e.state === "inflight").sort((a, b) => a.at - b.at),
    settled: entries.filter((e) => e.state === "settled").sort((a, b) => b.at - a.at),
  }
}

/**
 * 阶段推进（可观测性）：只对在途账生效，默认只前进不回退。
 * patch 用于回填 queueId/enqueuedAt/sessionId/promptId/lastError。
 * opts.force：重启恢复排队时允许回退到 queued（进程换代后旧 stage 不再可信）。
 */
export function markInflightStage(
  msgId: string,
  stage: InflightStage,
  patch?: Partial<Pick<InflightEntry, "queueId" | "enqueuedAt" | "sessionId" | "promptId" | "lastError">>,
  opts?: { force?: boolean; file?: string },
): boolean {
  const rank: Record<InflightStage, number> = {
    claimed: 0,
    queued: 1,
    dispatched: 2,
    running: 3,
    background: 4,
    settled: 5,
  }
  return mutate(opts?.file, (entries) => {
    const entry = entries.find((e) => e.msgId === msgId && e.state === "inflight")
    if (!entry) return false
    if (opts?.force || !entry.stage || rank[stage] >= rank[entry.stage]) entry.stage = stage
    if (patch?.queueId !== undefined) entry.queueId = patch.queueId
    if (patch?.enqueuedAt !== undefined) entry.enqueuedAt = patch.enqueuedAt
    if (patch?.sessionId && !entry.sessionId) entry.sessionId = patch.sessionId
    if (patch?.promptId && !entry.promptId) entry.promptId = patch.promptId
    if (patch?.lastError !== undefined) entry.lastError = patch.lastError.slice(0, 200)
    entry.updatedAt = Date.now()
    return true
  })
}

/**
 * 回合 prompt 落库后回填 promptId（修复⑧）：后台等待/重启重挂的直答归属
 * 需要「这是哪个回合」的边界锚点，taskId 台账是跨进程唯一可靠载体。
 * 2026-11-05：同时把 stage 推进到 running（可观测性）。
 */
export function markInflightPromptId(msgId: string, promptId: string, file?: string): void {
  if (!promptId) return
  mutate(file, (entries) => {
    const entry = entries.find((e) => e.msgId === msgId && e.state === "inflight")
    if (!entry) return
    if (!entry.promptId) entry.promptId = promptId
    entry.stage = "running"
    entry.updatedAt = Date.now()
  })
}

/**
 * 续作锚点更新（2026-11-19 死回合自动续作）：新回合的 promptId 必须强制覆盖旧锚点
 * （markPromptId/markStage 的「只补空」语义不适用——旧锚点已存在），
 * resumeCount 同步落盘：bot 重启后启动对账重挂按已消耗次数续算，上限不洗白。
 */
export function markInflightResume(msgId: string, promptId: string, resumeCount: number, file?: string): void {
  if (!promptId) return
  mutate(file, (entries) => {
    const entry = entries.find((e) => e.msgId === msgId && e.state === "inflight")
    if (!entry) return
    entry.promptId = promptId
    entry.resumeCount = resumeCount
    entry.updatedAt = Date.now()
  })
}

/** 测试用：清空台账文件状态 */
export function resetInflightJournal(file?: string): void {
  withJournalLock(file, () => save(file, []))
}

// —— 对账分类（纯函数）——
// 与 opencode/mirror.ts buildDigest 同源的消息形状（最小依赖，避免跨层 import）。
interface HistoryMessage {
  type?: string
  text?: string
  time?: { created?: number }
  content?: Array<{ type?: string; text?: string }>
}

// 时间锚容差：journal.at = QQ 消息到达时刻，定案实证 prompt user 行落库在秒级内；
// QQ 服务器时间戳与本地时钟可能偏差，±2 分钟以内只用于「找回那一回合」的兜底，
// 不足以把别条消息误绑进来（同文4连发间隔 ms 级也包含在窗口内——但它们本就同回合语义）。
const TIME_ANCHOR_TOLERANCE_MS = 120_000
// 文本锚长度（R2 修复 2026-11-03）：50→100——两条消息前 50 字同形（如都以
// 「帮我看看这个报错：」开头）会把对账匹配到错误回合；100 字降误配率。
// 注意：probe 越长越避开「引用前缀注入」的前缀失配失效——正文前缀在 50 内的
// 报错语境注释仍能命中（引用前缀属于前缀，不影响 includes）。
const PROBE_LENGTH = 100

export type InflightClass =
  | { kind: "answered"; answer: string }
  | { kind: "running" }
  | { kind: "lost" }

/**
 * 对账分类：台账条目 × 会话历史 → 该回合的真实状态。
 * - answered：找到该用户消息，且其后已有 idle + assistant 正文 → 完整答案在库里没投出，补投
 * - running：找到该用户消息但尚未 idle（无论是否已有流式正文）→ 回合在跑，重挂后台等待
 * - lost：历史里找不到该用户消息 → 消息从未到达 opencode（网关窗口丢失），重派/通知
 * 匹配口径（修复④加锚）：①文本探针——user 文本包含台账原文前 50 字（prompt 会加
 * 引用前缀/附件注记，不能全等）；②时间锚——文本找不到时按 journal.at ±2min 找
 * user 行。修复 423/429 型误伤：旧逻辑文本探针失配即判 lost 重派，把已答回合
 * 再跑一遍。两个锚都找不到才敢说 lost。
 */
export function classifyInflight(
  entry: Pick<InflightEntry, "text"> & Partial<Pick<InflightEntry, "at">>,
  messages: HistoryMessage[],
): InflightClass {
  const ordered = [...messages].reverse()
  const probe = entry.text.trim().slice(0, PROBE_LENGTH)
  let userIdx = -1
  if (probe === "") {
    // 纯附件没有文本锚，只能沿用最新用户消息，由 idle/答案状态兜底。
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].type === "user") {
        userIdx = i
        break
      }
    }
  } else {
    // 长任务期间可能出现更新用户消息；必须按原文找回原回合，不能只查最后一条，
    // 否则会把已到达的旧消息误判为 lost 并再次派发给 LLM。
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].type === "user" && (ordered[i].text ?? "").includes(probe)) {
        userIdx = i
        break
      }
    }
  }
  if (userIdx < 0 && probe === "" && entry.at !== undefined) {
    // R1 修复（2026-11-03，外部复盘核验）：纯附件消息无文本锚，旧逻辑直接锚定
    // 「最新用户消息」——等待窗口内若来了新消息会对错回合。改为时间锚优先
    // （按 journal.at 找最近 user 行，同修④机制），找不到才回落「最新用户消息」。
    let bestIdx = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].type !== "user") continue
      const delta = Math.abs((ordered[i].time?.created ?? 0) - entry.at)
      if (delta < bestDelta) {
        bestDelta = delta
        bestIdx = i
      }
    }
    if (bestIdx >= 0 && bestDelta <= TIME_ANCHOR_TOLERANCE_MS) userIdx = bestIdx
  }
  if (userIdx < 0 && entry.at !== undefined) {
    // 修复④时间锚兜底：文本探针失配（引用前缀改写/截断/超长原文）不再轻判 lost——
    // 按到达时刻找回原 user 行；取时间距最近的命中（防 5 连发同文/邻近回合误绑），
    // 距离超过容差仍视为找不到。
    let bestIdx = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].type !== "user") continue
      const delta = Math.abs((ordered[i].time?.created ?? 0) - entry.at)
      if (delta < bestDelta) {
        bestDelta = delta
        bestIdx = i
      }
    }
    if (bestIdx >= 0 && bestDelta <= TIME_ANCHOR_TOLERANCE_MS) userIdx = bestIdx
  }
  if (userIdx < 0) return { kind: "lost" }

  // 回合边界 = 原用户消息之后、下一条用户消息之前。后续新回合的 idle/答案
  // 不能拿来给原回合销账。
  let turnEnd = ordered.length
  for (let i = userIdx + 1; i < ordered.length; i++) {
    if (ordered[i].type === "user") {
      turnEnd = i
      break
    }
  }

  // 有 assistant 正文 ≠ 回合完成。必须在该回合边界内看到 idle，才允许补投。
  const completed = ordered.slice(userIdx + 1, turnEnd).some((m) => m.type === "idle")
  if (!completed) return { kind: "running" }

  // 与直答一致：只补投该回合最终 assistant 正文，不拼接阶段前导语。
  for (let i = turnEnd - 1; i > userIdx; i--) {
    const m = ordered[i]
    if (m.type !== "assistant") continue
    const answer = (m.content ?? [])
      .filter((p) => p.type === "text" && p.text?.trim())
      .map((p) => p.text!.trim())
      .join("\n")
      .trim()
    if (answer) return { kind: "answered", answer }
  }
  return { kind: "running" }
}

// ── 多角色绑定实例（2026-11-17，owner 裁定单进程多 bot 身份）──
// 单进程多角色时，各角色的台账必须物理隔离（否则重启对账跨角色误补/误派）。
// createInflightJournal(file) 返回绑定到指定文件的实例；模块级具名导出 =
// 默认实例（路径解析照旧：env 覆盖 > legacy 全局），既有调用方/测试零改动。
export interface InflightJournal {
  readonly file: string
  claim: typeof claimInflight
  claimDetailed: typeof claimInflightDetailed
  record: typeof recordInflight
  settle: typeof settleInflight
  pending: typeof pendingInflight
  view: typeof listInflightView
  markStage: typeof markInflightStage
  markPromptId: typeof markInflightPromptId
  markResume: typeof markInflightResume
  reset: typeof resetInflightJournal
}

export function createInflightJournal(file?: string): InflightJournal {
  return {
    file: journalPath(file),
    claim: (entry) => claimInflight(entry, file),
    claimDetailed: (entry, opts) => claimInflightDetailed(entry, { ...opts, file }),
    record: (entry) => recordInflight(entry, file),
    settle: (msgId, attemptId, reason) => settleInflight(msgId, attemptId, reason, file),
    pending: () => pendingInflight(file),
    view: () => listInflightView(file),
    markStage: (msgId, stage, patch, opts) => markInflightStage(msgId, stage, patch, { ...opts, file }),
    markPromptId: (msgId, promptId) => markInflightPromptId(msgId, promptId, file),
    markResume: (msgId, promptId, resumeCount) => markInflightResume(msgId, promptId, resumeCount, file),
    reset: () => resetInflightJournal(file),
  }
}
