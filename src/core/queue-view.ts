// @input:  ./inflight-journal（InflightEntry/SettleReason）, ./message-queue（QueuedJob/previewText/agoLabel）
// @output: deriveQueueView, formatQueueReply, formatLedgerReply, formatStatusLine,
//          shortId, ORPHAN_DEFAULT_MS, REJECTED_WINDOW_MS, QUEUE_REPLY_MAX_CHARS
// @pos:    core - 队列/台账可观测性派生视图（纯函数：同一输入必得同一状态与文案）
//
// 背景（2026-11-05 队列测试1–20）：内存队列只回答"谁在等"，磁盘台账只回答"谁没答"，
// 两者失联时用户从 /queue 只能看到"队列：空"。本模块把三源（队列/台账/运行态）
// join 成 9 个对外状态，并给出可复算的回复文案。
import type { InflightEntry, InflightStage, SettleReason } from "./inflight-journal.js"
import { agoLabel, previewText, type QueuedJob } from "./message-queue.js"

/** 孤儿判定阈值：台账在途、不在队列、也不在运行/后台，超过该时长即孤儿。 */
export const ORPHAN_DEFAULT_MS = 90_000
/** "最近拒绝"展示窗口。 */
export const REJECTED_WINDOW_MS = 30 * 60_000
/** 单条回复字符上限（超过分页，避免 QQ 长文体验崩坏）。 */
export const QUEUE_REPLY_MAX_CHARS = 1800
const PAGE_SIZE = 10
const ALL_PAGE_SIZE = 20
const PREVIEW = 32

export type ViewStage =
  | "claimed"
  | "queued"
  | "dispatched"
  | "running"
  | "background"
  | "orphan"
  | "ghost"
  | "settled"
  | "rejected"

export interface ViewEntry {
  msgId: string
  text: string
  /** 受理时刻（台账 at） */
  at: number
  /** 入队时刻（队列 job.enqueuedAt；未入队回落到 at） */
  enqueuedAt?: number
  stage: ViewStage
  /** 票号（只增不复用；drop/ledger 的引用键） */
  queueId?: number
  /** 排队位置（1-based，仅 queued 有；完成一条后其余前移） */
  position?: number
  sessionId?: string
  promptId?: string
  attemptId?: string
  ownerPid?: number
  settleReason?: SettleReason
  updatedAt?: number
  lastError?: string
}

export interface QueueView {
  now: number
  busy: boolean
  orphanMs: number
  /** 队列里等待的条目（按入队顺序） */
  queued: ViewEntry[]
  /** 已受理但还在派发窗口内的条目 */
  claimed: ViewEntry[]
  /** 执行中的条目（最多一条，同用户串行） */
  running?: ViewEntry
  /** 后台等待的条目 */
  background: ViewEntry[]
  /** 已派发但当前无运行标记的条目（可能刚结束未销账/进程换代间隙） */
  dispatchedOthers: ViewEntry[]
  /** 孤儿：台账在途、不在队列、不在运行/后台、超过阈值 */
  orphan: ViewEntry[]
  /** 幽灵：队列有、台账无 */
  ghost: ViewEntry[]
  /** 最近拒绝/作废（settled 且 reason != answered） */
  rejected: ViewEntry[]
  /** 最近已答（供 /ledger 展示） */
  settledRecent: ViewEntry[]
  /** 全部在途（含上述分类，按受理时间升序） */
  inflightEntries: ViewEntry[]
  counts: {
    queued: number
    inflight: number
    running: number
    background: number
    dispatched: number
    claimed: number
    orphan: number
    ghost: number
    rejected: number
    settledRecent: number
  }
  warnings: string[]
}

const STAGE_LABEL: Record<ViewStage, string> = {
  claimed: "派发中",
  queued: "排队中",
  dispatched: "已派发",
  running: "执行中",
  background: "后台等待",
  orphan: "孤儿",
  ghost: "幽灵",
  settled: "已结",
  rejected: "已拒",
}

const REASON_LABEL: Record<SettleReason, string> = {
  answered: "已答",
  error: "处理失败",
  "queue-full": "排队已满",
  "duplicate-msgid": "重复消息",
  "duplicate-intent": "重复意图",
  cancelled: "已取消",
  dropped: "已删除",
  blocked: "被阻塞",
  superseded: "被新回合取代",
  expired: "已过期",
  redispatch: "重启重派",
  manual: "人工结清",
}

const STAGE_RANK: Record<InflightStage, number> = {
  claimed: 0,
  queued: 1,
  dispatched: 2,
  running: 3,
  background: 4,
  settled: 5,
}

export interface DeriveQueueViewInput {
  /** 该用户的台账条目（inflight + settled） */
  entries: InflightEntry[]
  /** 该用户的内存队列 */
  jobs: readonly QueuedJob[]
  runtime: {
    busy: boolean
    draining: boolean
    /** 该用户当前会话 id（台账 sessionId 对齐用） */
    sessionId?: string
    /** 处于后台等待的会话集合 */
    bgSessions: ReadonlySet<string>
  }
  now?: number
  orphanMs?: number
  rejectedWindowMs?: number
}

function toViewEntry(entry: InflightEntry, stage: ViewStage, enqueuedAt?: number): ViewEntry {
  return {
    msgId: entry.msgId,
    text: entry.text,
    at: entry.at,
    ...(enqueuedAt !== undefined ? { enqueuedAt } : {}),
    stage,
    ...(entry.queueId !== undefined ? { queueId: entry.queueId } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.promptId ? { promptId: entry.promptId } : {}),
    ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
    ...(entry.ownerPid !== undefined ? { ownerPid: entry.ownerPid } : {}),
    ...(entry.settleReason ? { settleReason: entry.settleReason } : {}),
    ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
  }
}

/**
 * 三源 join：队列（谁在等）+ 台账（谁没答）+ 运行态（谁在跑）。
 * 判定优先级：queue > background > running > dispatched > orphan > claimed。
 * 纯函数：不读盘、不取时间（now 可注入），供单测复算。
 */
export function deriveQueueView(input: DeriveQueueViewInput): QueueView {
  const now = input.now ?? Date.now()
  const orphanMs = input.orphanMs ?? ORPHAN_DEFAULT_MS
  const rejectedWindowMs = input.rejectedWindowMs ?? REJECTED_WINDOW_MS
  const warnings: string[] = []

  const inflight = input.entries.filter((e) => e.state === "inflight")
  const settled = input.entries.filter((e) => e.state === "settled")
  const byMsg = new Map(inflight.map((e) => [e.msgId, e]))
  const jobs = [...input.jobs]

  const queued: ViewEntry[] = []
  const ghost: ViewEntry[] = []
  const linkedMsgIds = new Set<string>()
  let noMsgIdJobs = 0

  for (const job of jobs) {
    const msgId = job.ctx.msgId
    if (!msgId) {
      // 无 msgId 的消息从未落账（台账只认 msgId）；单列提示，不误报幽灵。
      noMsgIdJobs++
      queued.push({
        msgId: `queue-${job.id}`,
        text: job.text,
        at: job.enqueuedAt,
        enqueuedAt: job.enqueuedAt,
        stage: "queued",
        queueId: job.id,
      })
      continue
    }
    const entry = byMsg.get(msgId)
    if (!entry) {
      ghost.push({
        msgId,
        text: job.text,
        at: job.enqueuedAt,
        enqueuedAt: job.enqueuedAt,
        stage: "ghost",
        queueId: job.id,
      })
      continue
    }
    linkedMsgIds.add(msgId)
    const view = toViewEntry(entry, "queued", job.enqueuedAt)
    view.queueId = job.id
    queued.push(view)
  }

  const claimed: ViewEntry[] = []
  const background: ViewEntry[] = []
  const dispatchedOthers: ViewEntry[] = []
  const orphan: ViewEntry[] = []
  let running: ViewEntry | undefined
  let dispatchedWithoutRuntime = 0

  for (const entry of inflight) {
    if (linkedMsgIds.has(entry.msgId)) continue
    const inBg = !!entry.sessionId && input.runtime.bgSessions.has(entry.sessionId)
    const sameSession = !!entry.sessionId && entry.sessionId === input.runtime.sessionId
    const hasDispatched = !!entry.sessionId
    const stageRank = entry.stage ? STAGE_RANK[entry.stage] : hasDispatched ? STAGE_RANK.dispatched : STAGE_RANK.claimed

    if (inBg) {
      background.push(toViewEntry(entry, "background"))
      continue
    }
    if (input.runtime.busy && sameSession && (entry.promptId || stageRank >= STAGE_RANK.dispatched)) {
      const view = toViewEntry(entry, "running")
      if (!running) running = view
      else orphan.push(view) // 同用户串行下不应出现第二条；出现即异常
      continue
    }
    // 已派发级（stage ≥ dispatched，含 drain 派发窗口 sessionId 尚未回填的秒级间隙）：
    // 归「已派发」并告警——绝不判孤儿。否则排队消息在 drain 窗口会被误报孤儿、
    // 巡检每 10min 刷假告警（2026-11-05 深度自评实证）。
    if (hasDispatched || stageRank >= STAGE_RANK.dispatched) {
      dispatchedWithoutRuntime++
      dispatchedOthers.push(toViewEntry(entry, "dispatched"))
      continue
    }
    // 孤儿门槛：只有「从未进过派发」（claimed/queued 级）的超龄空账才算孤儿——
    // 当初 19 条孤儿正是这种；真卡死的已派发票由 /queue 可见 + 重启恢复兜底。
    if (now - entry.at > orphanMs) {
      orphan.push(toViewEntry(entry, "orphan"))
      continue
    }
    claimed.push(toViewEntry(entry, "claimed"))
  }

  // 位置是派生量：票号不变，完成/删除后其余前移。
  queued.forEach((e, i) => {
    e.position = i + 1
  })

  const rejected = settled
    .filter((e) => e.settleReason !== undefined && e.settleReason !== "answered" && now - e.at <= rejectedWindowMs)
    .sort((a, b) => b.at - a.at)
    .map((e) => toViewEntry(e, "rejected"))

  const settledRecent = settled
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, 20)
    .map((e) => toViewEntry(e, "settled"))

  const inflightEntries = [...queued, ...claimed, ...background, ...dispatchedOthers, ...(running ? [running] : []), ...orphan].sort(
    (a, b) => a.at - b.at,
  )

  if (ghost.length > 0) warnings.push(`幽灵 ${ghost.length} 条（队列有、台账无）`)
  if (noMsgIdJobs > 0) warnings.push(`队列中 ${noMsgIdJobs} 条无 msgId（无法与台账对账）`)
  if (orphan.length > 0) warnings.push(`孤儿 ${orphan.length} 条（超 ${Math.round(orphanMs / 1000)}s 无人认领）`)
  if (dispatchedWithoutRuntime > 0) {
    warnings.push(`台账 ${dispatchedWithoutRuntime} 条已派发但当前无运行标记（可能已结束未销账）`)
  }
  for (let i = 1; i < queued.length; i++) {
    const prev = queued[i - 1]?.queueId ?? 0
    const cur = queued[i]?.queueId ?? 0
    if (cur <= prev) {
      warnings.push("队列编号非递增（顺序异常）")
      break
    }
  }

  return {
    now,
    busy: input.runtime.busy,
    orphanMs,
    queued,
    claimed,
    ...(running ? { running } : {}),
    background,
    dispatchedOthers,
    orphan,
    ghost,
    rejected,
    settledRecent,
    inflightEntries,
    counts: {
      queued: queued.length,
      inflight: inflight.length,
      running: running ? 1 : 0,
      background: background.length,
      dispatched: dispatchedOthers.length,
      claimed: claimed.length,
      orphan: orphan.length,
      ghost: ghost.length,
      rejected: rejected.length,
      settledRecent: settledRecent.length,
    },
    warnings,
  }
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** 台账 id 太长：只留尾部，便于用户复制定位。 */
export function shortId(id: string | undefined, n = 6): string {
  if (!id) return "-"
  const flat = id.replace(/\s+/g, "")
  return flat.length <= n ? flat : `…${flat.slice(-n)}`
}

function stageLabel(stage: ViewStage): string {
  return STAGE_LABEL[stage]
}

function reasonLabel(reason: string | undefined): string {
  if (!reason) return "-"
  return (REASON_LABEL as Record<string, string>)[reason] ?? reason
}

function clampReply(lines: string[], maxChars: number, hint: string): string {
  let out = ""
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) {
      return `${out}\n…（${hint}）`
    }
    out = out ? `${out}\n${line}` : line
  }
  return out
}

/** 队列满拒绝回执（固定文案，design §3.4：指向 /queue）。 */
export function formatQueueFullReceipt(max: number): string {
  return `排队已满（${max} 条），本条未入队；请稍候再试，发 /queue 查看队列或 /cancel 中止当前任务`
}

export interface QueueReplyOptions {
  all?: boolean
  page?: number
  limit?: number
  maxChars?: number
}

/** 用户面回复：当前任务 / 队列占用 / 台账在途 / 异常区。 */
export function formatQueueReply(view: QueueView, opts: QueueReplyOptions = {}): string {
  const limit = opts.limit ?? 20
  const all = opts.all ?? false
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = all ? ALL_PAGE_SIZE : PAGE_SIZE
  const lines: string[] = []

  lines.push(`当前任务：${view.busy ? "处理中" : "空闲"}`)
  lines.push(`队列：${view.counts.queued}/${limit} · 台账在途：${view.counts.inflight} 条`)

  if (view.counts.queued > 0) {
    lines.push(`排队中 ${view.counts.queued} 条：`)
    const start = (page - 1) * pageSize
    const slice = all ? view.queued.slice(start, start + pageSize) : view.queued.slice(0, pageSize)
    for (const e of slice) {
      lines.push(
        `  #${e.queueId ?? "-"} · 第${e.position ?? "-"}位 · ${agoLabel(e.enqueuedAt ?? e.at, view.now)} · ${previewText(e.text, PREVIEW)} · ${stageLabel(e.stage)}`,
      )
    }
    const remain = view.counts.queued - (start + slice.length)
    if (remain > 0) lines.push(`  …还有 ${remain} 条（/queue all ${page + 1}）`)
  } else if (view.counts.inflight === 0 && view.counts.rejected === 0) {
    lines.push(`队列：空（0/${limit}）`)
  }

  if (view.counts.claimed > 0) {
    lines.push(`派发中 ${view.counts.claimed} 条（受理后 90s 内，正常窗口）`)
  }

  if (view.counts.running > 0 && view.running) {
    lines.push(`执行中：#${view.running.queueId ?? "-"} · ${previewText(view.running.text, PREVIEW)} · ${agoLabel(view.running.at, view.now)}`)
  }

  if (view.counts.background > 0) {
    lines.push(`后台等待 ${view.counts.background} 条（完成会自动回传）`)
  }

  if (view.counts.dispatched > 0) {
    lines.push(`已派发 ${view.counts.dispatched} 条（等待接续执行）`)
  }

  if (view.counts.orphan > 0) {
    lines.push(`⚠️ 孤儿 ${view.counts.orphan} 条（已受理，未入队/未派发，超 ${Math.round(view.orphanMs / 1000)}s）`)
    const shown = all ? view.orphan.slice(0, pageSize) : view.orphan.slice(0, 8)
    for (const e of shown) {
      lines.push(`  · ${previewText(e.text, PREVIEW)} · ${agoLabel(e.at, view.now)} · msg ${shortId(e.msgId)}`)
    }
    if (view.orphan.length > shown.length) lines.push(`  …还有 ${view.orphan.length - shown.length} 条（/queue all 或 /ledger orphan）`)
  }

  if (view.counts.ghost > 0) {
    lines.push(`⚠️ 幽灵 ${view.counts.ghost} 条（队列有、台账无，需修复）`)
    for (const e of view.ghost.slice(0, 5)) {
      lines.push(`  · ${previewText(e.text, PREVIEW)} · #${e.queueId ?? "-"} · msg ${shortId(e.msgId)}`)
    }
  }

  if (view.counts.rejected > 0) {
    lines.push(`最近拒绝 ${view.counts.rejected} 条`)
    for (const e of view.rejected.slice(0, 5)) {
      lines.push(`  · ${previewText(e.text, PREVIEW)} · ${reasonLabel(e.settleReason)} · ${clock(e.at)}`)
    }
  }

  for (const w of view.warnings) {
    if (w.startsWith("队列编号")) lines.push(`⚠️ ${w}`)
  }

  lines.push("发 /queue all 看全部 · /ledger 看台账明细 · /queue clear 清空")

  return clampReply(lines, opts.maxChars ?? QUEUE_REPLY_MAX_CHARS, "内容过长，发 /queue all 分页查看")
}

export interface LedgerReplyOptions {
  filter?: "all" | "orphan" | "rejected" | "inflight" | "settled"
  page?: number
  detail?: ViewEntry
  maxChars?: number
}

/** 诊断面回复：台账快照（在途分类 + 最近结清 + 拒绝原因）。 */
export function formatLedgerReply(view: QueueView, opts: LedgerReplyOptions = {}): string {
  if (opts.detail) return formatLedgerDetail(opts.detail, opts.maxChars ?? QUEUE_REPLY_MAX_CHARS)

  const filter = opts.filter ?? "all"
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const lines: string[] = [
    `台账快照 · ${new Date(view.now).toLocaleString("zh-CN", { hour12: false })}`,
    `在途 ${view.counts.inflight} · 已结 ${view.counts.settledRecent}（保留 24h / 最新 20）`,
  ]

  const wantInflight = filter === "all" || filter === "orphan" || filter === "inflight"
  const wantSettled = filter === "all" || filter === "settled" || filter === "rejected"

  if (wantInflight) {
    const list =
      filter === "orphan"
        ? view.orphan
        : filter === "inflight"
          ? view.inflightEntries
          : view.inflightEntries
    if (list.length === 0) {
      lines.push(filter === "orphan" ? "孤儿：无" : "在途：无")
    } else {
      const start = (page - 1) * ALL_PAGE_SIZE
      const slice = list.slice(start, start + ALL_PAGE_SIZE)
      lines.push(filter === "orphan" ? `孤儿 ${list.length} 条：` : `在途 ${list.length} 条（按受理时间）：`)
      slice.forEach((e, i) => {
        lines.push(
          ` ${start + i + 1}. ${previewText(e.text, PREVIEW)} · ${clock(e.at)} · ${agoLabel(e.at, view.now)} · ${stageLabel(e.stage)} · att ${shortId(e.attemptId)} · sid ${shortId(e.sessionId)} · pid ${e.ownerPid ?? "-"}`,
        )
      })
      const remain = list.length - (start + slice.length)
      if (remain > 0) lines.push(` …还有 ${remain} 条（/ledger ${page + 1}）`)
    }
  }

  if (wantSettled) {
    const list = filter === "rejected" ? view.rejected : view.settledRecent
    if (list.length === 0) {
      lines.push(filter === "rejected" ? "最近拒绝：无" : "最近结清：无")
    } else {
      lines.push(filter === "rejected" ? `最近拒绝 ${list.length} 条：` : `最近结清 ${list.length} 条：`)
      for (const e of list.slice(0, 10)) {
        lines.push(` · ${previewText(e.text, PREVIEW)} · ${clock(e.at)} · ${reasonLabel(e.settleReason)} · att ${shortId(e.attemptId)}`)
      }
    }
  }

  if (view.warnings.length > 0) {
    lines.push(`⚠️ ${view.warnings.join("；")}`)
  }

  lines.push("发 /ledger check 对账会话历史 · /ledger settle <尾号> confirm 人工结清")
  return clampReply(lines, opts.maxChars ?? QUEUE_REPLY_MAX_CHARS, "内容过长，发 /ledger <页码> 分页查看")
}

function formatLedgerDetail(entry: ViewEntry, maxChars: number): string {
  const lines = [
    `台账条目 · ${previewText(entry.text, 60)}`,
    `状态：${entry.stage}（${stageLabel(entry.stage)}）`,
    `msgId：${entry.msgId}`,
    `attemptId：${entry.attemptId ?? "-"}`,
    `会话：${entry.sessionId ?? "-"}`,
    `promptId：${entry.promptId ?? "-"}`,
    `队列编号：${entry.queueId ?? "-"}`,
    `受理：${new Date(entry.at).toLocaleString("zh-CN", { hour12: false })}`,
    `更新：${entry.updatedAt ? new Date(entry.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "-"}`,
    `结清原因：${reasonLabel(entry.settleReason)}`,
    `进程：${entry.ownerPid ?? "-"}`,
    `最近错误：${entry.lastError ?? "-"}`,
  ]
  return clampReply(lines, maxChars, "详情过长")
}

/** /status 摘要行：五个数字回答"队列/台账是否健康"。 */
export function formatStatusLine(view: QueueView): string {
  return `队列/台账：排队 ${view.counts.queued} · 在途 ${view.counts.inflight} · 执行中 ${view.counts.running} · 孤儿 ${view.counts.orphan} · 最近拒绝 ${view.counts.rejected}`
}
