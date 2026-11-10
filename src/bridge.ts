// @input:  ./config, ./qq/* (types, api, sender), ./opencode/* (client, sessions), ./commands, ./core/*
// @output: createBridge, isAllowedUser, milestoneTargets, loadWatchedMap, saveWatchedMap,
//          （O7b 再导出）parsePermissionDecision, formatPermissionPrompt
// @pos:    根层 - 核心桥接: QQ 消息 -> OpenCode -> QQ 回复
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import { getAccessToken, sendC2CInputNotify, sendC2CMessage, sendGroupMessage } from "./qq/api.js"
import { prepareQQAttachments, augmentPromptWithAttachments, purgeOldQQImages } from "./qq/media.js"
import { normalizeForCommandGate } from "./qq/gateway.js"
import type { OpencodeClient, SessionMessage, PermissionRequest } from "./opencode/client.js"
import { collectReplyText, SupersededError, turnStateOf } from "./opencode/client.js"
import { createEventStream, type V2Event } from "./opencode/eventstream.js"
import { createAcpSessionRunner, isAcpPromptBusy, isAcpPromptTimeout } from "./opencode/acp-session.js"
import { readTransportSetting } from "./core/transport-setting.js"
import { summarizeInput, redactSecrets } from "./opencode/history.js"
import { SessionManager } from "./opencode/sessions.js"
import {
  buildHelpText,
  handleCommand,
  handlePendingSelection,
  isCommand,
  type CommandContext,
  type LedgerApi,
  type MirrorApi,
  type PendingSelection,
  type WatchApi,
} from "./commands.js"
import { createMirror } from "./core/mirror.js"
import { MessageQueue, previewText, agoLabel, intentKeyOf } from "./core/message-queue.js"
import { classifyProviderError, rescueText } from "./core/error-rescue.js"

const QUEUE_MAX = 20 // Q1：忙碌队列上限（学习 pi-qqbot queue.max 默认）
// 2026-11-05：队列完成回执（"队列 #N 完成（剩余 M 条）"）默认关闭——批量排空时
// 会放大主动消息配额消耗；排障/验收期设 QQ_QUEUE_RECEIPTS=1 打开。
const QUEUE_RECEIPTS_ENABLED = /^(1|true|on)$/i.test(process.env.QQ_QUEUE_RECEIPTS ?? "")
import {
  createPermissionGate,
  parsePermissionDecision,
  formatPermissionPrompt,
  formatPermissionConflictNotice,
  DECISION_LABELS,
} from "./core/permission.js"
import { truncate } from "./core/util.js"
import { createDelivery } from "./core/delivery.js"
import { createNotifySink } from "./core/notify-sink.js"
import { handleApprovalInteraction, sendApprovalCard } from "./core/card-approval.js"
import { createFormBridge, renderFormPrompt } from "./core/form-bridge.js"
import { parseQuestionForm, renderQuestion, parseAnswer, toFormContent, timeoutOutcome, type QuestionItem } from "./core/question-form.js"
import { recordMessage, resolveQuote, scopeKeyOf, extractEmbeddedQuote } from "./core/context-buffer.js"
import {
  claimInflightDetailed,
  recordInflight,
  settleInflight,
  pendingInflight,
  classifyInflight,
  markInflightPromptId,
  markInflightStage,
  listInflightView,
  INFLIGHT_MAX_AGE_MS,
  redispatchMaxAgeMs,
  type InflightEntry,
  type SettleReason,
} from "./core/inflight-journal.js"
import {
  deriveQueueView,
  formatQueueReply,
  formatLedgerReply,
  formatStatusLine,
  shortId,
  type QueueView,
} from "./core/queue-view.js"
import { messageFingerprint } from "./core/inbound-dedupe.js"
import { isPidAlive } from "./core/watchdog.js"
import { extractSendFileMarkers, sendLocalFile } from "./core/send-media.js"
import type { InteractionEvent } from "./qq/types.js"
// O7b：解析/格式化保持经 bridge 再导出——单测与既有调用方导入路径不变
export { parsePermissionDecision, formatPermissionPrompt, formatPermissionConflictNotice } from "./core/permission.js"

/** 传输选择（纯函数，灰度开关）：仅显式 acp 才走 ACP，其余一律 rest。 */
export function parseTransport(value: string | undefined): "acp" | "rest" {
  return /^acp$/i.test((value ?? "").trim()) ? "acp" : "rest"
}

// E 闲置回收纯函数（导出供测试，2026-10-29）：返回应回收的闲置会话 id——
// 超过 idleMs 无活动且未被 /watch 显式盯住的会话。
export function evictableIdleSessions(
  lastActivity: ReadonlyMap<string, number>,
  watched: ReadonlySet<string>,
  now: number,
  idleMs: number,
): string[] {
  const out: string[] = []
  for (const [sid, at] of lastActivity) {
    if (watched.has(sid)) continue
    if (now - at > idleMs) out.push(sid)
  }
  return out
}

// H2 停滞提醒决策（导出供测试，2026-10-30）：bgWait 零进展时提醒用户处置桌面弹窗。
// 首次：startedAt 后 firstMs；之后：上次进展/提醒后 intervalMs；最多 maxNudges 次。
// 停滞提醒附带任务状态（2026-11-03 用户拍板：提示语改为「执行超过 N 分钟｜状态：…」）。
// 状态源=回合边界归属（turnStateOf）+ 本地 turnStats 最近工具；纯文本无 markdown 依赖。
// 注意口径：本提醒只在「零进展」时触发（marker 无变化），所以 anchored 态几乎恒为
// 「已停滞（回合尚未终结）」——「执行中而仍发提醒」的语义留给 roundRunning=false 的
// 异常态表达，不臆造。
export function stallNudgeText(
  minsExec: number,
  s: { anchored: boolean; roundRunning: boolean; idleMin: number; lastAction?: string },
): string {
  const status =
    !s.anchored
      ? "状态不明（历史账无归属锚点）"
      : s.roundRunning
        ? "已停滞（回合尚未终结，可能被桌面端审批/选择弹窗阻塞）"
        : "已终结但未回传（异常）"
  const action = s.lastAction ? `｜最近动作：${s.lastAction}` : ""
  return `⚠️ 后台任务执行超过 ${minsExec} 分钟｜状态：${status}｜已 ${s.idleMin} 分钟无进展${action}\n桌面端确实空闲请忽略本提醒；或回复 /stop 中止该回合后重发。`
}

// H2 停滞提醒决策（导出供测试，2026-10-30）：bgWait 零进展时提醒用户处置桌面弹窗。
// 首次：startedAt 后 firstMs；之后：上次进展/提醒后 intervalMs；最多 maxNudges 次。
export function stallNudgeDecision(
  startedAt: number,
  lastProgressAt: number,
  nudges: number,
  now: number,
  firstMs: number,
  intervalMs: number,
  maxNudges: number,
): "nudge" | "wait" {
  if (nudges >= maxNudges) return "wait"
  const base = nudges === 0 ? startedAt : lastProgressAt
  const need = nudges === 0 ? firstMs : intervalMs
  return now - base >= need ? "nudge" : "wait"
}

// 停滞提醒数据快照（2026-11-09 立规，导出供测试）：一次取齐「展示用」执行/空闲分钟，
// 再返回下一次间隔的基准。顺序错乱会产出「执行 69 分钟｜已 0 分钟无进展」这类假数据
//（2026-11-09 事故实证：先置 lastProgressAt=now 再计算 idleMin）。
export function stallSnapshot(
  now: number,
  lastProgressAt: number,
  turnStartedAt: number,
): { idleMin: number; execMin: number; nextProgressAt: number } {
  return {
    idleMin: Math.max(0, Math.round((now - lastProgressAt) / 60_000)),
    execMin: Math.max(0, Math.round((now - turnStartedAt) / 60_000)),
    nextProgressAt: now,
  }
}

// ===== 后台进度心跳（2026-11-10 owner 裁定方案 A：长任务过程可见性）=====
// 背景：停滞提醒只在「零进展」时触发——活跃的长任务全程零可见（昨晚 69 分钟报告实证），
// 用户体验=「任务一下子没了」。裁定：转后台后每 15min 推送一条进度心跳，不设次数上限
// （直至完成/24h 放弃）；内容与停滞自检合流——心跳内联「无进展分钟」，任务假活时
// 用户从心跳文案即可看出；停滞提醒仍独立触发（同 tick 内提醒优先，避免双发）。
export const BG_HEARTBEAT_MS = 15 * 60_000

/** 心跳决策：距上次心跳（或挂起起点）满 interval 即推送。纯函数供测试。 */
export function heartbeatDecision(lastHeartbeatAt: number, now: number, intervalMs: number = BG_HEARTBEAT_MS): "beat" | "wait" {
  return now - lastHeartbeatAt >= intervalMs ? "beat" : "wait"
}

/** 心跳文案：进行中 + 已运行 + 最近动作 + 内联停滞自检（idle≥30min 明示疑似停滞）。纯函数供测试。 */
export function heartbeatText(execMin: number, idleMin: number, lastAction?: string): string {
  const action = lastAction ? `，刚才在处理【${lastAction}】` : ""
  const stale = idleMin >= 30 ? `。⚠️ 注意：已 ${idleMin} 分钟没有任何动静，疑似卡住——可发 /stop 中止后重发` : ""
  return `⏳ 你的任务还在后台执行：已用时 ${execMin} 分钟${action}${stale}。完成后我会自动把结果发给你。`
}

// ===== 无 idle 兜底（2026-11-10 僵尸心跳事故根修）=====
// 事故链：同一 msgId 被重复派发（08:43/08:47）→ 第二次 prompt 按接管语义打断第一次回合 →
// 该回合随后又被新消息接管致死——被杀的回合永远不产生 idle 行 → 完成检查 hasIdle 恒 false →
// 后台等待僵尸化 39 分钟假心跳（09:13/09:29 实证）。口径修正：「边界内有正文」即回合实质已完
// （与防线 A 同原则）——正文在但 idle 缺失且超过宽限期 → 按完成投递。
export const MISSING_IDLE_GRACE_MS = 10 * 60_000

/** 无-idle 完成判定：有正文 + 超过宽限期无新进展。纯函数供测试。 */
export function missingIdleDone(
  turn: { hasIdle: boolean; text: string },
  lastProgressAt: number,
  now: number,
  graceMs: number = MISSING_IDLE_GRACE_MS,
): boolean {
  return !turn.hasIdle && Boolean(turn.text) && now - lastProgressAt >= graceMs
}

interface Bridge {
  handleMessage: (ctx: MessageContext) => Promise<void>
  // HC2（2026-10-26）：暴露事件流句柄，index 侧链路自愈巡检需对其热换基
  eventStream: ReturnType<typeof createEventStream>
  // A 项（2026-10-29）：卡片按钮互动回调（index 侧挂到 QQ 网关 onInteraction）
  handleInteraction: (event: InteractionEvent) => void
  // R 项（2026-10-30 重启丢消息事故修复）：启动对账——补投/重挂/重派在途回合
  recoverInflightRounds: () => Promise<void>
}

export function createBridge(
  config: Config,
  client: OpencodeClient,
  sessions: SessionManager,
): Bridge {
  // H2 停滞提醒文案状态开关就用现成 env 读取风格；这里同步实现⑦开关——
  // 2026-11-03 用户拍板：「已收到」回执默认不发（非调试无价值），调试期在
  // ~/.openqq/.env 设 QQ_ACK_RECEIPT=1 开启。loadEnvFile 全量注入 process.env，
  // 排队回执「已排队 #N」为功能性提示不受此开关影响。
  const ackReceiptEnabled = /^(1|true|on)$/i.test(process.env.QQ_ACK_RECEIPT ?? "")

  const busyUsers = new Set<string>()
  // 队列 drain 会重入 handleMessage；标记本 ctx 已认领，避免把合法出队当成平台重投。
  const claimedContexts = new WeakSet<MessageContext>()
  // 修复⑦：队列 drain 重入的 ctx——受理回执跳过（drain 已有「开始执行队列」节点，
  // 不在同一 intent 上重复点头）。
  const drainReentries = new WeakSet<MessageContext>()
  // 忙碌期间按用户意图去重：不同 msgId 的相同问题/同图重发不得重复执行或重复排队。
  const activeIntents = new Map<string, string>()
  // Q1：忙碌消息队列（该用户当前回合结束后自动 drain）
  const msgQueue = new MessageQueue(QUEUE_MAX)
  const draining = new Set<string>()
  // 队列 drain 重入的 ctx → 队列编号（完成回执/诊断用；WeakMap 不阻回收）
  const queueIdOfCtx = new WeakMap<MessageContext, number>()
  // Persist greeted users to disk so restarting the bot doesn't re-send the
  // full command list to every user on their next message.
  const greeted = loadGreetedSet()
  const pendingSelections = new Map<string, PendingSelection>()

  // ===== 实时观察 / 回合过程推送 =====
  // 单条 SSE 连接按 sessionID 分流，多订阅者共享（同会话同 userId Set 去重不双发）。
  // 里程碑投递 = /watch 专属（2026-10-14 拍板）；sessionSubs 只管 SSE 活性与去重。
  const eventStream = createEventStream(client.baseUrl)
  const sessionSubs = new Map<string, Set<string>>()   // sessionID -> userIds
  const sessionUnsubs = new Map<string, () => void>()  // sessionID -> SSE 退订
  const activeWatches = new Map<string, string>()      // userId -> sessionID（/watch 显式订阅）
  const lastCtx = new Map<string, MessageContext>()    // userId -> 最近消息 ctx（推送通道选择依据）
  const bgWaits = new Map<string, { cancel: () => void }>() // 会话 -> 后台等待
  const callCache = new Map<string, string>()              // callID -> 命令摘要（⚠️ 上下文用）
  // Q2：会话工具统计（/progress 手动查询用，本地事件源，零模型成本）
  const turnStats = new Map<string, { tools: number; failed: number; lastTool: string; lastAt: number }>()

  // E（2026-10-29 同步升级，吸收 dsh session/idle-evictor）：闲置会话回收——
  // 长期无活动的会话退订 SSE，降 opencode 服务端事件扇出；/watch 显式盯着的
  // 会话豁免；用户再来消息时 subscribeSession 会重新挂上。env QQ_SESSION_IDLE_HOURS。
  const sessionLastActivity = new Map<string, number>()
  const IDLE_EVICT_MS = (() => {
    const h = Number(process.env.QQ_SESSION_IDLE_HOURS ?? "6")
    return Number.isFinite(h) && h > 0 ? Math.floor(h * 3600_000) : 6 * 3600_000
  })()
  setInterval(() => {
    const now = Date.now()
    for (const sid of evictableIdleSessions(sessionLastActivity, new Set(activeWatches.values()), now, IDLE_EVICT_MS)) {
      sessionUnsubs.get(sid)?.()
      sessionUnsubs.delete(sid)
      sessionSubs.delete(sid)
      sessionLastActivity.delete(sid)
      console.log(`[bridge] 闲置会话已回收（${Math.round(IDLE_EVICT_MS / 3600_000)}h 无活动）: ${sid}`)
    }
  }, 30 * 60 * 1000)

  function subscribeSession(sessionID: string, userId: string): void {
    sessionLastActivity.set(sessionID, Date.now())
    if (!sessionSubs.has(sessionID)) {
      sessionSubs.set(sessionID, new Set())
      sessionUnsubs.set(
        sessionID,
        eventStream.subscribe(sessionID, (ev) => onSessionEvent(sessionID, ev)),
      )
    }
    sessionSubs.get(sessionID)!.add(userId)
  }

  function unsubscribeSession(sessionID: string, userId: string): void {
    const set = sessionSubs.get(sessionID)
    if (!set) return
    set.delete(userId)
    if (set.size === 0) {
      sessionSubs.delete(sessionID)
      sessionUnsubs.get(sessionID)?.()
      sessionUnsubs.delete(sessionID)
      sessionLastActivity.delete(sessionID)
    }
  }

  function onSessionEvent(sessionID: string, ev: V2Event): void {
    sessionLastActivity.set(sessionID, Date.now())
    // Q2：本地工具统计（/progress 查询数据源，动作类才计——文件类不算进度）
    const d = (ev.data ?? {}) as Record<string, any>
    if (ev.type === "session.tool.called" || ev.type === "session.tool.success") {
      const cmd = typeof d.input === "string" ? d.input : d.input?.command
      const actionable = ev.type === "session.tool.success" || (typeof cmd === "string" && cmd.trim())
      if (actionable) {
        const st = turnStats.get(sessionID) ?? { tools: 0, failed: 0, lastTool: "", lastAt: 0 }
        if (ev.type === "session.tool.called") {
          st.tools++
          st.lastTool = cmd.length > 60 ? `${String(cmd).slice(0, 60)}…` : String(cmd) // 截断必带省略号（UAT 实证：硬切被用户误读为坏文本）
        } else if (typeof d.metadata?.exit === "number" && d.metadata.exit !== 0) {
          st.failed++
        }
        st.lastAt = Date.now()
        turnStats.set(sessionID, st)
      }
    }
    const line = formatMilestone(ev, callCache)
    if (!line) return
    // 2026-10-14 用户拍板：里程碑只投 /watch 显式订阅者——自身回合回显与
    // 会话订阅表的其他来源一律不再隐式携带（镜像只发📋摘要卡）。
    for (const userId of milestoneTargets(activeWatches, sessionID)) enqueuePush(userId, line)
  }

  // ===== 摘要镜像域已随 O7d 收进 core/mirror.ts（订阅/在途标记/解锁/摘要投递）=====

  // ===== 后台等待：前台超时后不放弃，任务完成时回传结果 =====
  // SSE execution.succeeded 即时触发 + 5 分钟轮询兜底（防 SSE 断连漏事件），
  // 上限 24 小时。用户在同一会话发起新回合时被取代（避免同一结果投递两次）。
  const BG_WAIT_MAX_MS = 24 * 60 * 60 * 1000
  // P0-1（2026-11-09 69 分钟答案丢失事故）：完成检测 = SSE 即时 + 轮询兜底。
  // 轮询从 5min 收紧到 1min——SSE 断连窗口内完成判定最坏延迟 5min→1min，
  // 与「新输入接管（cancel）」竞态的丢失窗口同步收窄。
  const BG_POLL_MS = 60_000

  // H2（2026-10-30，昨晚卡死事故复盘）：桌面审批/选择弹窗对 bot 无通道（V2 无
  // question API，C 项已证伪）——共享会话会被"桌面弹窗挂起"传导性卡死，且静默。
  // bgWait 期间检测"零进展停滞"，主动提醒用户：去桌面端处理弹窗，或用 /stop 终止。
  const STALL_FIRST_NUDGE_MS = 30 * 60 * 1000
  const STALL_NUDGE_INTERVAL_MS = 30 * 60 * 1000
  const STALL_NUDGE_MAX = 3

  function startBackgroundWait(sessionId: string, ctx: MessageContext, baseline: number, trackId?: string, promptId = "", turnStartedAt?: number): void {
    // 同会话只允许一个后台等待：恢复多条在途账/超时重挂不得留下多个完成回调重复投递。
    bgWaits.get(sessionId)?.cancel()
    let cancelled = false
    let finished = false
    const startedAt = Date.now()
    // 2026-11-09 修正：执行时长按「回合真实起点」展示（跨重启用台账 at），
    // 重启不再把 69 分钟的任务显示成 30 分钟；停滞提醒的调度仍从本次挂起算起，
    // 避免重启后立刻对健康回合误报停滞。
    const execStartAt = turnStartedAt && turnStartedAt > 0 ? turnStartedAt : startedAt
    let lastProgressAt = startedAt
    let nudges = 0
    let lastMarker = ""
    let lastHeartbeatAt = startedAt // 方案 A：进度心跳调度起点
    let probeFails = 0 // 服务不可达计数（≥5 一次性告警）
    let unreachableAlerted = false

    const cleanup = (): void => {
      cancelled = true
      unsub()
      clearInterval(pollTimer)
      clearTimeout(giveupTimer)
      bgWaits.delete(sessionId)
      // 被新回合取代（cancel 路径）时结清旧账——否则后台空账永久残留：安全重启
      // 永远等不到空闲、重启恢复会误重挂/补投旧答案（2026-11-05 实证两条僵尸账）。
      // finish 路径会先置 finished=true 并按 answered/expired 结清，此处不再覆盖。
      if (!finished && trackId) {
        // P0-1（2026-11-09 69 分钟答案丢失事故根修）：接管前必须先核实旧回合是否
        // 「已完成未投递」——旧实现直接 superseded 销账，完成于竞态窗口内的答案
        //（如长报告）会被无声丢弃（用户侧=卡在在途后永远无回复）。
        void rescueThenSettle(trackId)
      } else {
        mirror.scheduleUnlock(sessionId)
      }
    }

    /** 接管前抢救：旧回合已有产出 → 先投递结果再按 answered 销账；否则 superseded。 */
    async function rescueThenSettle(tid: string): Promise<void> {
      try {
        const probe = await client.session.messages({ path: { id: sessionId } })
        if (finished) return // 探测期间 finish 已赢 race（已结算/已投递），不得双投
        const turn = turnStateOf(probe?.data ?? [], promptId, baseline)
        if (turn.text) {
          finished = true
          settleInflight(tid, undefined, "answered")
          mirror.scheduleUnlock(sessionId)
          void drainQueue(ctx.userId)
          // 投递失败不得上抛：账已结清，补投失败由 deliver 层自己的重试/降级负责
          await safeDeliver(ctx, `📤 你发来新消息前，上一回合已完成，结果如下：\n\n${turn.text}`).catch(() => {})
          console.log(`[bridge] 接管前抢救：后台回合已完成且未投递，结果已补投 session=${sessionId}`)
          return
        }
      } catch {
        /* 探测失败落到 superseded 结算（原语义） */
      }
      settleInflight(tid, undefined, "superseded")
      mirror.scheduleUnlock(sessionId)
    }

    /** 完成判定+文本提取统一走回合边界归属（修复⑧）；锚点完整时用注释里的分布 */
    function classifyNow(listJson: { data?: SessionMessage[] } | undefined): { done: boolean; text: string } {
      const msgs = listJson?.data ?? []
      const turn = turnStateOf(msgs, promptId, baseline)
      if (!turn.anchored) return { done: turn.hasIdle, text: collectReplyText(msgs, baseline) }
      // 有 idle 才算完；超早事件（别回合完成唬人）由调用方跳过
      return { done: turn.hasIdle, text: turn.text }
    }

    async function finish(kind: "done" | "giveup" | "superseded"): Promise<void> {
      if (cancelled || finished) return
      // 修复⑧防早交：SSE 的 execution.succeeded / 别回合 idle 可能唬人——
      // promptId 锚点可用时先核实本回合是否真的有 idle 终结标记。
      // DEF-qqbot-20261107-P2：核实同时检查「被同会话新输入接管」——SSE 完成事件
      // 落在死回合上时改按被打断终态结算，不交付「后台任务完成」假结果。
      if (kind === "done" && promptId) {
        try {
          const probe = await client.session.messages({ path: { id: sessionId } })
          const turn = turnStateOf(probe?.data ?? [], promptId, baseline)
          if (turn.anchored && turn.superseded) return finish("superseded")
          // 2026-11-10 修正：无 idle 但有正文=被杀回合实质已完（重复派发→接管打断链不产生 idle），
          // 不得再以「本回合尚未结束」为由忽略——正文在即交付（与防线 A 同口径）。
          if (turn.anchored && !turn.hasIdle && !turn.text) {
            console.log(`[bridge] 忽略他回合完成事件（本后台回合尚未结束）session=${sessionId}`)
            return
          }
        } catch {
          /* 探测失败落到既定逻辑，不当早交 */
        }
      }
      finished = true
      // R 项：先销账再清理——cleanup 对未完成（被取代）路径按 superseded 结清，
      // 顺序必须账清在前，否则原因会被 superseded 覆盖（settle 幂等，后写不生效）。
      if (trackId) settleInflight(trackId, undefined, kind === "done" ? "answered" : kind === "giveup" ? "expired" : "superseded")
      cleanup()
      // Q1：后台等待终态 → 放行该用户队列（此前为串行而挂起）
      void drainQueue(ctx.userId)
      if (kind === "superseded") {
        // DEF-qqbot-20261107-P2：后台等到的回合已被同会话新输入接管——任务已死，
        // 明确交代而非沉默到 24 小时 giveup。
        console.log(`[bridge] 后台回合被同会话新输入接管（superseded）session=${sessionId}`)
        await safeDeliver(ctx, "⚠️ 后台任务被同会话的新输入打断，未产出结果；如需结果请重新发送")
        return
      }
      if (kind === "giveup") {
        await safeDeliver(ctx, "⚠️ 后台任务 24 小时仍未完成，停止自动跟进；结果可随时用 /history 查询")
        return
      }
      // SSE 完成事件后给最终消息落库留 2 秒余量，避免读到半截
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const listJson = await client.session.messages({ path: { id: sessionId } })
        const { text } = classifyNow(listJson)
        await safeDeliver(
          ctx,
          text
            ? `📤 后台任务完成，结果如下：\n\n${text}`
            : "📤 后台任务完成（无文本产出），详情可用 /history 查看",
        ).catch((error) => console.error("[bridge] 后台完成结果投递失败（账已结清）:", error))
        console.log(`[bridge] 会话 ${sessionId} 后台等待已交付`)
      } catch (error) {
        console.error("[bridge] 后台完成结果获取失败:", error)
      }
    }

    async function tick(): Promise<void> {
      if (cancelled || finished) return
      try {
        const listJson = await client.session.messages({ path: { id: sessionId } })
        probeFails = 0
        unreachableAlerted = false
        const msgs = listJson?.data ?? []

        // H2 停滞检测：消息数或最新 created 变化=有进展；零进展超窗则提醒用户。
        // 回合状态先于提醒计算（2026-11-03：提醒文案要带「执行中/已停滞/状态不明」）。
        const turn = turnStateOf(msgs, promptId, baseline)
        let maxCreated = 0
        for (const m of msgs) {
          const created = m.time?.created ?? 0
          if (created > maxCreated) maxCreated = created
        }
        const marker = `${msgs.length}:${maxCreated}`
        const now = Date.now()
        if (marker !== lastMarker) {
          lastMarker = marker
          lastProgressAt = now
        } else if (
          stallNudgeDecision(startedAt, lastProgressAt, nudges, now, STALL_FIRST_NUDGE_MS, STALL_NUDGE_INTERVAL_MS, STALL_NUDGE_MAX) === "nudge"
        ) {
          nudges += 1
          // 2026-11-09 修数据错：原实现先把 lastProgressAt 置为 now 再算 idleMin，
          // 导致提醒恒为「已 0 分钟无进展」。先取快照再重置（重置只用于下次间隔）。
          const snap = stallSnapshot(now, lastProgressAt, execStartAt)
          lastProgressAt = snap.nextProgressAt
          const st = turnStats.get(sessionId)
          const lastAction = st?.lastTool && st?.lastAt ? `${st.lastTool}（${agoLabel(st.lastAt)}）` : undefined
          console.log(`[bridge] 后台任务状态通告 #${nudges} session=${sessionId} anchored=${turn.anchored} idleMin=${snap.idleMin}`)
          void safeDeliver(
            ctx,
            stallNudgeText(snap.execMin, {
              anchored: turn.anchored,
              roundRunning: turn.anchored && !turn.hasIdle,
              idleMin: snap.idleMin,
              lastAction,
            }),
          ).catch(() => {})
        } else if (heartbeatDecision(lastHeartbeatAt, now) === "beat") {
          // 方案 A 进度心跳（2026-11-10 owner 裁定）：活跃长任务的过程可见性。
          // 无次数上限（至完成/24h 放弃）；内联 idle 自检——任务假活时用户可从
          // 文案直接看出；同 tick 停滞提醒优先（else-if 天然互斥，不双发）。
          lastHeartbeatAt = now
          const hbIdleMin = Math.max(0, Math.round((now - lastProgressAt) / 60_000))
          const hbExecMin = Math.max(0, Math.round((now - execStartAt) / 60_000))
          const hbSt = turnStats.get(sessionId)
          const hbAction = hbSt?.lastTool && hbSt?.lastAt ? `${hbSt.lastTool}（${agoLabel(hbSt.lastAt)}）` : undefined
          console.log(`[bridge] 后台任务进度心跳 session=${sessionId} execMin=${hbExecMin} idleMin=${hbIdleMin}`)
          void safeDeliver(ctx, heartbeatText(hbExecMin, hbIdleMin, hbAction)).catch(() => {})
        }

        if (turn.superseded) {
          // DEF-qqbot-20261107-P2：死回合立即按被打断终态结算（交付+销账在 finish）
          await finish("superseded")
        } else if (turn.hasIdle || missingIdleDone(turn, lastProgressAt, now)) {
          // 2026-11-10 僵尸事故根修：被杀回合无 idle（重复派发→接管打断链），
          // 有正文+超宽限即实质已完，按完成投递，杜绝假心跳僵尸。
          await finish("done")
        }
      } catch (error) {
        probeFails += 1
        console.error(`[bridge] 后台等待轮询失败(第${probeFails}次):`, error)
        // 挂死分级处置（2026-11-10 方案 A 配套）：OpenCode 服务不可达时一次性明示，
        // 用户知晓「状态未知」而非误以为任务在进行；恢复后自动续跳并重置计数。
        if (probeFails >= 5 && !unreachableAlerted) {
          unreachableAlerted = true
          void safeDeliver(
            ctx,
            "⚠️ OpenCode 服务连续不可达：后台任务状态未知（可能仍在执行）。服务恢复后自动继续跟踪；也可用 /history 查看会话进展。",
          ).catch(() => {})
        }
      }
    }

    const unsub = eventStream.subscribe(sessionId, (ev) => {
      if (ev.type === "session.execution.succeeded") void finish("done")
    })
    const pollTimer = setInterval(() => void tick(), BG_POLL_MS)
    const giveupTimer = setTimeout(() => void finish("giveup"), BG_WAIT_MAX_MS)
    bgWaits.set(sessionId, { cancel: cleanup })
    if (trackId) markInflightStage(trackId, "background", { sessionId })
    console.log(`[bridge] 会话 ${sessionId} 转入后台等待（最长 ${BG_WAIT_MAX_MS / 3_600_000} 小时）`)
  }

  const watchApi: WatchApi = {
    start(userId, sessionID, ctx) {
      const prev = activeWatches.get(userId)
      if (prev && prev !== sessionID) unsubscribeSession(prev, userId)
      activeWatches.set(userId, sessionID)
      lastCtx.set(userId, ctx)
      subscribeSession(sessionID, userId)
      saveWatchedMap(activeWatches) // R2-P1-3：落盘，重启恢复
      return [
        `👁 已开启观察：${sessionID}`,
        "该会话的工具调用/执行完成会实时推送摘要，/watch off 停止。",
        "（≥2 秒节流合并；QQ 主动消息有日配额，被动窗口内不受限）",
      ].join("\n")
    },
    stop(userId) {
      const sid = activeWatches.get(userId)
      if (!sid) return "当前没有开启观察"
      activeWatches.delete(userId)
      unsubscribeSession(sid, userId)
      saveWatchedMap(activeWatches) // R2-P1-3：落盘，重启不复活
      return `已停止观察：${sid}`
    },
    status(userId) {
      const sid = activeWatches.get(userId)
      return sid ? `👁 观察中：${sid}` : "未开启观察"
    },
  }

  // O7c：投递域门面（统一投递/降级/配额/节流队列/被动回复全在 core/delivery.ts）
  const { enqueuePush, safeDeliver, sendReply, deliver } = createDelivery(config, lastCtx)
  // DEF-1 修复（2026-11-04，UAT 实证）：通知类发送永不阻断主流程——受理回执/
  // K2 拦截/排队提示/问候等裸 sendReply 一旦被平台拒（40034024/超时）会直接
  // 中断 handleMessage（实证：回执失败 → 回合未派发给 AI 即结算，用户消息被吞）。
  // 统一走 notifyUser 兜底：发送失败仅告警，主流程继续。
  const notifyUser = async (ctx: MessageContext, text: string): Promise<void> => {
    try {
      await sendReply(ctx, text)
    } catch (error) {
      console.warn("[bridge] 通知发送失败（不阻断主流程）:", toErrorMessage(error))
    }
  }

  // O7b：审批域门面（挂起槽/等待/裁决/跨重启恢复全在 core/permission.ts）
  const perm = createPermissionGate({
    client,
    sendReply,
    safeDeliver,
    // 2026-11-05 举一反三：审批槽清空（裁决/TTL）即唤醒该用户队列——否则挂起期间
    // 入队的消息要等用户再发一条才会动（drainQueue 的 pendingPerm 守卫无人解除）。
    onDecision: (userId) => void drainQueue(userId),
    // A 项：审批卡片发送（失败自动降级文字菜单，permission 域内处理）；origin 穿透到卡片正文
    sendApprovalPrompt: (ctx, request, mainSessionId, origin) =>
      sendApprovalCard({ appId: config.qq.appId, clientSecret: config.qq.clientSecret }, ctx, request, mainSessionId, origin),
  })

  // O7d：摘要镜像域门面（订阅/回合标记/延迟解锁/摘要投递全在 core/mirror.ts）
  const mirror = createMirror({ sessions, eventStream, client, lastCtx, safeDeliver, bgWaits, busyUsers })

  // openqq notify 外部入队通道（feature：headless 定时任务结果推送，2026-11-05 外部提案 Part1）：
  // cron/CI 任意进程经 `openqq notify` 写 ~/.openqq/outbox.json（只入队），bot 进程消费投递。
  // delivery 全量复用（配额/降级/分条/24h 同文去重）；TTL 过期丢弃；失败退避重试到上限。
  createNotifySink({
    config,
    deliver: (ctx, text) => deliver(ctx, text),
    ...(process.env.QQ_OUTBOX_FILE ? { filePath: process.env.QQ_OUTBOX_FILE } : {}),
  })

  // L 项（2026-10-30）：表单桥（选择弹窗 A/B/C/D 的 QQ 同步与作答回传）。
  // 与审批共用"每用户单一交互槽"心智：表单挂起时优先消费用户回复。
  // 按钮卡片（弹窗验证前置）：选项直点直交，失败自动降级文字编号作答。
  const formBridge = createFormBridge({
    client,
    sendReply,
    safeDeliver,
    sendFormCard: async (ctx, form, keyboard) => {
      try {
        const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
        const text = renderFormPrompt(form)
        if (ctx.type === "group" && ctx.groupId) {
          await sendGroupMessage(token, ctx.groupId, text, ctx.msgId || undefined, undefined, true, keyboard)
        } else {
          await sendC2CMessage(token, ctx.userId, text, ctx.msgId || undefined, undefined, true, keyboard)
        }
        return true
      } catch (error) {
        console.error("[bridge] 表单卡片发送失败，降级文字:", error instanceof Error ? error.message : error)
        return false
      }
    },
  })

  // L 项：常驻交互监听——轮询全局待答权限 + 表单，反查 QQ 用户后推送。
  // 覆盖"桌面端回合发起的交互"（昨晚事故盲区）：bot 空闲时也能把弹窗送到 QQ。
  const INTERACTION_WATCH_MS = (() => {
    const n = Number(process.env.QQ_INTERACTION_WATCH_SECONDS ?? "12")
    return Number.isFinite(n) && n >= 0 ? Math.floor(n * 1000) : 12_000
  })()

  function usersOfSession(sessionID: string): string[] {
    return sessions
      .all()
      .filter((e) => e.sessionId === sessionID)
      .map((e) => e.userId)
  }

  function ctxForUser(userId: string): MessageContext {
    return (
      lastCtx.get(userId) ?? { type: "c2c", userId, msgId: "", content: "", timestamp: String(Date.now()) }
    )
  }

  // ACP 迁移（P2）：QQ 侧 turn 的传输选择。默认 rest；灰度验证后切 acp。
  // acp 模式下：turn 走 session/prompt，审批走 session/request_permission（引擎阻塞），
  // 常驻权限轮询停用（表单轮询保留到 P3）。
  const TRANSPORT: "acp" | "rest" = parseTransport(process.env.QQBOT_TRANSPORT ?? readTransportSetting())
  const acpRunner =
    TRANSPORT === "acp"
      ? createAcpSessionRunner({
          cwd: process.env.QQBOT_ACP_CWD ?? process.cwd(),
          sessions,
          // 会话归属目录解析（对齐官方 ACP getSession 校验）：load 前从服务端详情取
          // location.directory，缓存缺失/目录漂移时按真实目录重试，避免 -32602 后误新建
          resolveDirectory: async (sessionId) => {
            try {
              const detail = await client.session.get({ path: { id: sessionId } })
              return detail?.data?.location?.directory ?? undefined
            } catch {
              return undefined
            }
          },
          handlers: {
            onPermission: async (userId, view) => {
              const pctx = ctxForUser(userId)
              const request = {
                id: view.id,
                sessionID: view.sessionID,
                action: view.action,
                resources: view.resources,
              }
              const decision = await perm.waitForDecision(pctx, request, view.sessionID)
              const text =
                decision === "reject"
                  ? "已拒绝，该操作不会执行；AI 将继续其余步骤"
                  : `已${DECISION_LABELS[decision]}，AI 将继续执行…`
              void safeDeliver(pctx, text)
              return decision
            },
            onElicitation: (userId, params) => handleElicitation(userId, params),
            // 会话没有超时限（2026-11-08 用户口径）：满 30 分钟只通知「转后台继续」，
            // 回合继续跑、完成即回传；串行链保持占用，队列不会提前推进。
            onPromptNotice: (userId, sessionId) => {
              console.log(`[bridge] 回合前台等待满 30 分钟，转后台继续 sid=${shortId(sessionId)} user=${userId.slice(0, 8)}…`)
              const ctx = lastCtx.get(userId) ?? ctxForUser(userId)
              void safeDeliver(
                ctx,
                "⏳ 本轮已执行满 30 分钟，仍在继续（前台等待结束，已转后台），完成即回传；可 /stop 中止。",
              )
            },
          },
        })
      : null
  if (acpRunner) console.log("[bridge] transport=acp（ACP 传输启用；权限由 session/request_permission 阻塞）")

  // P5 健康自检（看门狗）：60s 一次，只检查 ACP 传输存活/握手，不查权限等业务接口。
  // 失败时尝试进程内自愈（修传输不动进程）；连续 3 次自愈失败 → 退出码 42 把处置权
  // 交还外部监督者（systemd WATCHDOG=trigger 同款语义：内部修不好就上报换进程）。
  if (acpRunner) {
    let acpRestartFails = 0
    const timer = setInterval(() => {
      if (acpRunner.running) {
        acpRestartFails = 0
        return
      }
      console.warn("[watchdog] ACP 传输不存活，尝试重启")
      void acpRunner.start().then(
        () => {
          acpRestartFails = 0
        },
        (error) => {
          acpRestartFails++
          console.error(`[watchdog] ACP 重启失败（${acpRestartFails}/3）:`, error instanceof Error ? error.message : error)
          if (acpRestartFails >= 3) {
            console.error("[watchdog] ACP 连续自愈失败 3 次，进程以退出码 42 移交外部监督者")
            process.exit(42)
          }
        },
      )
    }, 60_000)
    timer.unref?.()
  }

  // P3 表单/提问（ACP elicitation）：question 工具的一道题在 schema 里会拆成
  // q0 + q0_custom 两个属性，必须合并回一道题；多题按顺序逐条问，全部答完后一次性 accept。
  // 2026-11-08 修复：此前「字段>1 就 decline（回退桌面）」，而 question 永远带 custom 伴生字段，
  // 导致 question 工具在 QQ 侧 100% 不可用（用户只看到 "The question couldn't be shown…"）。
  interface PendingAcpElicitation {
    questions: QuestionItem[]
    answers: Array<{ item: QuestionItem; value: string | string[]; custom: boolean }>
    index: number
    resolve: (value: unknown) => void
    timer: ReturnType<typeof setTimeout>
  }
  const pendingElicitations = new Map<string, PendingAcpElicitation>()
  // 时限统一表（2026-11-08 用户拍板「统一三十分钟」）：
  //   提问/表单 30 分钟 → 未答按「跳过」（无必填）或「中止」（有必填）
  //   审批       30 分钟 → 自动拒绝（fail-closed，见 core/permission.ts）
  //   prompt 回合 30 分钟 → cancel 释放会话（见 opencode/acp.ts）
  const ELICITATION_TTL_MS = 30 * 60_000

  function askCurrentQuestion(userId: string, pending: PendingAcpElicitation): void {
    const item = pending.questions[pending.index]
    if (!item) return
    void safeDeliver(ctxForUser(userId), renderQuestion(item, pending.index, pending.questions.length))
  }

  async function handleElicitation(userId: string, params: Record<string, unknown>): Promise<unknown> {
    const pctx = ctxForUser(userId)
    if (params.mode === "url") {
      // URL 模式需要浏览器打开授权链接，QQ 侧无法承接；且我们未声明 url 能力
      void safeDeliver(pctx, "（该请求需要在浏览器里完成授权，请在桌面端处理）")
      return { action: "decline" }
    }
    const questions = parseQuestionForm(params.requestedSchema)
    if (!questions) {
      void safeDeliver(pctx, "（表单没有可填字段，已取消）")
      return { action: "cancel" }
    }
    // 同一用户已有挂起提问：旧的作废，避免答案串线
    const stale = pendingElicitations.get(userId)
    if (stale) {
      clearTimeout(stale.timer)
      pendingElicitations.delete(userId)
      stale.resolve({ action: "cancel" })
    }
    console.log(
      `[elicitation] 推送提问 user=${userId.slice(0, 8)}… 题数=${questions.length} 首题=${questions[0]?.title ?? ""}`,
    )
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingElicitations.delete(userId)
        // 2026-11-08 语义修正：沉默 ≠ 用户拒绝。无必填时按「未答」继续（工具会写成
        // Unanswered，模型自行推进），只有必填题未答才中止——与上游 question 工具
        // 的 cancelled=「用户拒绝」语义严格区分。
        const outcome = timeoutOutcome(pending.questions, pending.answers)
        if (outcome.action === "accept") {
          console.log(`[elicitation] 超时跳过 user=${userId.slice(0, 8)}… 已答 ${pending.answers.length}/${pending.questions.length}`)
          void safeDeliver(pctx, "⏰ 30 分钟未作答，已按「未答」继续（AI 按默认推进；/history 可查看）")
        } else {
          console.log(`[elicitation] 超时中止 user=${userId.slice(0, 8)}… 存在未答必填题`)
          void safeDeliver(pctx, "⏰ 30 分钟未作答，且该题为必填，已中止本次提问")
        }
        resolve(outcome)
      }, ELICITATION_TTL_MS)
      const pending: PendingAcpElicitation = { questions, answers: [], index: 0, resolve, timer }
      pendingElicitations.set(userId, pending)
      askCurrentQuestion(userId, pending)
    })
  }

  /** 处理用户对提问的回复；返回 true=已消费（不再进 agent）。 */
  function tryResolveElicitation(userId: string, content: string): boolean {
    const pending = pendingElicitations.get(userId)
    if (!pending) return false
    const text = content.trim()
    const pctx = ctxForUser(userId)
    if (/^(取消|cancel|退出|算了|放弃)$/i.test(text)) {
      clearTimeout(pending.timer)
      pendingElicitations.delete(userId)
      pending.resolve({ action: "cancel" })
      void safeDeliver(pctx, "已取消")
      return true
    }
    const item = pending.questions[pending.index]
    if (!item) {
      clearTimeout(pending.timer)
      pendingElicitations.delete(userId)
      pending.resolve({ action: "cancel" })
      return true
    }
    const parsed = parseAnswer(item, text)
    if (!parsed.ok) {
      void safeDeliver(pctx, "没看懂，请按提示回复（或回复「取消」）")
      return true
    }
    pending.answers.push({ item, value: parsed.value, custom: parsed.custom })
    pending.index += 1
    if (pending.index < pending.questions.length) {
      askCurrentQuestion(userId, pending)
      return true
    }
    clearTimeout(pending.timer)
    pendingElicitations.delete(userId)
    pending.resolve({ action: "accept", content: toFormContent(pending.answers) })
    const summary = pending.answers
      .map((a) => `${a.item.title}=${Array.isArray(a.value) ? a.value.join("/") : a.value}`)
      .join("；")
    console.log(`[elicitation] 已作答 user=${userId.slice(0, 8)}… ${summary}`)
    void safeDeliver(pctx, pending.questions.length > 1 ? "已提交全部回答" : "已提交")
    return true
  }

  async function interactionTick(): Promise<void> {
    try {
      // ACP 模式下权限由 session/request_permission 实时承接，轮询只留表单（P3 再移除）。
      if (TRANSPORT !== "acp") {
        const [permRes] = await Promise.all([client.permission.list()])
        for (const req of permRes?.data ?? []) {
          for (const uid of usersOfSession(req.sessionID)) {
            if (perm.hasPending(uid)) continue // 单一槽：在挂起（含同 id）即跳过
            perm.pushExternal(uid, ctxForUser(uid), req, req.sessionID)
          }
        }
      }
      // ACP 模式下表单由 elicitation/create 实时承接；轮询只留 REST 兼容路径。
      if (TRANSPORT !== "acp") {
        for (const entry of sessions.all()) {
          const forms = (await client.form.list({ sessionID: entry.sessionId }).catch(() => undefined))?.data ?? []
          for (const form of forms) {
            // 会话级列表返回 Form.Info（无 state）；带 state 时只推 pending
            const state = (form as { state?: { status?: string } }).state
            if (state && state.status !== "pending") continue
            formBridge.pushForm(entry.userId, ctxForUser(entry.userId), form)
          }
        }
      }
    } catch (error) {
      console.error("[interaction-watch] 轮询失败:", error instanceof Error ? error.message : error)
    }
  }

  if (INTERACTION_WATCH_MS > 0 && TRANSPORT !== "acp") {
    setInterval(() => void interactionTick(), INTERACTION_WATCH_MS)
    console.log(`[interaction-watch] 常驻交互监听已启动（每 ${INTERACTION_WATCH_MS / 1000}s 轮询权限+表单）`)
  }

  // 事件驱动权限推送（2026-11-08，DEF-qqbot-20261107-1 根因修复）。
  // 桌面端走 /api/event 的 permission.asked 即时弹窗，引擎会停在裁决前；
  // bot 原先只靠 12s 轮询，取到时请求常已被引擎自行放行。这里复用同一条 SSE：
  // 事件到达即推 QQ 卡，12s 轮询保留为断线兜底（双防线）。
  eventStream.subscribeAll((ev) => {
    if (ev.type === "permission.replied") {
      // 联动清槽（2026-11-09）：源头（桌面端/引擎/账号规则）已解决该请求 →
      // 同步撤销 QQ 挂起槽并回执，消除「桌面板了 QQ 卡悬空/TTL 误杀」的双通道孤岛。
      const d = (ev.data ?? {}) as { sessionID?: string; requestID?: string; reply?: unknown }
      if (d?.requestID) perm.clearIfResolved(d.sessionID, d.requestID, d.reply)
      return
    }
    if (ev.type !== "permission.asked") return
    const req = ev.data as unknown as PermissionRequest | undefined
    if (!req?.id || !req.sessionID) return
    for (const uid of usersOfSession(req.sessionID)) {
      if (perm.hasPending(uid)) continue
      console.log(`[perm-event] permission.asked 即时推送 user=${uid.slice(0, 8)}… request=${req.id}`)
      perm.pushExternal(uid, ctxForUser(uid), req, req.sessionID)
    }
  })

  const mirrorApi: MirrorApi = mirror.api

  // Q1：队列/台账派生视图（三源 join：内存队列 + 磁盘台账 + 运行态）
  function queueViewFor(userId: string): QueueView {
    const journal = listInflightView()
    const session = sessions.getSession(userId)
    return deriveQueueView({
      entries: [...journal.inflight, ...journal.settled].filter((e) => e.userId === userId),
      jobs: msgQueue.list(userId),
      runtime: {
        busy: busyUsers.has(userId),
        draining: draining.has(userId),
        ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
        bgSessions: new Set(bgWaits.keys()),
      },
    })
  }

  // Q1：队列命令实现（2026-11-05：/queue 默认 join 台账，不再只看内存）
  const queueApi = {
    list: (userId: string): string => formatQueueReply(queueViewFor(userId), { limit: QUEUE_MAX }),
    listAll: (userId: string, page = 1): string =>
      formatQueueReply(queueViewFor(userId), { all: true, page, limit: QUEUE_MAX }),
    summary: (userId: string): string => formatStatusLine(queueViewFor(userId)),
    clear: (userId: string): number => {
      const jobs = [...msgQueue.list(userId)]
      for (const job of jobs) {
        if (job.ctx.msgId) settleInflight(job.ctx.msgId, undefined, "cancelled")
      }
      const n = msgQueue.clear(userId)
      if (n > 0) console.log(`[queue] clear user=${userId.slice(0, 8)}… count=${n} settle=cancelled`)
      return n
    },
    drop: (userId: string, id: number): string => {
      const job = msgQueue.find(userId, id)
      if (!job) return `队列里没有 #${id}`
      if (job.ctx.msgId) settleInflight(job.ctx.msgId, undefined, "dropped")
      msgQueue.drop(userId, id)
      console.log(`[queue] drop user=${userId.slice(0, 8)}… qid=${id} settle=dropped`)
      return `已删除队列 #${id}（台账已结清）`
    },
  }

  // DEF-qqbot-20261105-P1 防线 B（2026-11-07）：/cancel 彻底复位。abort 只杀
  // opencode 侧回合；bot 侧悬挂的前台等待与残留台账账仍冻结 drain（11-06
  // 复现：cancel 后队列死锁 12 分钟直至重启）。此处统一：清队列 + abort +
  // 杀后台等待 + 结清该用户全部在途账 + 立即 drain 拉起。
  async function stopAllForUser(userId: string): Promise<{ cleared: number; title: string | undefined }> {
    const cleared = queueApi.clear(userId)
    const session = sessions.getSession(userId)
    if (session) {
      bgWaits.get(session.sessionId)?.cancel()
      try {
        await client.session.abort({ path: { id: session.sessionId } })
      } catch {
        /* 悬挂回合可能已自行终结，abort 失败不阻断复位 */
      }
    }
    let settled = 0
    for (const e of pendingInflight()) {
      if (e.userId !== userId) continue
      settleInflight(e.msgId, undefined, "cancelled")
      settled++
    }
    // 内存忙标志复位：悬挂的前台等待不退出时 busyUsers/draining 永久挡 drain
    // （11-06 实证 cancel 后死锁 12 分钟）。复位后 opencode 会话串行约束仍在
    // （服务端排队），bot 侧账幂等，不会出现重复投递。
    busyUsers.delete(userId)
    draining.delete(userId)
    if (settled > 0) console.log(`[bridge] stopAll 结清在途账 user=${userId.slice(0, 8)}… count=${settled}`)
    void drainQueue(userId)
    return { cleared, title: session?.title }
  }

  // 台账诊断命令实现（/ledger /ledger check /ledger settle）
  const ledgerApi: LedgerApi = {
    view: async (userId: string, args: string): Promise<string> => {
      const view = queueViewFor(userId)
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0]?.toLowerCase() ?? ""
      if (/^\d+$/.test(sub)) return formatLedgerReply(view, { page: Math.max(1, Number(sub)) })
      if (sub === "orphan" || sub === "rejected" || sub === "inflight" || sub === "settled") {
        const page = Number(parts[1] ?? "1")
        return formatLedgerReply(view, {
          filter: sub,
          page: Number.isInteger(page) && page > 0 ? page : 1,
        })
      }
      if (sub && sub !== "all") {
        const pool = [...view.inflightEntries, ...view.settledRecent]
        const hit = pool.find((e) => e.msgId === sub || e.msgId.endsWith(sub) || shortId(e.msgId) === sub)
        if (!hit) return `台账里没有匹配「${sub}」的条目（发 /ledger 查看尾号）`
        return formatLedgerReply(view, { detail: hit })
      }
      return formatLedgerReply(view)
    },
    check: async (userId: string): Promise<string> => {
      const view = queueViewFor(userId)
      if (view.inflightEntries.length === 0) return "台账在途：0 条，无需对账"
      const lines = [`台账对账 · 在途 ${view.inflightEntries.length} 条`]
      let answered = 0
      let running = 0
      let lost = 0
      let failed = 0
      for (const e of view.inflightEntries.slice(0, 20)) {
        const label = `${shortId(e.msgId)}「${previewText(e.text, 20)}」`
        if (!e.sessionId) {
          lost++
          lines.push(` · ${label} → lost（从未进入会话；可 /ledger settle ${shortId(e.msgId)} confirm 结清）`)
          continue
        }
        try {
          const msgs = await fetchRecoveryMessages(client, e.sessionId)
          const cls = classifyInflight({ text: e.text, at: e.at }, msgs)
          if (cls.kind === "answered") {
            answered++
            lines.push(` · ${label} → answered（答案已在库里，重启会补投）`)
          } else if (cls.kind === "running") {
            running++
            lines.push(` · ${label} → running（回合在跑/未终结）`)
          } else {
            lost++
            lines.push(` · ${label} → lost（会话历史找不到；可重发或结清）`)
          }
        } catch (error) {
          failed++
          lines.push(` · ${label} → 对账失败：${toErrorMessage(error)}`)
        }
      }
      if (view.inflightEntries.length > 20) lines.push(` …其余 ${view.inflightEntries.length - 20} 条未展开`)
      lines.push(`汇总：answered ${answered} · running ${running} · lost ${lost}${failed ? ` · 失败 ${failed}` : ""}`)
      lines.push("修复：/ledger settle <尾号> confirm 人工结清；重启对账会自动补投/重挂")
      console.log(
        `[journal] check user=${userId.slice(0, 8)}… inflight=${view.inflightEntries.length} answered=${answered} running=${running} lost=${lost} failed=${failed}`,
      )
      return lines.join("\n")
    },
    settle: (userId: string, key: string, confirm: boolean): string => {
      const view = queueViewFor(userId)
      const hits = view.inflightEntries.filter(
        (e) => e.msgId === key || e.msgId.endsWith(key) || shortId(e.msgId) === key,
      )
      if (hits.length === 0) return `台账在途里没有匹配「${key}」的条目`
      if (hits.length > 1) return `尾号「${key}」匹配到 ${hits.length} 条，请给更长的尾号`
      const hit = hits[0]
      if (!hit) return `台账在途里没有匹配「${key}」的条目`
      if (!confirm) {
        return `将结清：${shortId(hit.msgId)}「${previewText(hit.text, 30)}」\n确认请发 /ledger settle ${key} confirm`
      }
      const ok = settleInflight(hit.msgId, undefined, "manual")
      const job = msgQueue.list(userId).find((j) => j.ctx.msgId === hit.msgId)
      if (job) msgQueue.drop(userId, job.id)
      console.log(`[journal] settle-manual user=${userId.slice(0, 8)}… msg=${shortId(hit.msgId)} ok=${ok}`)
      return ok ? `已结清：${shortId(hit.msgId)}（人工）` : "该条目已不在在途状态"
    },
  }

  // 孤儿巡检：每 60s 扫一次台账；仅对新增孤儿且距上次提醒 >10min 的用户发一条汇总。
  const ORPHAN_SCAN_MS = (() => {
    const n = Number(process.env.QQ_ORPHAN_SCAN_SECONDS ?? "60")
    return Number.isFinite(n) && n > 0 ? Math.floor(n * 1000) : 0
  })()
  const ORPHAN_NOTIFY_GAP_MS = 10 * 60_000
  const lastOrphanNotify = new Map<string, number>()
  if (ORPHAN_SCAN_MS > 0) {
    setInterval(() => {
      try {
        const now = Date.now()
        const users = new Set(listInflightView().inflight.map((e) => e.userId))
        for (const uid of users) {
          const view = queueViewFor(uid)
          if (view.counts.orphan === 0) continue
          if (now - (lastOrphanNotify.get(uid) ?? 0) < ORPHAN_NOTIFY_GAP_MS) continue
          lastOrphanNotify.set(uid, now)
          console.log(`[queue] orphan-scan user=${uid.slice(0, 8)}… count=${view.counts.orphan}`)
          void safeDeliver(
            ctxForUser(uid),
            `⚠️ 台账发现 ${view.counts.orphan} 条孤儿消息（受理后未入队/未派发）。发 /queue 查看；/ledger settle <尾号> confirm 可人工结清。`,
          ).catch(() => {})
        }
      } catch (error) {
        console.error("[queue] 孤儿巡检失败:", toErrorMessage(error))
      }
    }, ORPHAN_SCAN_MS)
  }

  // Q2：手动进度查询（本地事件统计，零模型调用）
  const progressApi = {
    query: (userId: string): string => {
      const session = sessions.getSession(userId)
      if (!session) return "当前还没有会话，发消息即可开始"
      const st = turnStats.get(session.sessionId)
      const busy = busyUsers.has(userId) ? "处理中" : "空闲"
      const bg = bgWaits.has(session.sessionId) ? " · 后台等待在途" : ""
      if (!st) return `当前会话：${busy}${bg}\n暂无工具调用记录（本会话新起或尚无动作类里程碑）`
      return [
        `当前会话：${busy}${bg}`,
        `工具调用 ${st.tools} 次（失败 ${st.failed}）`,
        st.lastTool ? `最近：${st.lastTool}` : "",
        st.lastAt ? `最近活动：${agoLabel(st.lastAt)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    },
  }

  const commandContext: CommandContext = {
    config,
    client,
    sessions,
    getAccessToken: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
    pendingSelections,
    watch: watchApi,
    mirror: mirrorApi,
    queue: queueApi,
    ledger: ledgerApi,
    progress: progressApi,
    stopAll: stopAllForUser,
    ...(acpRunner
      ? {
          acp: {
            newSession: (userId: string) => acpRunner.newSession(userId),
            setModel: (userId: string, providerId: string, modelId: string) => acpRunner.setModel(userId, providerId, modelId),
            setAgent: (userId: string, agentId: string) => acpRunner.setAgent(userId, agentId),
            cancel: (userId: string) => acpRunner.cancel(userId),
          },
        }
      : {}),
  }

  // R2 修复批次启动项（2026-10-14）
  if (config.allowedUsers.length === 0) {
    console.warn("[security] ALLOWED_USERS 为空 → 所有消息将被拒绝（fail-closed）；请在 ~/.openqq/.env 配置白名单")
  }
  // R2-P1-3：恢复持久化的 /watch 订阅（里程碑已改 /watch 专属，重启不得静默丢）
  {
    const saved = loadWatchedMap()
    const known = new Set(sessions.all().map((x) => x.sessionId))
    let pruned = false
    for (const [uid, sid] of Object.entries(saved)) {
      if (!known.has(sid)) {
        pruned = true
        continue
      }
      activeWatches.set(uid, sid)
      subscribeSession(sid, uid)
      console.log(`[watch] 恢复订阅 ${uid.slice(0, 8)}… → ${sid}`)
    }
    if (pruned) saveWatchedMap(activeWatches)
  }

  // O2（P2-4a）：恢复重启前挂起的审批（逻辑随 O7b 收进 core/permission.ts）
  perm.restore()

  // 摘要镜像：启动时对全部映射会话挂常驻订阅
  mirror.ensureSubs()
  // 图片落盘：清理 7 天前的 QQ 图片（原生附件接入）
  purgeOldQQImages()

  const handleMessage = async (ctx: MessageContext): Promise<void> => {
    let claimedMsgId = ""
    const intentKey = intentKeyOf(ctx)
    // drain 重入/重启恢复的 ctx 已带受理账；若它在派发前的早退点（表单消费/命令/
    // 序号选择/审批挂起）被拦截，必须结清该账——否则台账残留 inflight，孤儿巡检
    // 会每 10 分钟刷一次告警（2026-11-05 实证：审批挂起导致队列 #1 卡成孤儿）。
    const releaseClaimed = (reason: SettleReason, note?: string): void => {
      if (!ctx.msgId || !claimedContexts.has(ctx)) return
      settleInflight(ctx.msgId, undefined, reason)
      console.log(`[queue] release-early msg=${shortId(ctx.msgId)} reason=${reason}${note ? ` note=${note}` : ""}`)
    }
    try {
      // P1 修复（2026-11-03，外部复盘核验）：拒绝时记录 openid——新用户无任何
      // 途径获取自己的 openid 填 ALLOWED_USERS，首配死锁；白名单内不打印（无需）。
      if (!isAllowedUser(ctx.userId, config.allowedUsers)) {
        console.log(`[security] 拒绝非白名单用户：openid=${ctx.userId}（把它加入 ~/.openqq/.env 的 ALLOWED_USERS 后重启即开通）`)
        await notifyUser(ctx, "你不在允许使用的名单里")
        return
      }

      const content = ctx.content.trim()
      // 纯图消息（无文字但有附件）同样放行；真空消息才丢
      if (!content && !ctx.attachments?.length) {
        return
      }
      // 记录最近消息上下文：观察/过程推送的通道选择（被动优先）
      lastCtx.set(ctx.userId, ctx)

      // 首条消息问候：跳过命令消息——/help 与问候语同源（buildHelpText），
      // 不跳过会双发相同内容（2026-11-02 用户实证：首次 /help 回复两次）。
      if (!greeted.has(ctx.userId) && !isCommand(content)) {
        greeted.add(ctx.userId)
        saveGreetedSet(greeted)
        await notifyUser(ctx, buildHelpText())
      }

      // 权限审批决策优先于命令/普通消息：原 prompt 在 promptAndWait 里
      // 挂起等待该 promise（busy 检查也在其后，不会被"处理中"拒绝）。
      const decision = parsePermissionDecision(content)
      if (decision && perm.hasPending(ctx.userId)) {
        // 债务D2：不在这里发"已允许"——等 client 的 reply POST 成功回调
        //（onPermissionReplied）再确认；404（桌面已批）走 onPermissionConflict。
        perm.resolve(ctx.userId, decision)
        return
      }

      // L 项：表单作答消费（选择弹窗 A/B/C/D）。命令一律放行——表单挂起期间
      // /queue /cancel 等管理命令不得被表单吞掉（DEF-qqbot-20261106-P3：表单
      // pending 曾把全部命令当答案消费，统一回「没看懂」且会话失能数分钟）。
      // 文字"允许"与表单答案的歧义：parsePermissionDecision 先行且要求存在
      // 待审权限才会消费；表单槽只消费非命令输入，互不串线。
      // ACP 表单（elicitation）优先消费：用户回复不得再进 agent
      if (!isCommand(content) && tryResolveElicitation(ctx.userId, content)) {
        return
      }
      if (!isCommand(content) && formBridge.tryResolveText(ctx.userId, content)) {
        releaseClaimed("answered")
        return
      }

      // 2026-11-10 夜间 UAT 实证修复（135 实测「😀/status」落入聊天分支）：命令门判定
      // 前先经表情规范化——faceType 实体 + emoji 字符都剥，剥后形似命令则以命令受理。
      const gateContent = normalizeForCommandGate(content)
      if (isCommand(gateContent)) {
        const gateCtx = gateContent === content ? ctx : { ...ctx, content: gateContent }
        const reply = await handleCommand(gateCtx, commandContext)
        await notifyUser(ctx, reply)
        releaseClaimed("dropped")
        return
      }

      const pendingReply = await maybeHandlePendingSelection(ctx, commandContext)
      if (pendingReply !== null) {
        await notifyUser(ctx, pendingReply)
        releaseClaimed("dropped")
        return
      }

      // 审批待决时，普通消息不进新 prompt（会话正阻塞在审批上），重发审批菜单。
      // 菜单重发也走卡片优先（2026-11-05：只发文字会让用户永远看不到按钮入口）。
      const pendingPerm = perm.getPending(ctx.userId)
      if (pendingPerm) {
        const sentByCard = await sendApprovalCard(
          { appId: config.qq.appId, clientSecret: config.qq.clientSecret },
          ctx,
          pendingPerm.request,
          pendingPerm.mainSessionId,
        ).catch(() => false)
        if (!sentByCard) {
          await notifyUser(ctx, formatPermissionPrompt(pendingPerm.request, pendingPerm.mainSessionId))
        }
        releaseClaimed("blocked", "审批挂起，消息未派发")
        return
      }

      // Durable gate（修复①）：K1 跨进程 msgId 占位 + K2 同内容在途指纹——
      // 判定与写入在台账单临界区内原子完成（跨进程互斥读改写），
      // 多 believer 并发受理与「连发不同 msgId 同问」都在此拦下。
      // 回执纪律：duplicate-msgid 静默（最先放行的 believer 负责答案，本侧任何出站
      // 都是重复气泡）；duplicate-intent 给一句短提示（首投方不会发，不构成重复）。
      if (ctx.msgId) {
        if (!claimedContexts.has(ctx)) {
          const admitted = claimInflightDetailed(
            { msgId: ctx.msgId, userId: ctx.userId, sessionId: "", text: content.slice(0, 300), at: Date.now() },
            { fingerprint: messageFingerprint(ctx.userId, intentKey) },
          )
          if (admitted === "duplicate-msgid") {
            console.log(`[bridge] 重复消息已跳过 msgId=${ctx.msgId}`)
            return
          }
          if (admitted === "duplicate-intent") {
            console.log(`[admit-dedupe] 同内容意图在途，本次重发已忽略 msgId=${ctx.msgId}`)
            // P3（2026-11-03，外部复盘核验 R4）：提示带在途内容摘要提升体感
            const pend = pendingInflight().find((e) => e.fingerprint === messageFingerprint(ctx.userId, intentKey))
            const digest = pend ? `（在途内容：${previewText(pend.text)}）` : ""
            await notifyUser(ctx, `你的相同问题正在处理中${digest}，本次重发已忽略`)
            return
          }
          claimedContexts.add(ctx)
        }
        claimedMsgId = ctx.msgId
      }

      if (busyUsers.has(ctx.userId) && !claimedContexts.has(ctx)) {
        const duplicateIntent = activeIntents.get(ctx.userId) === intentKey || msgQueue.hasIntent(ctx.userId, intentKey)
        if (duplicateIntent) {
          settleInflight(ctx.msgId, undefined, "duplicate-intent") // 重复意图已有原回合负责，直接结清，禁止恢复时再跑
          console.log(`[bridge] 相同意图已在执行/队列，跳过 msgId=${ctx.msgId}`)
          return
        }
      }

      if (busyUsers.has(ctx.userId)) {
        // Q1（学习 pi-qqbot 队列 UX）：忙碌不再拒绝——FIFO 排队，回合结束自动执行
        // 自检补强：入队即下载附件——QQ 签名 URL 短时效，drain 时下载必过期
        if (ctx.attachments?.length && !ctx.preparedAttachments) {
          ctx.preparedAttachments = await prepareQQAttachments(ctx.attachments, () =>
            getAccessToken(config.qq.appId, config.qq.clientSecret),
          )
        }
        const queued = msgQueue.push(ctx.userId, ctx)
        if (!queued) {
          if (claimedMsgId) settleInflight(claimedMsgId, undefined, "queue-full") // 已满回执即终态，不能留账让启动对账再次执行
          console.log(`[queue] reject user=${ctx.userId.slice(0, 8)}… msg=${shortId(ctx.msgId)} reason=full size=${msgQueue.size(ctx.userId)}/${QUEUE_MAX}`)
          await notifyUser(ctx, `排队已满（${QUEUE_MAX} 条），本条未入队；请稍候再试或 /cancel 中止当前任务`)
          return
        }
        if (ctx.msgId) {
          markInflightStage(ctx.msgId, "queued", { queueId: queued.job.id, enqueuedAt: queued.job.enqueuedAt })
        }
        console.log(
          `[queue] enqueue user=${ctx.userId.slice(0, 8)}… qid=${queued.job.id} msg=${shortId(ctx.msgId)} ahead=${queued.ahead} size=${msgQueue.size(ctx.userId)}/${QUEUE_MAX}`,
        )
        // 入队前已由 claimInflight 落账；drain 重入时回填 sessionId，不重复写账。
        await notifyUser(
          ctx,
          `已排队 #${queued.job.id}（第 ${queued.ahead + 1} 位${queued.ahead > 0 ? `，前面还有 ${queued.ahead} 条` : ""}），当前任务结束后自动执行。\n发 /queue 查看队列，/cancel 可中止当前任务并清空队列。`,
        )
        return
      }

      activeIntents.set(ctx.userId, intentKey)
      busyUsers.add(ctx.userId)

  // 修复⑦（2026-11-03）：受理即回执——前台回合立刻短句确认，消除静默期
  // （expA 实证：无受理回执时用户观感=「没有任何回复」）。Queue 路径此前
  // 已回「已排队 #N」、drain 重入已有「开始执行队列」、重派路径有「重启恢复」
  // 通知——这三处都不进本分支，同一 intent 不重复点头。
  // （同日迭代：改为开关制、默认不发——见顶部 ackReceiptEnabled。）
      if (ackReceiptEnabled && ctx.msgId && !drainReentries.has(ctx)) {
        await notifyUser(ctx, "✅ 已收到，正在处理，完成后自动回复你")
      }

      // B3（2026-10-29 同步升级）：C2C typing 指示——长回合处理中给用户
      // "对方正在输入"体感（官方 input_notify，仅 C2C；失败静默不阻塞主流程）
      // R 项：重派回合无真实 msgId（空串），跳过 typing 防无效请求
      if (ctx.type === "c2c" && ctx.msgId) {
        void getAccessToken(config.qq.appId, config.qq.clientSecret)
          .then((token) => sendC2CInputNotify(token, ctx.userId, ctx.msgId, 60))
          .catch(() => {})
      }

      let sessionId = ""
      let turnStart = 0
      let trackId = "" // R 项：在途台账跟踪键（try/catch 跨块可见）
      let promptId = "" // 修复⑧：本回合 user 消息 id（直答归属锚点）
      try {
        const session =
          TRANSPORT === "acp" && acpRunner
            ? { sessionId: await acpRunner.getOrCreate(ctx.userId) }
            : await sessions.getOrCreate(ctx.userId)
        sessionId = session.sessionId
        sessionLastActivity.set(sessionId, Date.now())

        // 缺口 1（引用上下文，吸收自官方 quote-ref 中间件）：本条消息的引用解析
        // 先于本条登记（顺序不可反：本条入缓存后才能被后续消息引用）
        // N 项（2026-10-30）：双通道——QQ 事件内嵌被引内容（message_type=103）
        // 为权威来源优先；缺失才回落本地缓存（跨重启/老消息引用也能解析）。
        const embeddedQuote = extractEmbeddedQuote(ctx.rawEvent)
        const quoted = embeddedQuote ?? (ctx.referencedMsgId ? resolveQuote(scopeKeyOf(ctx), ctx.referencedMsgId) : null)
        if (quoted) ctx.quoteText = quoted
        recordMessage(scopeKeyOf(ctx), ctx.msgId, ctx.content)
        // 新回合取代旧的后台等待（steer 合并运行时只投递一次合并结果）
        bgWaits.get(sessionId)?.cancel()
        // 会话订阅通道（SSE 活性 + 同会话同用户 Set 去重不双发）；里程碑投递
        // 已改 /watch 专属（2026-10-14），此订阅只保通道不再隐式携带推送
        subscribeSession(sessionId, ctx.userId)
        // 摘要镜像：新映射会话补挂订阅；QQ 轮次在途标记（防完成后重复镜像）
        mirror.beginTurn(sessionId)
        turnStart = Date.now()
        // 原生附件接入（2026-10-14）：QQ 图片下载落盘 → prompt files；
        // 下载失败/类型不支持转成可见文字备注，绝不静默丢
        // Q1 自检补强：排队消息在入队时已预下载（防签名 URL 过期），直接复用
        const prepared = ctx.preparedAttachments ?? await prepareQQAttachments(ctx.attachments, () =>
          getAccessToken(config.qq.appId, config.qq.clientSecret),
        )
        const { text: promptBody, files } = augmentPromptWithAttachments(content, prepared)
        // 缺口 1：引用上文注入——让 AI 明确知道用户引用了哪条消息
        // Q4 回退（用户评审三连否）：远程备注注入会渲染成独立用户消息、造成"一事两交互"，
        // 画蛇添足。不再注入任何前缀；场景上下文如需要改走 opencode 隐式 instructions 通道。
        const promptText = ctx.quoteText ? `> 引用上文：${ctx.quoteText}\n\n${promptBody}` : promptBody
        // R 项（2026-10-30）：在途台账落账——派发前记录，送达才销账；
        // 进程中途死亡时启动对账据此恢复。重派回合无真实 msgId，用合成键跟踪。
        trackId = ctx.msgId || `redispatch-${sessionId}-${turnStart}`
        recordInflight({ msgId: trackId, userId: ctx.userId, sessionId, text: content.slice(0, 300), at: Date.now() })
        markInflightStage(trackId, "dispatched", { sessionId })
        console.log(`[journal] dispatch user=${ctx.userId.slice(0, 8)}… msg=${shortId(trackId)} sid=${shortId(sessionId)}`)
        let replyText: string
        if (TRANSPORT === "acp" && acpRunner && files.length === 0) {
          // ACP 主路径：session/prompt 驱动；权限由 request_permission 在回合内阻塞。
          markInflightStage(trackId, "running", { sessionId })
          const run = await acpRunner.run(ctx.userId, promptText)
          replyText = run.text.trim() || (run.stopReason === "cancelled" ? "（操作已取消）" : "(AI 未返回内容)")
        } else {
          if (TRANSPORT === "acp") console.log("[bridge] acp 附件回合回退 REST（P2.5 再接 ACP 附件）")
          replyText = await client.promptAndWait(sessionId, promptText, {
          files: files.length ? files : undefined,
          // 修复⑧：受领即落台账锚点 + 本地闭合变量（前台超时转后台等待要带上）
          onAccepted: (info) => {
            promptId = info.promptId
            markInflightPromptId(trackId, info.promptId)
            console.log(`[journal] running msg=${shortId(trackId)} prompt=${shortId(info.promptId)}`)
          },
          onPermission: (req) => perm.waitForDecision(ctx, req, sessionId),
          onPermissionReplied: (d) => {
            // 拒绝与允许的后续语义不同：拒绝=该动作不执行，回合继续走其余步骤。
            const text = d === "reject"
              ? "已拒绝，该操作不会执行；AI 将继续其余步骤"
              : `已${DECISION_LABELS[d]}，AI 将继续执行…`
            void safeDeliver(ctx, text)
          },
          onPermissionConflict: (decision) => {
            // 债务D2：请求已被其他端（桌面/自动规则）先处理——不是错误，任务继续。
            // 2026-11-05 实证修正：立即告警是净噪音（用户点击后任务正常完成仍收到
            // "状态不明请重发"的恐吓文案）。改为 10 分钟零进展保险网——届时会话仍
            // 无任何新消息才告警；任务正常产出时保持安静。
            // 2026-11-07 例外（DEF-qqbot-20261107-1）：用户点了「拒绝」却 404 =
            // 引擎先放行后执行，必须立刻明说，不能静默（否则用户误以为已阻断）。
            console.log(`[bridge] 审批冲突（他端已处理），任务继续 msgId=${shortId(ctx.msgId)} decision=${decision}`)
            const notice = formatPermissionConflictNotice(decision)
            if (notice) void safeDeliver(ctx, notice)
            const conflictAt = Date.now()
            setTimeout(() => {
              void (async () => {
                try {
                  const listJson = await client.session.messages({ path: { id: sessionId } })
                  const msgs = listJson?.data ?? []
                  const progressed = msgs.some((m) => (m.time?.created ?? 0) >= conflictAt)
                  if (!progressed) {
                    await safeDeliver(
                      ctx,
                      "⚠️ 该审批请求状态不明（可能在桌面端处理或已超时），且任务长时间无进展。如命令未执行，请重新发起原操作",
                    )
                  }
                } catch {
                  /* 保险网探测失败不打扰用户 */
                }
              })()
            }, 10 * 60_000).unref?.()
          },
          })
        }

        if (replyText.trim()) {
          // 缺口 4：AI 主动发文件——QQ_SEND_FILE 标记行拦截发送文件，剩余文本照送
          const extracted = extractSendFileMarkers(replyText)
          for (const p of extracted.paths) {
            try {
              const done = await sendLocalFile(ctx, p, {
                getToken: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
              })
              await safeDeliver(ctx, `📎 ${done}`)
            } catch (error) {
              await safeDeliver(ctx, `⚠️ 发送文件失败（${p}）：${error instanceof Error ? error.message : error}`)
            }
          }
          // 超长回合可能已超被动窗口：deliver 被动失败自动降级主动，答案不丢
          // 直答出口统一脱敏（DEF-qqbot-20261106-2）：与 history/mirror/form 同一脱敏器，
          // 防 AI 复述的密钥/令牌经直答气泡明文外泄。
          if (extracted.text) await safeDeliver(ctx, redactSecrets(extracted.text))
        }
        settleInflight(trackId, undefined, "answered") // R 项：回合处理到终态（答案已投递尝试），销账
      } catch (error) {
        if (error instanceof SupersededError) {
          // DEF-qqbot-20261107-P2：同会话新输入（桌面端/他端直注）接管了本回合——
          // runner 接管语义下本回合已被打断且不会有正文。给用户可见交代并按
          // superseded 销账：不转后台（任务已死，「继续执行」是谎言）、不占位符、
          // 不挂 30 分钟超时。账本结清后 finally 正常 drain 队列。
          // P0-1 补修（与 bgWait rescueThenSettle 同族）：前台被接管同样先核实
          // 「已完成未投递」——完成于竞态窗口的答案先补投，不得谎称未产出。
          let rescuedText = ""
          try {
            const probe = await client.session.messages({ path: { id: sessionId } })
            const turn = turnStateOf(probe?.data ?? [], promptId, 0)
            if (turn.text) rescuedText = turn.text
          } catch {
            /* 探测失败落到原 superseded 交代 */
          }
          if (rescuedText) {
            console.log(`[bridge] 前台接管前抢救：回合已完成未投递，先补投 msg=${shortId(trackId)}`)
            await safeDeliver(ctx, `📤 你发来新消息前，上一回合已完成，结果如下：\n\n${rescuedText}`).catch(() => {})
            settleInflight(trackId, undefined, "answered")
          } else {
            console.log(`[bridge] 回合被同会话新输入接管（superseded）msg=${shortId(trackId)} sid=${shortId(sessionId)}`)
            await safeDeliver(ctx, "⚠️ 上一条任务被同会话的新输入打断，未产出结果；如需结果请重新发送")
            settleInflight(trackId, undefined, "superseded")
          }
        } else if (sessionId && turnStart > 0 && error instanceof Error && error.message.includes("响应超时")) {
          // 前台时限到 ≠ 放弃：任务继续跑，转入后台等待（SSE + 5 分钟轮询兜底，
          // 最长 24 小时），完成时经 deliver 被动/主动回传 —— 12 小时长任务的答案也不丢。
          // R 项：不销账——bgWait 完成投递时才销（完成前死亡由启动对账接管）。
          await safeDeliver(
            ctx,
            "⏳ 回合超过前台时限，已转后台等待：任务继续执行，完成即回传结果（最长 24 小时）。期间可用 /history 查看进展。",
          )
          startBackgroundWait(sessionId, ctx, turnStart, trackId, promptId, turnStart)
        } else if (isAcpPromptBusy(error)) {
          // 2026-11-08：会话被占用（-32603）。不再把 Internal error 原样甩给用户，
          // 给可操作路径；acp-session 的同会话串行链已挡掉我方自撞，这条只兜他端占用。
          console.error(`[bridge] 会话被占用（active prompt）sid=${shortId(sessionId)}: ${toErrorMessage(error)}`)
          await safeDeliver(
            ctx,
            "⏳ 该会话正有回合在执行（可能是桌面端在跑，或上一轮尚未结束），本轮未重复发起。\n发 /stop 可中止当前回合后重试。",
          )
          settleInflight(trackId, undefined, "error")
        } else if (isAcpPromptTimeout(error)) {
          // 仅硬上限（6 小时）会走到这里；30 分钟只是通知，不终止回合。
          await safeDeliver(ctx, "⏱ 回合已达硬上限（6 小时），已停止并释放会话；请重新发起（长任务可拆步，或用 /stop 提前结束）。")
          settleInflight(trackId, undefined, "error")
        } else {
          // Q3：额度/鉴权错误给救援话术（报类别+原文+恢复路径），不死胡同报错
          const errText = toErrorMessage(error)
          const rescue = rescueText(classifyProviderError(errText), errText)
          await safeDeliver(ctx, rescue ?? `处理失败：${errText}`)
          settleInflight(trackId, undefined, "error") // R 项：失败反馈已送达 = 终态，销账
        }
      } finally {
        if (sessionId) unsubscribeSession(sessionId, ctx.userId) // /watch 若仍挂着则保留订阅
        // 镜像解锁：转后台的任务由 bgWait 完成时解锁，其余延迟 5 秒（SSE 事件宽限）
        if (sessionId && !bgWaits.has(sessionId)) mirror.scheduleUnlock(sessionId)
        busyUsers.delete(ctx.userId)
        if (activeIntents.get(ctx.userId) === intentKey) activeIntents.delete(ctx.userId)
        // 队列完成回执（默认关闭）：只对 drain 重入的条目发，普通消息不刷屏。
        const finishedQueueId = queueIdOfCtx.get(ctx)
        if (finishedQueueId !== undefined && QUEUE_RECEIPTS_ENABLED) {
          await notifyUser(ctx, `队列 #${finishedQueueId} 完成（剩余 ${msgQueue.size(ctx.userId)} 条）`)
        }
        // Q1：回合结束（成功/失败/转后台）→ 自动执行该用户队列下一条；
        // 转后台等待的会话保持串行——由 bgWait 完成时再 drain（不与前序后台任务并发）
        if (sessionId && !bgWaits.has(sessionId)) void drainQueue(ctx.userId)
      }
    } catch (error) {
      // 认领后、内层回合兜底之前的异常（如排队附件预下载失败）也必须结清，
      // 否则重启对账会把已反馈失败的消息再执行一次。
      if (claimedMsgId) settleInflight(claimedMsgId, undefined, "error")
      if (activeIntents.get(ctx.userId) === intentKey) activeIntents.delete(ctx.userId)
      console.error("[bridge] handleMessage failed:", error)
      try {
        await sendReply(ctx, `处理消息失败：${toErrorMessage(error)}`)
      } catch (replyError) {
        console.error("[bridge] failed to send error reply:", replyError)
      }
    }
  }

  // R 项（2026-10-30 重启丢消息事故修复）：启动对账——查在途台账里"已派发未销账"
  // 的回合，按会话历史分类处置：已有答案→补投；仍在执行→重挂后台等待；
  // 从未到达 opencode→窗口内自动重派（超期通知请用户重发）。
  // 2026-11-05（队列/台账可观测性）：从未进会话的在途账 = 重启前还在排队，
  // 先按 enqueuedAt/at 重建内存队列（保留 #id 与顺序），不再直接结清丢弃。
  async function recoverInflightRounds(): Promise<void> {
    const pending = pendingInflight()
    if (pending.length === 0) return
    console.log(`[bridge] 启动对账：${pending.length} 条在途消息待恢复`)

    const restoreWindow = redispatchMaxAgeMs()
    const restorable = new Set<string>()
    const queueCandidates = pending.filter(
      (e) => !e.sessionId && !e.promptId && Date.now() - e.at <= restoreWindow,
    )
    if (queueCandidates.length > 0) {
      const byUser = new Map<string, InflightEntry[]>()
      for (const e of queueCandidates) {
        const list = byUser.get(e.userId) ?? []
        list.push(e)
        byUser.set(e.userId, list)
      }
      for (const [userId, list] of byUser) {
        list.sort((a, b) => (a.enqueuedAt ?? a.at) - (b.enqueuedAt ?? b.at))
        const jobs = list.map((e) => ({
          ...(e.queueId !== undefined ? { id: e.queueId } : {}),
          ctx: { type: "c2c" as const, userId, msgId: e.msgId, content: e.text, timestamp: String(e.at) },
          text: e.text,
          enqueuedAt: e.enqueuedAt ?? e.at,
        }))
        const restored = msgQueue.restore(userId, jobs)
        if (restored > 0) {
          const restoredJobs = msgQueue.list(userId).slice(-restored)
          for (const job of restoredJobs) {
            // drain 重入必须跳过重复认领，否则 duplicate-msgid 会把恢复条目静默丢掉。
            claimedContexts.add(job.ctx)
            // force：旧 stage（如 dispatched 空账）在进程换代后不再可信，恢复即回到 queued。
            markInflightStage(job.ctx.msgId, "queued", { queueId: job.id, enqueuedAt: job.enqueuedAt }, { force: true })
            restorable.add(job.ctx.msgId)
          }
          console.log(
            `[queue] restore user=${userId.slice(0, 8)}… count=${restored} window=${Math.round(restoreWindow / 60_000)}m`,
          )
          await deliver(
            ctxForUser(userId),
            `🔄 重启恢复：${restored} 条排队消息已恢复（发 /queue 查看；/queue clear 可清空）`,
          )
        }
      }
    }

    for (const entry of pending) {
      if (restorable.has(entry.msgId)) continue
      const ageMs = Date.now() - entry.at
      if (ageMs > INFLIGHT_MAX_AGE_MS) {
        settleInflight(entry.msgId, undefined, "expired") // 超 24h：清账不追溯
        continue
      }
      // 恢复投递走主动通道（原 msgId 的被动窗口早已过期）
      const ctx: MessageContext = { type: "c2c", userId: entry.userId, msgId: "", content: entry.text }
      // 修复③（2026-11-03）：排队空账治本——sessionId 为空=「从未进过会话」。
      // 2026-11-05：窗口内的已在上方恢复进队列；走到这里的只剩超窗空账，只清账通知。
      if (!entry.sessionId) {
        settleInflight(entry.msgId, undefined, "expired")
        await deliver(
          ctx,
          `⚠️ 重启前队列里有一条消息超过恢复窗口未执行（「${entry.text.length > 50 ? `${entry.text.slice(0, 50)}…` : entry.text}」）。为避免执行陈旧意图未自动重派，需要的话请重发一次`,
        )
        console.log(`[bridge] 启动对账：超窗排队空账已通知销账 msgId=${entry.msgId}`)
        continue
      }
      try {
        const listJson = { data: await fetchRecoveryMessages(client, entry.sessionId) }
        const cls = classifyInflight(entry, listJson.data)
        if (cls.kind === "answered") {
          await deliver(ctx, `🔄 重启补投：你之前的消息已有答案\n\n${cls.answer}`)
          settleInflight(entry.msgId, undefined, "answered")
          console.log(`[bridge] 启动对账：已补投答案 msgId=${entry.msgId}`)
        } else if (cls.kind === "running") {
          // 2026-11-09 透明度补强：原执行进程已死时，回合「存活」以服务端为准——
          // 后台等待有 REST 轮询兜底，但不再是「同一个活着的回合」，日志必须说清。
          if (entry.ownerPid !== undefined && !isPidAlive(entry.ownerPid)) {
            console.log(
              `[bridge] 启动对账：原执行进程 ${entry.ownerPid} 已退出，回合状态以服务端会话为准（后台等待+轮询兜底）msgId=${entry.msgId}`,
            )
          }
          // 跨重启也要保持 QQ 回合同一身份：后台直答完成时，镜像不得再投摘要。
          mirror.beginTurn(entry.sessionId)
          // 不单独发“仍在执行”通知；完成时统一回传最终答案，避免通知也占一条回复。
          startBackgroundWait(entry.sessionId, ctx, entry.at, entry.msgId, entry.promptId ?? "", entry.at)
          console.log(`[bridge] 启动对账：在途任务已重挂后台等待 msgId=${entry.msgId}`)
        } else if (ageMs <= redispatchMaxAgeMs()) {
          settleInflight(entry.msgId, undefined, "redispatch") // 旧账结清，重派回合走新账（合成 trackId）
          await deliver(ctx, `🔄 重启恢复：重新处理你之前的消息「${entry.text.length > 50 ? `${entry.text.slice(0, 50)}…` : entry.text}」`)
          void handleMessage(ctx)
          console.log(`[bridge] 启动对账：丢失消息已重派 msgId=${entry.msgId}`)
        } else {
          await deliver(ctx, `⚠️ 此前重启期间丢失一条你的消息「${entry.text.length > 50 ? `${entry.text.slice(0, 50)}…` : entry.text}」（超过自动重派窗口未重发），需要的话请重发一次`)
          settleInflight(entry.msgId, undefined, "expired")
          console.log(`[bridge] 启动对账：超期消息仅通知 msgId=${entry.msgId}`)
        }
      } catch (error) {
        console.error(`[bridge] 启动对账单条失败 msgId=${entry.msgId}:`, error)
      }
    }
  }

  // Q1：队列 drain——取该用户队首消息重走完整管线。draining 防重入；
  // handleMessage 自身的 finally 会继续 drain 下一条（链式）。
  async function drainQueue(userId: string): Promise<void> {
    if (draining.has(userId) || busyUsers.has(userId)) return
    // 审批挂起时不出队：此时出队只会被 handleMessage 的 pendingPerm 早退吞掉并结清
    // （消息白排队）。等挂起审批的回合走完 finally 自然会再次 drain。
    if (perm.getPending(userId)) return
    const job = msgQueue.shift(userId)
    if (!job) return
    draining.add(userId)
    queueIdOfCtx.set(job.ctx, job.id)
    if (job.ctx.msgId) markInflightStage(job.ctx.msgId, "dispatched", { queueId: job.id })
    const remain = msgQueue.size(userId)
    console.log(`[queue] drain-start user=${userId.slice(0, 8)}… qid=${job.id} remain=${remain}`)
    try {
      await notifyUser(job.ctx, `开始执行队列 #${job.id}（剩余 ${remain} 条）`)
      drainReentries.add(job.ctx) // 修复⑦：drain 重入跳过受理回执
      await handleMessage(job.ctx)
    } catch (error) {
      console.error("[bridge] 队列执行失败:", error)
    } finally {
      draining.delete(userId)
      console.log(`[queue] drain-done user=${userId.slice(0, 8)}… qid=${job.id} remain=${msgQueue.size(userId)}`)
      if (msgQueue.size(userId) > 0 && !busyUsers.has(userId)) void drainQueue(userId)
    }
  }

  return {
    handleMessage,
    eventStream,
    recoverInflightRounds,
    handleInteraction: (event) => {
      if (handleApprovalInteraction(event, perm)) return
      void formBridge.handleButton(event)
    },
  }
}

export async function fetchRecoveryMessages(client: OpencodeClient, sessionId: string): Promise<SessionMessage[]> {
  const all: SessionMessage[] = []
  let cursor: string | undefined
  // 上限 2000 条防异常分页循环；常规长会话已足够覆盖原始在途回合。
  for (let page = 0; page < 10; page++) {
    const res = await client.session.messages({ path: { id: sessionId }, query: { limit: 200, cursor } })
    const items = res?.data ?? []
    all.push(...items)
    const next = res?.cursor?.next
    if (!next || items.length === 0) break
    cursor = next
  }
  return all
}

async function maybeHandlePendingSelection(
  ctx: MessageContext,
  commandContext: CommandContext,
): Promise<string | null> {
  const pending = commandContext.pendingSelections.get(ctx.userId)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  if (!/^\d+$/.test(ctx.content.trim())) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  return handlePendingSelection(ctx.userId, Number(ctx.content.trim()), commandContext)
}

// R2-P1-1（2026-10-14）：空名单 fail-closed——配置缺失时宁可全拒，不静默
// 全开（首轮 P0-2 只闭了配置层，本次闭结构层）。
export function isAllowedUser(userId: string, allowedUsers: string[]): boolean {
  if (allowedUsers.length === 0) return false
  return allowedUsers.includes(userId)
}

// R2-P1-3（2026-10-14）：/watch 持久化——里程碑已改 /watch 专属，重启静默丢
// 订阅不可接受；与 greeted.json 同款风格（损坏即空、文件名参数化供单测）。
const WATCH_FILE = join(homedir(), ".openqq", "watch.json")

export function loadWatchedMap(file: string = WATCH_FILE): Record<string, string> {
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8")
      const obj = JSON.parse(raw)
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(obj)) if (typeof v === "string" && v) out[k] = v
        return out
      }
    }
  } catch {
    // 损坏即空
  }
  return {}
}

export function saveWatchedMap(m: ReadonlyMap<string, string>, file: string = WATCH_FILE): void {
  try {
    writeFileSync(file, JSON.stringify(Object.fromEntries(m), null, 2))
  } catch (error) {
    console.warn("[watch] 持久化失败:", error instanceof Error ? error.message : error)
  }
}

const GREETED_FILE = join(homedir(), ".openqq", "greeted.json")

function loadGreetedSet(): Set<string> {
  try {
    if (existsSync(GREETED_FILE)) {
      const raw = readFileSync(GREETED_FILE, "utf-8")
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        return new Set(arr.filter((x): x is string => typeof x === "string"))
      }
    }
  } catch {
    // fall through to empty set
  }
  return new Set<string>()
}

function saveGreetedSet(set: Set<string>): void {
  try {
    mkdirSync(join(homedir(), ".openqq"), { recursive: true })
    writeFileSync(GREETED_FILE, JSON.stringify([...set]))
  } catch (error) {
    console.error("[bridge] 保存 greeted 失败:", error)
  }
}

// 里程碑映射（事件载荷实测 2026-10-13）：
//   tool.called.data.input{command,...} → 动作可见
//   tool.success.data.metadata.exit     → 非零退出码才提示（成功静默，避免刷屏）
//   execution.succeeded/failed          → 轮次收尾
// 纯函数（导出供测试；生产路径经 onSessionEvent → enqueuePush）。
// calls: 可选的 callID→命令摘要缓存——tool.success 的载荷可能不含 input，
// 失败行靠缓存补上命令上下文（仅"上条命令 exit N"无从对号入座，用户误以为大量报错）。
export function formatMilestone(ev: V2Event, calls?: Map<string, string>): string | null {
  const d = (ev.data ?? {}) as Record<string, any>
  switch (ev.type) {
    case "session.tool.called": {
      const line = truncate(redactSecrets(summarizeInput(d.input)), 140)
      if (d.id && calls) {
        calls.set(String(d.id), line)
        if (calls.size > 100) {
          const oldest = calls.keys().next().value
          if (oldest !== undefined) calls.delete(oldest)
        }
      }
      // 2026-10-14 用户反馈：纯文件类工具（read/edit/write/grep…）推送裸路径没有
      // 意义——只保留动作类里程碑（input.command 的 shell 命令，或 input 即命令串）；
      // 文件类静默，过程内容由摘要镜像 /history 承载。⚠️失败行不受影响（走 calls 缓存）。
      const cmd = typeof d.input === "string" ? d.input : d.input?.command
      if (!(typeof cmd === "string" && cmd.trim())) return null
      return `🔧 ${line}`
    }
    case "session.tool.success": {
      const exit = d.metadata?.exit
      if (typeof exit !== "number" || exit === 0) return null
      const what =
        (d.id ? calls?.get(String(d.id)) : undefined) ??
        (d.input ? truncate(redactSecrets(summarizeInput(d.input)), 80) : "")
      return what ? `⚠️ exit ${exit}：${what}` : `⚠️ exit ${exit}`
    }
    case "session.execution.succeeded":
      return "✅ 本轮完成"
    case "session.execution.failed":
      return "❌ 执行失败"
    default:
      return null
  }
}

// 里程碑投递目标（纯函数，供单测）：只认 /watch 显式订阅（activeWatches）。
// 2026-10-14 拍板：推不推完全由用户显式控制；sessionSubs（自身回合/镜像等
// 来源）不再隐式携带里程碑，避免"没开 /watch 却在收"的噪声。
export function milestoneTargets(
  activeWatches: ReadonlyMap<string, string>,
  sessionID: string,
): string[] {
  const out: string[] = []
  for (const [userId, sid] of activeWatches) {
    if (sid === sessionID) out.push(userId)
  }
  return out
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
