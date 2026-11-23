// @input:  ./config, ./qq/* (types, api, sender), ./opencode/* (client, sessions), ./commands, ./core/*
// @output: createBridge, isAllowedUser, milestoneTargets, loadWatchedMap, saveWatchedMap,
//          （O7b 再导出）parsePermissionDecision, formatPermissionPrompt
// @pos:    根层 - 核心桥接: QQ 消息 -> OpenCode -> QQ 回复
import { storageFile } from "./core/storage.js"
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import { getAccessToken, sendC2CInputNotify, sendC2CMessage, sendGroupMessage } from "./qq/api.js"
import { prepareQQAttachments, augmentPromptWithAttachments, purgeOldQQImages } from "./qq/media.js"
import { normalizeForCommandGate } from "./qq/gateway.js"
import type { OpencodeClient, SessionMessage, PermissionRequest } from "./opencode/client.js"
import {
  decideReap,
  decideDispatchStall,
  sessionExistsFromProbeError,
  DISPATCH_STALL_MS,
  REAPER_MIN_AGE_MS,
  REAPER_SILENCE_MS,
  resolveReaperMs,
} from "./core/zombie-reaper.js"
import { SupersededError, turnStateOf } from "./opencode/client.js"
import { createEventStream, type V2Event } from "./opencode/eventstream.js"

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
import { MessageQueue, laneKeyOf, laneScope, sessionIdOfLane, userIdOfLane, previewText, agoLabel, intentKeyOf } from "./core/message-queue.js"
import { classifyProviderError, rescueText } from "./core/error-rescue.js"
import { NOTICE } from "./core/notices.js"
import { parseCronReminder, ReminderScheduler } from "./core/cron-reminders.js"
// 回合修正域纯决策（2026-11-23 拆分切片）——bridge 再导出保测试导入路径兼容
export {
  resolveBusyMode, buildAmendPrompt, selectAmendEntry, lastUserMessageId, messageTextOf, parseGoalState,
} from "./core/turn-correction.js"
import { resolveBusyMode, buildAmendPrompt, selectAmendEntry, lastUserMessageId, messageTextOf, parseGoalState } from "./core/turn-correction.js"

const QUEUE_MAX = 20 // Q1：忙碌队列上限（学习 pi-qqbot queue.max 默认）
// 2026-11-05：队列完成回执（"队列 #N 完成（剩余 M 条）"）默认关闭——批量排空时
// 会放大主动消息配额消耗；排障/验收期设 QQ_QUEUE_RECEIPTS=1 打开。
const QUEUE_RECEIPTS_ENABLED = /^(1|true|on)$/i.test(process.env.QQ_QUEUE_RECEIPTS ?? "")
import {
  createPermissionGate,
  createPushGate,
  resolvePermDeferMs,
  parsePermissionDecision,
  formatPermissionPrompt,
  formatPermissionConflictNotice,
  DECISION_LABELS,
  type PermOrigin,
} from "./core/permission.js"
import { truncate } from "./core/util.js"
import { createDelivery, QQ_LIST_FORMAT_HINT } from "./core/delivery.js"
import { createNotifySink } from "./core/notify-sink.js"
import { handleApprovalInteraction, sendApprovalCard } from "./core/card-approval.js"
import { createFormBridge, renderFormPrompt } from "./core/form-bridge.js"
import { recordMessage, resolveQuote, scopeKeyOf, extractEmbeddedQuote } from "./core/context-buffer.js"
import {
  createInflightJournal,
  classifyInflight,
  INFLIGHT_MAX_AGE_MS,
  redispatchMaxAgeMs,
  type InflightEntry,
  type SettleReason,
} from "./core/inflight-journal.js"
import {
  deriveQueueView,
  resolveOrphanMs,
  resolveLedgerNumericArg,
  decideOrphanNotify,
  type OrphanNotifyState,
  formatQueueReply,
  formatQueueFullReceipt,
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

/** 会话正有 active prompt（-32603，他端/桌面端并发占用）判定（纯函数，导出供测试）。 */
export function isSessionBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /active prompt|[-−]32603/.test(message)
}

// E 闲置回收纯函数（导出供测试，2026-10-29）：返回应回收的闲置会话 id——
// 超过 idleMs 无活动且未被观察（/status watch on）显式盯住的会话。
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
  const stale = idleMin >= 30 ? `。⚠️ 注意：已 ${idleMin} 分钟没有任何动静，疑似卡住——可发 /cancel 中止后重发` : ""
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

// ===== 后台流活性监督（2026-11-19 owner 裁定：与后台探知同 tick 执行）=====
// 背景：死回合（SSE 断连/提供商悬挂）与长跑任务在「消息无进展」信号上同形，
// bot 观测不到「模型是否还在生成」——昨夜 BG101A 实证：首 token 后 3 秒流停止，
// 90 分钟零产出无终结，心跳却在如实报「还在执行」。本层补上判别器：
// 判死 = 锚定边界内 assistant 最后活动（streamed 或 created）超阈值
//        且回合未终结（idle/全部 completed 归完成判据管）。
// 工具豁免（有界）：工具执行中（tool state=running）streamed 必然冻结是健康形态——
// 但卡死的工具 part 同样恒 running（BG101A 实证：question 工具悬挂 2.5h），故豁免
// 只保活到 QQ_BG_TOOL_GRACE_MS（默认 60min，覆盖 2100s 睡眠类长工具），超时照样判死。
// 处置（owner 裁定「先关而后断点继续」）：session.abort 死回合 →
// 续作（同会话新回合重发原 prompt，单任务上限 3 次）/ 超限 expired 结清 + 放行队列。
// 阈值 env QQ_BG_STREAM_DEAD_MS（合法域 1min~60min），默认 15min——
// 须大于健康工具调用间隙、小于僵尸收割 40min 年龄门。
export const BG_STREAM_DEAD_MS_DEFAULT = 15 * 60_000
export const BG_TOOL_GRACE_MS_DEFAULT = 60 * 60_000

export function resolveStreamDeadMs(envValue: string | undefined): number {
  const raw = Number(envValue ?? "")
  return Number.isFinite(raw) && raw >= 60_000 && raw <= 3_600_000 ? Math.floor(raw) : BG_STREAM_DEAD_MS_DEFAULT
}

/** 工具豁免窗解析（纯函数供测试）：默认 60min，合法域 5min 至 4h；不得小于健康长工具实测（2100s 睡眠）。 */
export function resolveToolGraceMs(envValue: string | undefined): number {
  if (envValue === undefined || envValue.trim() === "") return BG_TOOL_GRACE_MS_DEFAULT
  const raw = Number(envValue)
  return Number.isFinite(raw) && raw >= 300_000 && raw <= 14_400_000 ? Math.floor(raw) : BG_TOOL_GRACE_MS_DEFAULT
}

export type StreamLiveness = "alive" | "dead" | "none"

/** 续作上限解析（纯函数供测试）：env QQ_BG_RESUME_MAX，默认 3 次；0=关闭自动续作；合法域 0 至 5。 */
export function resolveResumeMax(envValue: string | undefined): number {
  // 注意 Number("")===0——必须先判空再 Number（resolvePermDeferMs 同款陷阱注释）
  if (envValue === undefined || envValue.trim() === "") return 3
  const raw = Number(envValue)
  return Number.isFinite(raw) && raw >= 0 && raw <= 5 ? Math.floor(raw) : 3
}

/** 续作决策（纯函数供测试）：已消耗次数 < 上限 → 续作；否则 giveup 交 finishDead。 */
export function resumeDecision(resumeCount: number, max: number): "resume" | "giveup" {
  return max > 0 && resumeCount < max ? "resume" : "giveup"
}

// ===== /amend（steer 降级版，2026-11-22 owner 裁定参考 Hermes update_prompt）=====

// 2026-11-23 拆分切片：本域纯决策函数收敛于 core/turn-correction.ts（bridge 再导出，
// 测试导入路径兼容）。下方仅保留域注释。

// ===== 会话回滚（官方 /undo 对齐批，2026-11-23 owner 令「对上opencode桌面端，开工」）=====
// 基准=opencode.ai/docs/snapshots：/undo=stage 边界→恢复文件→prompt 回盒，提交编辑后
// prompt 时才 commit；/redo=取消暂存；会话运行中拒绝 revert。QQ 侧 /undo 为一次性
// stage→commit（无暂存窗，故 /redo 无对象——如实不做，不做半成品语义）。

/**
 * 流活性判定（纯函数供测试）。msgs=同一次后台探知的拉取结果；
 * promptId/baseline=本回合锚点（与 turnStateOf 同口径）。
 * none=边界内无 assistant 消息（等待模型开始，归停滞提醒管）。
 */
export function streamLiveness(
  msgs: SessionMessage[],
  promptId: string,
  baseline: number,
  now: number,
  deadMs: number,
  /** 工具豁免窗（默认 60min）：工具执行中 streamed 冻结属健康，但卡死工具 part 也恒 running——豁免有界。 */
  toolGraceMs: number = BG_TOOL_GRACE_MS_DEFAULT,
): StreamLiveness {
  const turn = turnStateOf(msgs, promptId, baseline)
  // 完成判据优先：有 idle 或全部 assistant 已终结 → 不归活性监督
  if (turn.hasIdle) return "alive"
  const ordered = [...msgs].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  // 回合边界（与 turnStateOf 同构：promptId 精确锚 > 200ms 时间锚）
  let startIdx = 0
  if (turn.anchored) {
    let userIdx = ordered.findIndex((m) => m.type === "user" && m.id === promptId)
    if (userIdx < 0 && baseline > 0) {
      let best = -1
      let bestDelta = Number.POSITIVE_INFINITY
      for (let i = ordered.length - 1; i >= 0; i--) {
        if (ordered[i].type !== "user") continue
        const delta = Math.abs((ordered[i].time?.created ?? 0) - baseline)
        if (delta < bestDelta) { bestDelta = delta; best = i }
      }
      if (best >= 0 && bestDelta <= 200) userIdx = best
    }
    startIdx = userIdx >= 0 ? userIdx + 1 : 0
  }
  let latestActivity = 0
  let anyUncompleted = false
  let anyRunningTool = false
  for (let i = startIdx; i < ordered.length; i++) {
    const m = ordered[i]
    if (m.type !== "assistant") continue
    if (!turn.anchored && (m.time?.created ?? 0) < baseline) continue
    const activity = m.time?.streamed ?? m.time?.created ?? 0
    if (activity > latestActivity) latestActivity = activity
    if (!m.time?.completed) anyUncompleted = true
    for (const p of [...(m.parts ?? []), ...(m.content ?? [])] as Array<{ type?: string; state?: { status?: string } }>) {
      if ((p.type === "tool" || p.type === undefined) && p.state?.status === "running") anyRunningTool = true
    }
  }
  if (latestActivity === 0) return "none"
  if (!anyUncompleted) return "alive"
  // 工具豁免（有界）：running 工具只在豁免窗内保活；窗外与无工具同口径按流陈旧度判死
  //（卡死工具 part 恒 running——BG101A 实证 question 工具悬挂 2.5h，无界豁免=永远假活）。
  if (anyRunningTool && now - latestActivity < toolGraceMs) return "alive"
  return now - latestActivity >= deadMs ? "dead" : "alive"
}

// ===== 终稿提取（2026-11-10 工作稿误投事故根修）=====
// 事故：owner 收到「📤…结果如下：更新测试（新文案+missingIdleDone 用例）：」——那是被打断回合
// 的【工作稿】（同消息文本段后带工具段），不是答案。口径：同消息含工具段=工作稿，不作答案投递；
// 只取边界内最后一条「纯文本 assistant 消息」；一条都没有=未产出，走 superseded 如实交代。
function assistantTextOf(m: SessionMessage): string {
  return (m.content ?? [])
    .filter((p) => p.type === "text" && p.text?.trim())
    .map((p) => p.text ?? "")
    .join("\n")
    .trim()
}
function hasToolPart(m: SessionMessage): boolean {
  return (m.parts ?? []).some((p) => p.type === "tool") || (m.content ?? []).some((p) => p.type === "tool")
}

export function finalAnswerText(msgs: SessionMessage[], promptId: string, baseline: number): string {
  const ordered = [...msgs].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  let userIdx = promptId ? ordered.findIndex((m) => m.type === "user" && m.id === promptId) : -1
  if (userIdx < 0 && baseline > 0) {
    let best = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].type !== "user") continue
      const delta = Math.abs((ordered[i].time?.created ?? 0) - baseline)
      if (delta < bestDelta) { bestDelta = delta; best = i }
    }
    if (best >= 0 && bestDelta <= 200) userIdx = best
  }
  const inBoundary = (m: SessionMessage, idx: number): boolean => {
    if (userIdx >= 0) return idx > userIdx
    return (m.time?.created ?? 0) >= baseline
  }
  let text = ""
  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[i]
    if (m.type !== "assistant" || !inBoundary(m, i)) continue
    const t = assistantTextOf(m)
    if (t && !hasToolPart(m)) text = t // 工作稿（含工具段）跳过
  }
  return text
}

export interface Bridge {
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
  /** 多角色（2026-11-17）：本 bridge 所属角色的 appId。传入后所有角色作用域
   *  数据文件（台账/审批/表单/配额/观察/问候）落 ~/.openqq/roles/<appId>/；
   *  缺省 = legacy 全局路径，单角色部署行为零变化。 */
  storageAppId?: string,
): Bridge {
  // 角色作用域数据根（storage.ts：legacy 根 or roles/<appId>/ 子目录）
  const roleFile = (name: string): string => storageFile(name, storageAppId)
  // 在途台账按角色绑定实例（同进程多角色并发不互踩，见 inflight-journal 工厂）
  const inflight = createInflightJournal(storageAppId ? roleFile("inflight.json") : undefined)
  // H2 停滞提醒文案状态开关就用现成 env 读取风格；这里同步实现⑦开关——
  // 2026-11-03 用户拍板：「已收到」回执默认不发（非调试无价值），调试期在
  // ~/.openqq/.env 设 QQ_ACK_RECEIPT=1 开启。loadEnvFile 全量注入 process.env，
  // 排队回执「已排队 #N」为功能性提示不受此开关影响。
  const ackReceiptEnabled = /^(1|true|on)$/i.test(process.env.QQ_ACK_RECEIPT ?? "")

  // 会话隔离（owner 2026-11-14 裁定，DEF-qqbot-20261112-01 修法①）：
  // busyUsers/draining 存 lane 键（userId|sessionId）——官方 per-peer 串行的会话级
  // 细腻化；僵尸/长回合只堵所在 lane。票号仍 per-user 单调（message-queue 内）。
  const busyUsers = new Set<string>()
  const laneOf = (userId: string, sessionId: string | null | undefined): string => laneKeyOf(userId, sessionId)
  /** 该用户是否有任一 lane 在忙（/status 展示用） */
  const anyLaneBusy = (userId: string): boolean => {
    for (const k of busyUsers) if (userIdOfLane(k) === userId) return true
    return false
  }
  /** 出站推送门（design §3.4）：QQ 只呈现当前绑定会话——锚定≠绑定即不推 */
  const isBoundSession = (userId: string, sessionId: string): boolean =>
    sessions.getSession(userId)?.sessionId === sessionId
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
  const greeted = loadGreetedSet(storageAppId ? roleFile("greeted.json") : undefined)
  const pendingSelections = new Map<string, PendingSelection>()

  // ===== 实时观察 / 回合过程推送 =====
  // 单条 SSE 连接按 sessionID 分流，多订阅者共享（同会话同 userId Set 去重不双发）。
  // 里程碑投递 = /watch 专属（2026-10-14 拍板）；sessionSubs 只管 SSE 活性与去重。
  const eventStream = createEventStream(client.baseUrl)
// 弹卡延迟窗（owner 2026-11-10 拍板，QQ_PERM_DEFER_MS 可调）：桌面端 autoApprove 实测
// 20~500ms 内秒回 once——asked 后延迟判定，窗口内被处置的 ask 不推 QQ 卡（与桌面静默放行一致）。
const PERM_DEFER_MS = resolvePermDeferMs(process.env.QQ_PERM_DEFER_MS)
const permPushGate = createPushGate(PERM_DEFER_MS)
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
    for (const userId of milestoneTargets(activeWatches, sessionID)) enqueuePush(userId, line, sessionID)
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

  function startBackgroundWait(
    sessionId: string,
    ctx: MessageContext,
    baseline: number,
    trackId?: string,
    promptId = "",
    turnStartedAt?: number,
    /** DEF-20261112-1 权限链目录：续作重派 promptAndWait 的 x-opencode-directory（缺省=裸查旧行为） */
    anchorDirectory?: string,
    /** 续作次数初值：启动对账重挂时从台账 resumeCount 续算（重启不洗白 owner 上限裁定） */
    resumeCountInitial = 0,
  ): void {
    // 同会话只允许一个后台等待：恢复多条在途账/超时重挂不得留下多个完成回调重复投递。
    bgWaits.get(sessionId)?.cancel()
    // 流活性监督阈值（env 惰性读取：.env 运行时才注入；owner 2026-11-19 裁定层）
    const STREAM_DEAD_MS = resolveStreamDeadMs(process.env.QQ_BG_STREAM_DEAD_MS)
    const TOOL_GRACE_MS = resolveToolGraceMs(process.env.QQ_BG_TOOL_GRACE_MS)
    // 死回合自动续作上限（owner 2026-11-19 裁定：单任务续作不能超过三次；0=关闭）
    const MAX_RESUME = resolveResumeMax(process.env.QQ_BG_RESUME_MAX)
    let resumeCount = resumeCountInitial
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
        // 终稿提取（2026-11-10 工作稿误投事故）：只取纯文本终稿；工作稿不算结果
        const rescuedText = finalAnswerText(probe?.data ?? [], promptId, baseline)
        if (rescuedText) {
          finished = true
          inflight.settle(tid, undefined, "answered")
          mirror.scheduleUnlock(sessionId)
          void drainQueue(ctx.userId, sessionId)
          // 投递失败不得上抛：账已结清，补投失败由 deliver 层自己的重试/降级负责
          await safeDeliver(ctx, `📤 你发来新消息前，上一回合已完成，结果如下：\n\n${rescuedText}`).catch(() => {})
          console.log(`[bridge] 接管前抢救：后台回合已完成且未投递，结果已补投 session=${sessionId}`)
          return
        }
      } catch {
        /* 探测失败落到 superseded 结算（原语义） */
      }
      inflight.settle(tid, undefined, "superseded")
      mirror.scheduleUnlock(sessionId)
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
          // DEF-qqbot-20261112-2 追加同口径守卫：正文所在消息必须已终结（time.completed）——
          // 权限挂起中工具阻塞的消息已流式出正文但回合未完（引擎 step.ended/failed/
          // interrupted 均落 completed，被杀回合不受影响），此类「无 idle 有未完成正文」
          // 不得在 finish 时被 SSE 完成事件误结（2026-11-12 实证交付「无文本产出」假完成）。
          if (turn.anchored && !turn.hasIdle && (!turn.text || !turn.textCompleted)) {
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
      if (trackId) inflight.settle(trackId, undefined, kind === "done" ? "answered" : kind === "giveup" ? "expired" : "superseded")
      cleanup()
      // Q1：后台等待终态 → 放行该 lane 队列（此前为串行而挂起；会话隔离后只放本会话 lane）
      void drainQueue(ctx.userId, sessionId)
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
        const msgs = listJson?.data ?? []
        // 终稿提取：与 rescue 同口径——工作稿（含工具段）不作答案投递
        const text = finalAnswerText(msgs, promptId, baseline)
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

    /** 死回合处置（owner 2026-11-19「先关而后断点继续」）：abort 由调用方发出，此处结清+交代+放行队列。 */
    async function finishDead(): Promise<void> {
      if (cancelled || finished) return
      finished = true
      if (trackId) inflight.settle(trackId, undefined, "expired")
      cleanup()
      // 断点继续：释放 lane 后立即 drain——队列里排在后面的消息接着执行
      void drainQueue(ctx.userId, sessionId)
      await safeDeliver(
        ctx,
        `⚠️ 后台任务底层执行多次失去响应（已自动续作 ${resumeCount} 次仍失败），停止自动跟进；队列已放行。如仍需要该结果请重新发送`,
      ).catch(() => {})
      console.log(`[bridge] 后台回合流活性丧失：续作${resumeCount}次仍死，expired 结清 session=${sessionId} msg=${shortId(trackId)}`)
    }

    /**
     * 死回合自动续作（owner 2026-11-19 裁定：单任务续作上限 3 次）——
     * 「继续」的落地形态=同会话注入新回合重发原 prompt，模型读会话历史接着做；
     * 不是断点续跑（LLM 回合执行体已随 abort 销毁，无从续起）。
     * 本 bgWait 不换班：onAccepted 切换锚点后继续盯梢新回合，盯到完成/再死/被取代。
     * 副作用口径：模型从历史可见死前已执行的动作，自行决定去重——与人工「重发」等价。
     */
    async function resumeDead(): Promise<void> {
      if (cancelled || finished) return
      resumeCount += 1
      console.log(`[bridge] 后台死回合自动续作 #${resumeCount}/${MAX_RESUME} session=${sessionId} msg=${shortId(trackId)}`)
      await safeDeliver(ctx, `⚠️ 后台任务底层执行失去响应，已自动中止并续作（第 ${resumeCount}/${MAX_RESUME} 次）；继续后台跟踪，完成自动回传`).catch(() => {})
      try {
        const prepared = ctx.preparedAttachments ?? await prepareQQAttachments(ctx.attachments, () =>
          getAccessToken(config.qq.appId, config.qq.clientSecret),
        )
        const { text: promptBody, files } = augmentPromptWithAttachments(ctx.content, prepared)
        const promptText =
          (ctx.quoteText ? `> 引用上文：${ctx.quoteText}\n\n${promptBody}` : promptBody) + QQ_LIST_FORMAT_HINT
        // 不阻塞 tick：promptAndWait 异步跑，onAccepted 切换锚点后由本 bgWait 的
        // 既有 tick（完成/停滞/流活性/superseded 全判据）继续监督新回合。
        void client.promptAndWait(sessionId, promptText, {
          files: files.length ? files : undefined,
          directory: anchorDirectory,
          onAccepted: (info) => {
            promptId = info.promptId
            baseline = info.baseline
            if (trackId) inflight.markResume(trackId, info.promptId, resumeCount)
            lastProgressAt = Date.now()
            lastHeartbeatAt = Date.now()
            lastMarker = ""
            console.log(`[bridge] 续作新回合已受理 msg=${shortId(trackId)} prompt=${shortId(info.promptId)}`)
          },
          onPermission: (req) => perm.waitForDecision(ctx, req, sessionId),
          onPermissionReplied: (d) => {
            const text = d === "reject" ? "已拒绝，该操作不会执行；AI 将继续其余步骤" : `已${DECISION_LABELS[d]}，AI 将继续执行…`
            void safeDeliver(ctx, text)
          },
          // 续作路径降级：冲突即时告警保留，10 分钟零进展保险网不再叠加
          // （原 dispatch 路径的完整保险网不受影响）。
          onPermissionConflict: (decision) => {
            const notice = formatPermissionConflictNotice(decision)
            if (notice) void safeDeliver(ctx, notice)
          },
        }).catch((error) => {
          console.error("[bridge] 续作重派失败:", error)
          // 续作本身失败：计一次消耗并交下轮判死/续作或 giveup（不静默）
          void safeDeliver(ctx, `⚠️ 续作重派失败：${toErrorMessage(error)}；后台监督继续，将再次尝试或按上限停止`).catch(() => {})
        })
      } catch (error) {
        console.error("[bridge] 续作 prompt 构造失败:", error)
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

        // 流活性监督（owner 2026-11-19 裁定：与后台探知同 tick、同一拉取结果）——
        // 死回合与长跑任务在「无进展」信号上同形（昨夜 BG101A 实证：流停 3s 后
        // 90 分钟假活）。判死 → 先关（abort 死回合）后断点继续（finishDead）。
        const live = streamLiveness(msgs, promptId, baseline, now, STREAM_DEAD_MS, TOOL_GRACE_MS)
        if (live === "dead") {
          // 先关（owner 裁定）：abort 死回合，幂等容忍失败
          await client.session.abort({ path: { id: sessionId } }).catch(() => undefined)
          // 后断点继续：续作上限内自动重发原 prompt（新回合），超限才 expired 放弃
          if (resumeDecision(resumeCount, MAX_RESUME) === "resume") {
            await resumeDead()
          } else {
            await finishDead()
          }
          return
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
    if (trackId) inflight.markStage(trackId, "background", { sessionId })
    console.log(`[bridge] 会话 ${sessionId} 转入后台等待（最长 ${BG_WAIT_MAX_MS / 3_600_000} 小时）`)
  }

  const watchApi: WatchApi = {
    start(userId, sessionID, ctx) {
      const prev = activeWatches.get(userId)
      if (prev && prev !== sessionID) unsubscribeSession(prev, userId)
      activeWatches.set(userId, sessionID)
      lastCtx.set(userId, ctx)
      subscribeSession(sessionID, userId)
      saveWatchedMap(activeWatches, storageAppId ? roleFile("watch.json") : undefined) // R2-P1-3：落盘，重启恢复
      return [
        `👁 已开启观察：${sessionID}`,
        "该会话的工具调用/执行完成会实时推送摘要，/status watch off 停止。",
        "（≥2 秒节流合并；QQ 主动消息有日配额，被动窗口内不受限）",
      ].join("\n")
    },
    stop(userId) {
      const sid = activeWatches.get(userId)
      if (!sid) return "当前没有开启观察"
      activeWatches.delete(userId)
      unsubscribeSession(sid, userId)
      saveWatchedMap(activeWatches, storageAppId ? roleFile("watch.json") : undefined) // R2-P1-3：落盘，重启不复活
      return `已停止观察：${sid}`
    },
    status(userId) {
      const sid = activeWatches.get(userId)
      return sid ? `👁 观察中：${sid}` : "未开启观察"
    },
  }

  // O7c：投递域门面（统一投递/降级/配额/节流队列/被动回复全在 core/delivery.ts）
  const { enqueuePush, safeDeliver, sendReply, deliver } = createDelivery(
    config,
    lastCtx,
    isBoundSession,
    storageAppId ? roleFile("quota.json") : undefined,
  )
  // DEF-1 修复（2026-11-04，UAT 实证）：通知类发送永不阻断主流程——受理回执/
  // K2 拦截/排队提示/问候等裸 sendReply 一旦被平台拒（40034024/超时）会直接
  // 中断 handleMessage（实证：回执失败 → 回合未派发给 AI 即结算，用户消息被吞）。
  // 统一走 notifyUser 兜底：发送失败仅告警，主流程继续。
  const notifyUser = async (ctx: MessageContext, text: string): Promise<void> => {
    // 出站推送门同口径（owner 2026-11-14）：锚定≠当前绑定不推（排队回执/ drain 通知等）
    if (ctx.anchorSessionId && !isBoundSession(ctx.userId, ctx.anchorSessionId)) {
      console.log(`[push-gate] 通知拦截：绑定已切走 anchor=${ctx.anchorSessionId.slice(0, 12)}… chars=${text.length}`)
      return
    }
    try {
      await sendReply(ctx, text)
    } catch (error) {
      console.warn("[bridge] 通知发送失败（不阻断主流程）:", toErrorMessage(error))
    }
  }

  // O7b：审批域门面（挂起槽/等待/裁决/跨重启恢复全在 core/permission.ts）
  // ★ 结合部契约（2026-11-17 固化）：onPermission（回合内即时推送，SSE permission.asked）
  // 与常驻交互监听（桌面端源审批 pushExternal）是同一挂起槽的两个入口——裁决/TTL/
  // 清槽必须两入口等价；clearIfResolved 保证桌面先决时 QQ 卡自动关闭（不双发）。
  // 多角色：本 gate 绑本角色 storageAppId（pending 落 roles/<appId>/），
  // 跨角色审批隔离=文件级+槽位 userId 级双保险，改造时不得合并。
  // Y-1 cron 提醒调度器（2026-11-23）：进程内单次提醒，重启即失（与 openclaw 同口径）
  const cronScheduler = new ReminderScheduler()

  // ===== goal 状态机（2026-11-23 下批批）=====
  // goalStates：会话 -> 最近已知 goal 状态（transition 检测用，5min 轮询 + 主动通知）。
  // goalKickoffs：会话 -> 设定时的目标原文（kickoff 轮归属的 bot 侧标记——引擎不给
  // kickoff user 消息打标，11-23 探测实证；用「边界 user 文本==目标原文」近似识别）。
  const goalStates = new Map<string, { state: string; at: number; notified: boolean }>()
  const goalKickoffs = new Map<string, { text: string; at: number }>()
  const GOAL_WATCH_INTERVAL_MS = 5 * 60_000
  const GOAL_NOTIFY_DEDUP_MS = 30 * 60_000
  let lastGoalWatchAt = 0

  /** goal 状态轮询：每 5min 对绑定会话查一次 /goal 状态，paused/done 转变即时推 QQ
   *  （下批批 owner 2026-11-23：状态变化不再静默）。失败静默，下轮再探。 */
  async function goalWatchTick(): Promise<void> {
    if (Date.now() - lastGoalWatchAt < GOAL_WATCH_INTERVAL_MS) return
    lastGoalWatchAt = Date.now()
    for (const s of sessions.all()) {
      const prev = goalStates.get(s.sessionId)
      // 只盯「曾见过 active」的会话——从未设过 goal 的会话每 5min 白查一次无意义
      if (!prev) continue
      try {
        let raw: string | null = null
        try {
          const res = await client.session.command({ path: { id: s.sessionId }, body: { name: "goal", text: "" } })
          raw = JSON.stringify(res)
        } catch (error) {
          raw = (error as { body?: string }).body ?? null
        }
        const parsed = raw ? parseGoalState(raw) : null
        if (!parsed) continue
        const transitionToTerminal = (parsed.state === "paused" || parsed.state === "done")
          && prev.state === "active"
          && (!prev.notified || Date.now() - prev.at > GOAL_NOTIFY_DEDUP_MS)
        if (parsed.state === "active") {
          goalStates.set(s.sessionId, { state: "active", at: Date.now(), notified: false })
        } else if (transitionToTerminal) {
          goalStates.set(s.sessionId, { state: parsed.state, at: Date.now(), notified: true })
          const head = parsed.state === "done" ? "✅ 目标已达成" : "🎯 目标已暂停"
          void safeDeliver(ctxForUser(s.userId), `${head}（${s.sessionId}）\n${parsed.message.slice(0, 400)}\n——发 /goal 看详情；resume 继续 / clear 放弃`).catch(() => {})
          console.log(`[goal-watch] 状态转变通知 user=${s.userId.slice(0, 8)}… state=${parsed.state}`)
        }
      } catch {
        /* 单会话探测失败不阻断整轮 */
      }
    }
  }

  const perm = createPermissionGate({
    client,
    sendReply,
    safeDeliver,
    // DEF-qqbot-20261112-1：裁决/超时拒答 reply 的 x-opencode-directory 来源
    //（引擎待审按 location 实例分仓；映射 directory 缺省时 reply 退化为裸发=旧行为）
    directoryOf: (userId) => sessions.getSession(userId)?.directory,
    // 2026-11-05 举一反三：审批槽清空（裁决/TTL）即唤醒该用户队列——否则挂起期间
    // 入队的消息要等用户再发一条才会动（drainQueue 的 pendingPerm 守卫无人解除）。
    onDecision: (userId) => {
      // 会话隔离：审批裁决放行该用户全部有货 lane（drainQueue 自身对忙 lane 空转安全）
      for (const lk of msgQueue.laneKeysOf(userId)) void drainQueue(userId, sessionIdOfLane(lk))
    },
    // A 项：审批卡片发送（失败自动降级文字菜单，permission 域内处理）；origin 穿透到卡片正文
    sendApprovalPrompt: (ctx, request, mainSessionId, origin) =>
      sendApprovalCard({ appId: config.qq.appId, clientSecret: config.qq.clientSecret }, ctx, request, mainSessionId, origin),
    // 多角色：审批态按角色分文件（缺省 legacy 全局）
    persistFile: storageAppId ? roleFile("pending-permissions.json") : undefined,
  })

  // O7d：摘要镜像域门面（订阅/回合标记/延迟解锁/摘要投递全在 core/mirror.ts）
  const mirror = createMirror({
    sessions,
    eventStream,
    client,
    lastCtx,
    safeDeliver,
    bgWaits,
    busyUsers,
    // 多角色：镜像开关按角色分文件（缺省 legacy 全局）
    settingsFile: storageAppId ? roleFile("settings.json") : undefined,
    // A 方案（owner 2026-11-23）：桌面端回合的摘要同样过 cron 钩——注册提醒+剥净标记
    onDigest: (userId, digest) => {
      const hit = parseCronReminder(digest, Date.now())
      if (!hit) return digest
      registerCron(userId, hit)
      return hit.cleanedText // 剥净为空 → 镜像侧跳过投递（注册即全部语义）
    },
    // kickoff 归属 bot 侧标记（2026-11-23）：引擎不给 kickoff user 消息打 goal 标——
    // 用「边界 user 文本==设定时目标原文」近似识别第三桶；30min TTL 自动过期。
    goalObjectiveOf: (sessionID) => {
      const k = goalKickoffs.get(sessionID)
      if (!k) return undefined
      if (Date.now() - k.at > 30 * 60_000) {
        goalKickoffs.delete(sessionID)
        return undefined
      }
      return k.text
    },
  })

  /** 双端共用的 cron 注册（QQ 侧与镜像侧同一调度器/上限/投递链）。 */
  function registerCron(userId: string, hit: { atMs: number; reminderText: string }): boolean {
    return cronScheduler.schedule(userId, hit.atMs, hit.reminderText, (uid, t) => {
      void safeDeliver(ctxForUser(uid), t).catch(() => {})
    })
  }

  // openqq notify 外部入队通道（feature：headless 定时任务结果推送，2026-11-05 外部提案 Part1）：
  // cron/CI 任意进程经 `openqq notify` 写 ~/.openqq/outbox.json（只入队），bot 进程消费投递。
  // delivery 全量复用（配额/降级/分条/24h 同文去重）；TTL 过期丢弃；失败退避重试到上限。
  createNotifySink({
    config,
    deliver: (ctx, text) => deliver(ctx, text),
    ...(process.env.QQ_OUTBOX_FILE ? { filePath: process.env.QQ_OUTBOX_FILE } : {}),
    // 多角色（2026-11-18 补漏）：outbox 按角色分文件——此前 multibot 改造漏了 notify 通道，
    // 两角色 sink 共享 legacy 全局 outbox.json 会互相代发/抢发。
    ...(storageAppId && !process.env.QQ_OUTBOX_FILE ? { filePath: roleFile("outbox.json") } : {}),
  })

  // L 项（2026-10-30）：表单桥（选择弹窗 A/B/C/D 的 QQ 同步与作答回传）。
  // 与审批共用"每用户单一交互槽"心智：表单挂起时优先消费用户回复。
  // 按钮卡片（弹窗验证前置）：选项直点直交，失败自动降级文字编号作答。
  const formBridge = createFormBridge({
    client,
    sendReply,
    safeDeliver,
    // 多角色：表单日志按角色分文件（缺省 legacy 全局）
    journalPath: storageAppId ? roleFile("forms.json") : undefined,
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

  // DEF-qqbot-20261123-1 R2：失效映射驱逐——轮询 400/404 累计 3 次判死驱逐并落盘；
  // 5xx/网络错误不驱逐（引擎重启窗口的合法映射靠这条不误伤）；任一成功即清零计数。
  const pollFails = new Map<string, number>()
  const httpStatusOf = (error: unknown): number | undefined => {
    const m = error instanceof Error ? error.message : String(error)
    const hit = /API\s+(\d{3})/.exec(m)
    return hit ? Number(hit[1]) : undefined
  }
  const notePollResult = (userId: string, sessionId: string, ok: boolean, status?: number): void => {
    const key = `${userId}|${sessionId}`
    if (ok) {
      pollFails.delete(key)
      return
    }
    if (status !== 400 && status !== 404) return
    const n = (pollFails.get(key) ?? 0) + 1
    pollFails.set(key, n)
    if (n >= 3) {
      pollFails.delete(key)
      sessions.evict(userId)
    }
  }

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

  async function interactionTick(): Promise<void> {
    try {
      // goal 状态轮询：piggyback 同一 12s tick，内部 5min 节流
      void goalWatchTick().catch(() => {})
      // 权限轮询兜底（SSE permission.asked 即时推送为主，轮询为断线兜底，双防线）。
      // DEF-qqbot-20261112-4（抄袭桌面形态）：改按会话端点（GET /session/:id/permission，
      // 引擎按会话自身实例路由）逐绑定会话轮询——零 directory 簿记；只有绑定会话才
      // 可能映射 QQ 用户（usersOfSession），未绑定会话的待审本就不该推 QQ。
      {
        const seen = new Map<string, PermissionRequest>()
        const lists = await Promise.all(
          sessions.all().map((entry) =>
            client.permission.forSession(entry.sessionId).then(
              (res) => {
                notePollResult(entry.userId, entry.sessionId, true)
                return res
              },
              (error: unknown) => {
                notePollResult(entry.userId, entry.sessionId, false, httpStatusOf(error))
                return undefined
              },
            ),
          ),
        )
        for (const res of lists) {
          for (const req of res?.data ?? []) {
            if (!seen.has(req.id)) seen.set(req.id, req)
          }
        }
        for (const req of seen.values()) {
          for (const uid of usersOfSession(req.sessionID)) {
            if (perm.hasPending(uid)) continue // 单一槽：在挂起（含同 id）即跳过
            // 出站推送门：绑定已切走的用户不推审批卡（owner 2026-11-14；历史/桌面端可裁决）
            if (!isBoundSession(uid, req.sessionID)) {
              console.log(`[push-gate] 审批卡拦截（轮询兜底）：绑定已切走 uid=${uid.slice(0, 8)}… sid=${shortId(req.sessionID)}`)
              continue
            }
            perm.pushExternal(uid, ctxForUser(uid), req, req.sessionID)
          }
        }
      }
      // 表单轮询兜底（REST 表单通道，form-bridge 承接渲染/回执）
      {
        for (const entry of sessions.all()) {
          const forms = (
            await client.form.list({ sessionID: entry.sessionId }).then(
              (res) => {
                notePollResult(entry.userId, entry.sessionId, true)
                return res
              },
              (error: unknown) => {
                notePollResult(entry.userId, entry.sessionId, false, httpStatusOf(error))
                return undefined
              },
            )
          )?.data ?? []
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

  if (INTERACTION_WATCH_MS > 0) {
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
      if (d?.requestID) {
        // 弹卡延迟闸：asked 后 defer 窗口内被处置 → 撤定时器不推卡（与桌面静默放行一致）
        permPushGate.cancel(d.requestID)
        perm.clearIfResolved(d.sessionID, d.requestID, d.reply)
      }
      return
    }
    if (ev.type !== "permission.asked") return
    const req = ev.data as unknown as PermissionRequest | undefined
    if (!req?.id || !req.sessionID) return
    for (const uid of usersOfSession(req.sessionID)) {
      if (perm.hasPending(uid)) continue
      // 出站推送门：绑定已切走不推卡（owner 2026-11-14）——usersOfSession 按映射反查，
      // 未绑定会话自然不在列；此处防的是「映射还在但用户已切走」的残留窗口。
      if (!isBoundSession(uid, req.sessionID)) {
        console.log(`[push-gate] 审批卡拦截（SSE asked）：绑定已切走 uid=${uid.slice(0, 8)}… sid=${shortId(req.sessionID)} request=${req.id}`)
        continue
      }
      console.log(
        `[perm-event] permission.asked 即时推送（延迟 ${PERM_DEFER_MS}ms 判定）user=${uid.slice(0, 8)}… request=${req.id}`,
      )
      permPushGate.schedule(uid, req.id, () => void flushPermPush(uid, req))
    }
  })

  // 延迟闸到点：确认请求仍悬置才推卡。双保险=REST 查待审列表（防 SSE 漏事件）；
  // 查询失败按悬置处理继续推（展示面 fail-open，不吞真人裁决入口）。
  // DEF-qqbot-20261112-1：反查必须带会话自身目录——引擎待审按 location 实例分仓，
  // 裸查只命中服务端 cwd 实例，项目会话的请求永远查空 → 恒弃推（ZERO2 实证挂起 5h24m 被误弃）。
  async function flushPermPush(uid: string, req: PermissionRequest): Promise<void> {
    const bound = sessions.getSession(uid)
    try {
      const res = await client.permission.list({ directory: bound?.directory })
      const still = (res?.data ?? []).some((r) => r.id === req.id)
      if (!still) {
        console.log(`[perm-event] 延迟判定：请求已被处置，弃推 user=${uid.slice(0, 8)}… request=${req.id}`)
        return
      }
    } catch {
      /* 查询失败不阻断推卡 */
    }
    // DEF-qqbot-20261110-4（实战实证）：来源标注按回合归属判定——该会话正有 bot
    // 前台回合在跑（QQ 发起）时不得标「桌面端回合」（此前一律 external，回执
    // 「已由桌面端处理」与事实不符）；真·桌面回合（该会话 lane 未命中）才标 external。
    const origin: PermOrigin =
      bound?.sessionId === req.sessionID && busyUsers.has(laneOf(uid, req.sessionID)) ? "bot" : "external"
    perm.pushExternal(uid, ctxForUser(uid), req, req.sessionID, origin)
  }

  const mirrorApi: MirrorApi = mirror.api

  // Q1：队列/台账派生视图（三源 join：内存队列 + 磁盘台账 + 运行态）
  function queueViewFor(userId: string): QueueView {
    const journal = inflight.view()
    return deriveQueueView({
      entries: [...journal.inflight, ...journal.settled].filter((e) => e.userId === userId),
      jobs: msgQueue.listUser(userId),
      orphanMs: resolveOrphanMs(process.env.QQ_ORPHAN_MS),
      queueMax: QUEUE_MAX,
      runtime: {
        // 会话隔离：busyLanes 即 busyUsers（lane 键集合）；running 按条目自身会话判定
        busyLanes: busyUsers,
        draining: draining.size > 0,
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
      const jobs = [...msgQueue.listUser(userId)]
      for (const job of jobs) {
        if (job.ctx.msgId) inflight.settle(job.ctx.msgId, undefined, "cancelled")
      }
      const n = msgQueue.clear(userId)
      if (n > 0) console.log(`[queue] clear user=${userId.slice(0, 8)}… count=${n} settle=cancelled`)
      return n
    },
    drop: (userId: string, id: number): string => {
      const job = msgQueue.find(userId, id)
      if (!job) return `队列里没有 #${id}`
      if (job.ctx.msgId) inflight.settle(job.ctx.msgId, undefined, "dropped")
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
    for (const e of inflight.pending()) {
      if (e.userId !== userId) continue
      inflight.settle(e.msgId, undefined, "cancelled")
      settled++
    }
    // 内存忙标志复位：悬挂的前台等待不退出时 busyUsers/draining 永久挡 drain
    // （11-06 实证 cancel 后死锁 12 分钟）。复位后 opencode 会话串行约束仍在
    // （服务端排队），bot 侧账幂等，不会出现重复投递。
    // 会话隔离：清该用户全部 lane，并逐 lane 续排。
    for (const k of [...busyUsers]) if (userIdOfLane(k) === userId) busyUsers.delete(k)
    for (const k of [...draining]) if (userIdOfLane(k) === userId) draining.delete(k)
    if (settled > 0) console.log(`[bridge] stopAll 结清在途账 user=${userId.slice(0, 8)}… count=${settled}`)
    for (const lk of msgQueue.laneKeysOf(userId)) void drainQueue(userId, sessionIdOfLane(lk))
    return { cleared, title: session?.title }
  }

  // 台账诊断命令实现（/ledger /ledger check /ledger settle）
  const ledgerApi: LedgerApi = {
    view: async (userId: string, args: string): Promise<string> => {
      const view = queueViewFor(userId)
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0]?.toLowerCase() ?? ""
      if (/^\d+$/.test(sub)) {
        // DEF-qqbot-20261110-8：数字先按尾号消解（唯一命中→详情/多条→歧义），零命中才当页码
        const resolution = resolveLedgerNumericArg(sub, [...view.inflightEntries, ...view.settledRecent])
        if (resolution.kind === "detail") return formatLedgerReply(view, { detail: resolution.entry })
        if (resolution.kind === "ambiguous") return `尾号「${sub}」匹配到 ${resolution.count} 条，请给更长的尾号`
        return formatLedgerReply(view, { page: resolution.page })
      }
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
        (e) =>
          e.msgId === key ||
          e.msgId.endsWith(key) ||
          // DEF-qqbot-20261112-6：QQ msgId 恒以 "!" 结尾，人工/Agent 抄尾号时极易
          // 丢 "!"（2026-11-12 实证：settle 三连"没有匹配"的根因）——容忍 bang 丢失
          e.msgId.endsWith(`${key}!`) ||
          shortId(e.msgId) === key,
      )
      if (hits.length === 0) return `台账在途里没有匹配「${key}」的条目`
      if (hits.length > 1) return `尾号「${key}」匹配到 ${hits.length} 条，请给更长的尾号`
      const hit = hits[0]
      if (!hit) return `台账在途里没有匹配「${key}」的条目`
      if (!confirm) {
        return `将结清：${shortId(hit.msgId)}「${previewText(hit.text, 30)}」\n确认请发 /ledger settle ${key} confirm`
      }
      const ok = inflight.settle(hit.msgId, undefined, "manual")
      const job = msgQueue.listUser(userId).find((j) => j.ctx.msgId === hit.msgId)
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
  const orphanNotifyState = new Map<string, OrphanNotifyState>()
  if (ORPHAN_SCAN_MS > 0) {
    setInterval(() => {
      try {
        const now = Date.now()
        const users = new Set(inflight.view().inflight.map((e) => e.userId))
        for (const uid of users) {
          const view = queueViewFor(uid)
          // design §3.4：仅新增孤儿且距上次提醒 >10min 发汇总（decideOrphanNotify 纯函数决策）
          const dec = decideOrphanNotify(
            orphanNotifyState.get(uid),
            view.orphan.map((o) => o.msgId),
            now,
            ORPHAN_NOTIFY_GAP_MS,
          )
          orphanNotifyState.set(uid, dec.state)
          if (!dec.notify) continue
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

  // 僵尸收割（DEF-qqbot-20261112-02 修法②，owner 2026-11-14 授权）：60s 独立巡检，
  // 收割 busy lane 悬挂态——前台时限/bgWait 双层自保都漏过的形态（11-12 实证 busy 挂 27min）。
  // 决策核纯函数在 core/zombie-reaper.ts（三级门，宁漏杀勿误杀）；此处只做探针与动作。
  const REAPER_SCAN_MS = (() => {
    const n = Number(process.env.QQ_REAPER_SCAN_SECONDS ?? "60")
    return Number.isFinite(n) && n > 0 ? Math.floor(n * 1000) : 0
  })()
  const REAPER_MIN_AGE = resolveReaperMs(process.env.QQ_REAPER_MIN_AGE_MS, REAPER_MIN_AGE_MS)
  const REAPER_SILENCE = resolveReaperMs(process.env.QQ_REAPER_SILENCE_MS, REAPER_SILENCE_MS)
  const DISPATCH_STALL = (() => {
    const n = Number(process.env.QQ_DISPATCH_STALL_MS ?? String(DISPATCH_STALL_MS))
    return Number.isFinite(n) && n >= 30_000 && n <= 3_600_000 ? n : DISPATCH_STALL_MS
  })()
  const REAPER_LANE_COOLDOWN_MS = 5 * 60_000
  const reaperCooldown = new Map<string, number>()

  async function reaperTick(): Promise<void> {
    const now = Date.now()
    let budget = 1 // 单 tick 至多 1 收：收割器自己绝不制造风暴
    for (const lane of [...busyUsers]) {
      if (budget <= 0) break
      const uid = userIdOfLane(lane)
      const laneSid = sessionIdOfLane(lane)
      // QQ_LANE_SCOPE=per-peer（design §2.3）：lane 退化为 per-user 与 null lane 同形，
      // 不能按「无 sid 不收割」跳过——真实会话从在途账回填。
      const perPeer = laneScope() === "per-peer"
      // null lane=派发窗口极短不收割（仅 per-session-peer 档；per-peer 档 lane 恒为 per-peer 形）
      if (!perPeer && !laneSid) continue
      // 账已不在但 lane 忙=纯悬挂标志（27min 实证形态），清锁放行即完成使命
      const entry = inflight.pending().find(
        (e) => e.userId === uid && e.state === "inflight" && (perPeer || e.sessionId === laneSid),
      )
      if (!entry) {
        busyUsers.delete(lane)
        console.log(`[reaper] 悬挂标志清理（无在途账）user=${uid.slice(0, 8)}… lane=${laneSid ? shortId(laneSid) : "per-user"}`)
        void drainQueue(uid, laneSid)
        continue
      }
      // per-peer 档：探针/abort/补投一律用账的真实会话（lane 键里没有会话信息）
      const sid = entry.sessionId
      // bgWait 会话有自带 giveup/停滞保险网
      if (!sid || bgWaits.has(sid)) continue
      // 引擎探针：会话消息列表 + turnStateOf（与 bgWait finish 同判据）；失败=本轮不动手
      const probe = await client.session.messages({ path: { id: sid } }).catch(() => undefined)
      const msgs = probe?.data
      const lastMsgAt = msgs?.length ? Math.max(...msgs.map((m) => m.time?.created ?? 0)) : entry.at
      const turn = msgs ? turnStateOf(msgs, entry.promptId ?? "", entry.at) : null
      const dec = decideReap({
        entry,
        turn,
        lastMsgAt,
        cooldownUntil: reaperCooldown.get(lane) ?? 0,
        now,
        minAgeMs: REAPER_MIN_AGE,
        silenceMs: REAPER_SILENCE,
      })
      if (dec.kind !== "reap-completed" && dec.kind !== "reap-stalled") continue
      // L2：回合未完且静默超时 → 单会话精准 abort（失败容忍：账侧仍按清障处理）
      if (dec.kind === "reap-stalled") {
        await client.session.abort({ path: { id: sid } }).catch(() => undefined)
      }
      // 动作前重验：lane 仍忙 + 账仍 inflight + 同一 attemptId——防竞态杀到新生回合
      if (!busyUsers.has(lane)) continue
      const cur = inflight.pending().find((e) => e.msgId === entry.msgId)
      if (!cur || cur.attemptId !== entry.attemptId) continue
      busyUsers.delete(lane)
      const ctx: MessageContext = { ...ctxForUser(uid), anchorSessionId: sid }
      if (dec.kind === "reap-completed" && dec.text) {
        // L1：回合实已完成 → 终稿补投（delivery 去重天然防双投）+ answered
        inflight.settle(entry.msgId, undefined, "answered")
        await safeDeliver(ctx, `📤 你卡住的回合其实已完成，结果补投如下：\n\n${dec.text}`).catch(() => {})
      } else {
        // 完成无正文（被杀回合）或 L2 静默强杀 → expired + 可见交代
        inflight.settle(entry.msgId, undefined, "expired")
        await safeDeliver(ctx, NOTICE.reaperExpired()).catch(() => {})
      }
      console.log(
        `[reaper] ${dec.kind} user=${uid.slice(0, 8)}… lane=${shortId(sid)} msg=${shortId(entry.msgId)} age=${Math.round((now - entry.at) / 60_000)}m`,
      )
      reaperCooldown.set(lane, now + REAPER_LANE_COOLDOWN_MS)
      void drainQueue(uid, sid)
      budget--
    }
    // DEF-qqbot-20261114-04（派发悬挂哨兵）：stage=dispatched 且无 promptId、超龄的账——
    // 幽灵派发（会话不存在）/派发未达引擎会把 lane 挂死冻结全队列（00:57 seed 实证）。
    // 与 busy-lane 收割同预算/同冷却键；probe 失败（网络）不动手，下轮再判。
    for (const entry of inflight.pending()) {
      if (budget <= 0) break
      if (entry.state !== "inflight" || entry.stage !== "dispatched" || entry.promptId || !entry.sessionId) continue
      const lane = laneOf(entry.userId, entry.sessionId)
      const until = reaperCooldown.get(lane) ?? 0
      if (now < until) continue
      const probe = await client.session.messages({ path: { id: entry.sessionId } }).catch((error: unknown) => error)
      const sessionExists = probe instanceof Error ? sessionExistsFromProbeError(probe.message) : true
      const dec = decideDispatchStall({ entry, sessionExists, now, stallMs: DISPATCH_STALL })
      if (dec.kind !== "reap-ghost" && dec.kind !== "reap-lost") continue
      // 动作前重验：账仍 inflight 同 attemptId；lane 若忙（该会话正被别的回合占用）一并释放
      const cur = inflight.pending().find((e) => e.msgId === entry.msgId)
      if (!cur || cur.attemptId !== entry.attemptId) continue
      busyUsers.delete(lane)
      inflight.settle(entry.msgId, undefined, "error")
      const ctx: MessageContext = { ...ctxForUser(entry.userId), anchorSessionId: entry.sessionId }
      await safeDeliver(
        ctx,
        `⚠️ 一条消息派发失败（${dec.kind === "reap-ghost" ? "目标会话已不存在" : "派发未到达引擎"}，已自动清理，不阻塞后续消息）。需要的话请重发：「${entry.text.length > 50 ? `${entry.text.slice(0, 50)}…` : entry.text}」`,
      ).catch(() => {})
      console.log(
        `[reaper] ${dec.kind} user=${entry.userId.slice(0, 8)}… lane=${shortId(entry.sessionId)} msg=${shortId(entry.msgId)} age=${Math.round((now - entry.at) / 1000)}s`,
      )
      reaperCooldown.set(lane, now + REAPER_LANE_COOLDOWN_MS)
      void drainQueue(entry.userId, entry.sessionId)
      budget--
    }
  }
  if (REAPER_SCAN_MS > 0) {
    setInterval(() => {
      void reaperTick().catch((error) => console.error("[reaper] 巡检失败:", toErrorMessage(error)))
    }, REAPER_SCAN_MS)
  }

  // Q2：手动进度查询（本地事件统计，零模型调用）
  const progressApi = {
    query: (userId: string): string => {
      const session = sessions.getSession(userId)
      if (!session) return "当前还没有会话，发消息即可开始"
      const st = turnStats.get(session.sessionId)
      const busy = anyLaneBusy(userId) ? "处理中" : "空闲"
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

  /**
   * /amend：steer 降级版「并入当前任务」（owner 2026-11-22 裁定，参考 Hermes update_prompt:y/n）。
   * 引擎无在途注入能力（openapi 139 端点实证），落地形态=打断并以「原 prompt+补充」同会话续跑
   * （模型读历史接着做，与死回合自动续作同语义）。abort 顺序复用 stopAll 证毕的
   * cancel→abort 链：先杀后台监督再 abort，杜绝「判死→自动续作」race 双跑。
   */
  async function amendCurrentTurn(userId: string, amendment: string): Promise<string> {
    const add = amendment.trim()
    if (!add) {
      return "用法：/amend <补充指令>——打断当前任务，把你的补充并入原指令一起续跑（模型从历史接着做）"
    }
    const session = sessions.getSession(userId)
    // 活动 lane=该用户名下仍 busy 的 lane（stopAll 同款口径，不依赖队列条目存在）
    const activeLane = [...busyUsers].find((k) => userIdOfLane(k) === userId)
    if (!session || !activeLane) return "当前没有进行中的任务，直接发消息即可"
    // —— /amend v3：真 steer（2026-11-23 对齐官方 TUI「忙时 Enter steers」语义）——
    // 订正：steer 不在独立端点上，藏在 prompt body 的 delivery 枚举（Session.Inbox
    // .Delivery=steer|queue）——此前「引擎无 steer」结论系关键词检索漏判（教训同
    // form 命名空间事件，已入技能纪律）。steer=补充直达在途回合：无 abort、无 token
    // 沉没、死回合残骸为零。失败（引擎旧版/竞态）回落 v2 abort+revert 链。
    try {
      await client.session.prompt({
        path: { id: session.sessionId },
        body: { text: `【补充指令】${add}`, delivery: "steer" },
      })
      console.log(`[bridge] amend steer 已送达 user=${userId.slice(0, 8)}… session=${shortId(session.sessionId)}`)
      return "✅ 已把补充送进当前任务（官方 steer 语义：模型把这条指令并入正在跑的回合，完成照常回传）"
    } catch (error) {
      console.log(`[bridge] amend steer 被拒，回落 abort+revert 链: ${toErrorMessage(error)}`)
    }
    // —— 回落链（v2，2026-11-22）：abort → revert 清残骸 → 合并重发 ——
    // 原 prompt 取在途账：本用户锚定会话里已落 promptId 的活动回合（stage running/background
    // 或 dispatched——只要 state=inflight 且有 promptId 即本回合；取最新一条）
    const entry = selectAmendEntry(inflight.pending(), userId, session.sessionId)
    if (!entry) {
      return "找不到可并入的原任务（可能由桌面端发起或已被结清）；请用 /cancel 后重发完整指令"
    }
    // 1) 先杀后台监督（bgWait cancel=监督循环退出，resumeDead 不可能再触发）
    bgWaits.get(session.sessionId)?.cancel()
    // 2) abort 当前回合（悬挂回合可能已自行终结，失败不阻断）
    try {
      await client.session.abort({ path: { id: session.sessionId } })
    } catch {
      /* 同 stopAll：abort 失败不阻断复位 */
    }
    // 3) 结清被并入回合的账（cancelled=用户主动中止语义，与 /cancel 同口径）
    inflight.settle(entry.msgId, entry.attemptId, "cancelled")
    // 3.5) 官方 /undo 语义对齐（snapshots 文档）：abort 后会话不再 running——尝试把
    // 死回合连同原 prompt 一起 revert 出上下文（files:true=死回合改过的文件一并恢复），
    // 模型续跑时看到的是「任务从没开始」的干净历史。revert 失败（非 git 目录/旧引擎/
    // 竞态）回落 v1「读历史续跑」语义——不阻塞功能，只降级体感。
    let reverted = false
    try {
      await client.session.revertStage({ path: { id: session.sessionId }, body: { messageID: entry.promptId as string, files: true } })
      await client.session.revertCommit({ path: { id: session.sessionId } })
      reverted = true
    } catch (error) {
      try {
        await client.session.revertDiscard({ path: { id: session.sessionId } })
      } catch {
        /* 无暂存可弃（stage 即失败场景） */
      }
      console.log(`[bridge] amend revert 失败，回落读历史续跑 session=${shortId(session.sessionId)}: ${toErrorMessage(error)}`)
    }
    // 4) 合成并入消息入队：原 prompt + 补充指令，drain 在 lane 释放后续跑
    //（复用既有 FIFO/单飞/在途账全链；msgId 空=主动通道投递，同 reaper 合成 ctx 先例）
    const actx: MessageContext = { ...ctxForUser(userId), msgId: "", content: buildAmendPrompt(entry.text, add) }
    msgQueue.push(activeLane, userId, session.sessionId, actx)
    console.log(`[bridge] amend 并入 user=${userId.slice(0, 8)}… lane=${shortId(session.sessionId)} msg=${shortId(entry.msgId)}`)
    // 5) 手动释放 lane + drain（bgWait 已 cancel，监督不会复活抢 lane）
    busyUsers.delete(activeLane)
    void drainQueue(userId, session.sessionId)
    return reverted
      ? "✅ 已打断并清空该回合（含文件回滚），正带你的补充重新起跑"
      : "✅ 已打断当前任务，正把你的补充并入原指令续跑（模型从历史接着做，完成自动回复）"
  }

  /**
   * /undo：对齐官方 TUI /undo（snapshots 文档三段语义的一次性版）——stage 到最后一条
   * user 消息边界（files:true 恢复该回合改动的文件）→ commit → 回执带被撤 prompt
   * （QQ 版「prompt 回盒」：用户改后可重发，或 /amend <补充> 带修改续跑）。
   * 运行中拒绝（官方语义：OpenCode rejects rollback while the session is running）。
   */
  async function undoLastTurn(userId: string): Promise<string> {
    const session = sessions.getSession(userId)
    if (!session) return "没有绑定的会话，无事可撤销"
    if ([...busyUsers].some((k) => userIdOfLane(k) === userId)) {
      return "当前有任务在跑——官方语义运行中不可回滚；请先等它完成，或 /cancel 后再 /undo"
    }
    let msgs: Awaited<ReturnType<typeof client.session.messages>>["data"] = []
    try {
      msgs = (await client.session.messages({ path: { id: session.sessionId }, query: { limit: 50 } })).data ?? []
    } catch (error) {
      return `读取会话失败：${toErrorMessage(error)}`
    }
    const boundary = lastUserMessageId(msgs)
    if (!boundary) return "会话里没有可撤销的用户消息"
    const removed = msgs.find((m) => m.id === boundary)
    const removedText = messageTextOf(removed ?? {}).trim()
    try {
      await client.session.revertStage({ path: { id: session.sessionId }, body: { messageID: boundary, files: true } })
      await client.session.revertCommit({ path: { id: session.sessionId } })
    } catch (error) {
      try {
        await client.session.revertDiscard({ path: { id: session.sessionId } })
      } catch {
        /* 无暂存可弃 */
      }
      return `撤销失败：${toErrorMessage(error)}（引擎拒绝或快照缺失；会话内容未改动）`
    }
    console.log(`[bridge] undo 已回滚 user=${userId.slice(0, 8)}… session=${shortId(session.sessionId)} boundary=${shortId(boundary)}`)
    const box = removedText ? `被撤回的指令：「${removedText.length > 80 ? `${removedText.slice(0, 80)}…` : removedText}」\n改好后重新发送即可，或 /amend <修改点> 带修改重跑。` : "改好后重新发送即可。"
    return `↩️ 已撤销上一回合（该回合改动的文件已一并恢复）。\n${box}`
  }

  /**
   * 显性入队（/queue <文本>，owner 2026-11-23）：steer 默认模式下把文本显式排进
   * FIFO（而非并入当前任务）。合成 ctx（msgId 空=主动通道投递，同恢复重派先例），
   * 走既有 msgQueue/drain 全链（单飞/台账/去重全继承）；当前空闲则入队即执行。
   */
  async function enqueueExplicit(ctx: MessageContext, text: string): Promise<string> {
    const session = sessions.getSession(ctx.userId)
    const sid = session?.sessionId
    if (!sid) return "没有绑定的会话，请先发消息建立会话再排队"
    const lane = laneKeyOf(ctx.userId, sid)
    const actx: MessageContext = { ...ctx, msgId: "", content: text }
    const queued = msgQueue.push(lane, ctx.userId, sid, actx)
    if (!queued) return "队列已满，请等当前任务完成或 /queue clear 后重试"
    console.log(`[queue] 显性入队 user=${ctx.userId.slice(0, 8)}… qid=${queued.job.id} ahead=${queued.ahead}`)
    void drainQueue(ctx.userId, sid)
    if (queued.ahead === 0 && !busyUsers.has(lane)) {
      return `📥 已入队 #${queued.job.id}，当前空闲，立即执行`
    }
    return `📥 已排队 #${queued.job.id}（第 ${queued.ahead + 1} 位），当前任务结束后自动执行`
  }

  /**
   * 官方斜杠命令直通（owner 2026-11-23）：/goal /compact /redo /btw 经引擎
   * POST /session/{id}/command 执行——与桌面端同一实现（goal 的 idle 审查器、
   * 50 轮/停滞刹车全在引擎侧，咱们零重写=严格对齐）。引擎 <2.2.1 无内置 goal
   * 时如实报错。
   */
  async function runEngineCommand(userId: string, name: string, text: string): Promise<string> {
    const session = sessions.getSession(userId)
    if (!session) return "没有绑定的会话；先在 QQ 里发一条消息建立会话"
    try {
      const res = (await client.session.command({
        path: { id: session.sessionId },
        body: { name, text },
      })) as { data?: { text?: string; message?: string }; text?: string; message?: string }
      const reply = res?.data?.text ?? res?.text ?? res?.data?.message ?? res?.message
      if (reply) return reply
      // 引擎 command 端点对多数命令不回文本——给分命令的诚实兜底（真机实证 11-23：
      // /goal 设完静默执行多轮，用户误以为没生效）
      if (name === "goal") {
        const t = text.trim()
        if (/^clear/i.test(t)) {
          goalKickoffs.delete(session.sessionId)
          goalStates.delete(session.sessionId)
        } else if (t && !/^(pause|resume|status)?$/i.test(t)) {
          // 设定新目标：登记 kickoff 原文（镜像归属 bot 侧标记）+ 状态机入 active
          goalKickoffs.set(session.sessionId, { text: t, at: Date.now() })
          goalStates.set(session.sessionId, { state: "active", at: Date.now(), notified: false })
        } else if (/^resume/i.test(t)) {
          goalStates.set(session.sessionId, { state: "active", at: Date.now(), notified: false })
        }
        return "✅ goal 已执行（引擎无文本回执）。查状态再发 /goal；控制用 /goal pause|resume|clear。设定目标后会话自主续跑，进展会以普通回复推送到这里"
      }
      return `✅ /${name} 已执行（引擎无文本回执）`
    } catch (error) {
      const msg = toErrorMessage(error)
      // 引擎把 goal 状态（paused/done 的完成度审计）走 500 CommandExecutionError
      // 通道返回（真机实证 11-23）——非真失败：优先读 error.body 的完整 JSON
      //（日志 excerpt 有 200 字截断，长审计会切断 JSON 使状态解析失配），统一走
      // parseGoalState 按状态报告呈现。
      if (name === "goal") {
        const full = (error as { body?: string }).body ?? msg
        const parsed = parseGoalState(full)
        if (parsed) {
          if (parsed.state === "active") goalStates.set(session.sessionId, { state: "active", at: Date.now(), notified: false })
          return `📋 目标状态（goal）：\n${parsed.message}`
        }
      }
      return `引擎命令执行失败（/goal 需 OpenCode ≥ 2.2.1）：${msg}`
    }
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
    amend: amendCurrentTurn,
    undo: undoLastTurn,
    enqueue: enqueueExplicit,
    engineCommand: runEngineCommand,
  }

  // R2 修复批次启动项（2026-10-14）
  if (config.allowedUsers.length === 0) {
    console.warn("[security] ALLOWED_USERS 为空 → 所有消息将被拒绝（fail-closed）；请在 ~/.openqq/.env 配置白名单")
  }
  // R2-P1-3：恢复持久化的 /watch 订阅（里程碑已改 /watch 专属，重启不得静默丢）
  {
    const saved = loadWatchedMap(storageAppId ? roleFile("watch.json") : undefined)
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
    if (pruned) saveWatchedMap(activeWatches, storageAppId ? roleFile("watch.json") : undefined)
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
    // 会话隔离（owner 2026-11-14，DEF-qqbot-20261112-01 修法①）：锚定会话=入队快照
    // （drain 重入已带）或当前绑定；队列/忙锁按 (userId, 锚定会话) lane 粒度。
    // 声明于函数最顶：外层 catch 也引用 lane——放晚了错误路径会撞 TDZ；
    // 快照先于一切 await，之后绑定切走也不改本消息归属。
    const anchorSid = ctx.anchorSessionId ?? sessions.getSession(ctx.userId)?.sessionId ?? null
    const lane = laneOf(ctx.userId, anchorSid)
    // drain 重入/重启恢复的 ctx 已带受理账；若它在派发前的早退点（表单消费/命令/
    // 序号选择/审批挂起）被拦截，必须结清该账——否则台账残留 inflight，孤儿巡检
    // 会每 10 分钟刷一次告警（2026-11-05 实证：审批挂起导致队列 #1 卡成孤儿）。
    const releaseClaimed = (reason: SettleReason, note?: string): void => {
      if (!ctx.msgId || !claimedContexts.has(ctx)) return
      inflight.settle(ctx.msgId, undefined, reason)
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
      // 纯图消息（无文字但有附件）同样放行；真空消息才丢。
      // DEF-qqbot-20261111-P2（owner 2026-11-12 裁定）：纯表情不回静默——有据提示。
      if (!content && !ctx.attachments?.length) {
        if (ctx.emojiOnly) {
          await notifyUser(ctx, "收到表情 🙂 纯表情我无法理解，请补充文字（表情+文字一起发也可以）")
        }
        return
      }
      // 记录最近消息上下文：观察/过程推送的通道选择（被动优先）
      lastCtx.set(ctx.userId, ctx)

      // 首条消息问候：跳过命令消息——/help 与问候语同源（buildHelpText），
      // 不跳过会双发相同内容（2026-11-02 用户实证：首次 /help 回复两次）。
      if (!greeted.has(ctx.userId) && !isCommand(content)) {
        greeted.add(ctx.userId)
        saveGreetedSet(greeted, storageAppId ? roleFile("greeted.json") : undefined)
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
          const admitted = inflight.claimDetailed(
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
            const pend = inflight.pending().find((e) => e.fingerprint === messageFingerprint(ctx.userId, intentKey))
            const digest = pend ? `（在途内容：${previewText(pend.text)}）` : ""
            await notifyUser(ctx, `你的相同问题正在处理中${digest}，本次重发已忽略`)
            return
          }
          claimedContexts.add(ctx)
        }
        claimedMsgId = ctx.msgId
      }

      if (busyUsers.has(lane) && !claimedContexts.has(ctx)) {
        const duplicateIntent = activeIntents.get(lane) === intentKey || msgQueue.hasIntent(lane, intentKey)
        if (duplicateIntent) {
          inflight.settle(ctx.msgId, undefined, "duplicate-intent") // 重复意图已有原回合负责，直接结清，禁止恢复时再跑
          console.log(`[bridge] 相同意图已在执行/队列，跳过 msgId=${ctx.msgId}`)
          return
        }
      }

      if (busyUsers.has(lane)) {
        // 忙时默认=steer（owner 2026-11-23 裁定：对齐官方 TUI「忙时 Enter steers」；
        // QQ_BUSY_DEFAULT=queue 切回客户端 FIFO 排队旧行为）——附件消息不走 steer
        //（附件需完整派发管线下载加工），自动落排队。
        if (resolveBusyMode(process.env.QQ_BUSY_DEFAULT) === "steer" && !ctx.attachments?.length) {
          try {
            const sidForSteer = anchorSid ?? sessions.getSession(ctx.userId)?.sessionId
            if (sidForSteer) {
              await client.session.prompt({
                path: { id: sidForSteer },
                body: { text: ctx.content, delivery: "steer" },
              })
              // 账侧：本条 msgId 由在途回合负责答复，steered 结清（孤儿收割不误伤）
              if (ctx.msgId) inflight.settle(ctx.msgId, undefined, "steered")
              console.log(`[bridge] 忙时 steer 并入 lane=${shortId(sidForSteer)} msg=${shortId(ctx.msgId)}`)
              await notifyUser(ctx, "🔄 已并入当前任务（官方 steer 语义，默认行为；想排队改 ~/.openqq/.env 的 QQ_BUSY_DEFAULT=queue）")
              return
            }
          } catch (error) {
            // steer 被拒（引擎竞态/旧版）：落回下方排队路径，不丢消息
            console.log(`[bridge] 忙时 steer 失败改排队 msg=${shortId(ctx.msgId)}: ${toErrorMessage(error)}`)
          }
        }
        // Q1（学习 pi-qqbot 队列 UX）：忙碌不再拒绝——FIFO 排队，回合结束自动执行
        // 自检补强：入队即下载附件——QQ 签名 URL 短时效，drain 时下载必过期
        if (ctx.attachments?.length && !ctx.preparedAttachments) {
          ctx.preparedAttachments = await prepareQQAttachments(ctx.attachments, () =>
            getAccessToken(config.qq.appId, config.qq.clientSecret),
          )
        }
        const queued = msgQueue.push(lane, ctx.userId, anchorSid ?? undefined, ctx)
        if (!queued) {
          if (claimedMsgId) inflight.settle(claimedMsgId, undefined, "queue-full") // 已满回执即终态，不能留账让启动对账再次执行
          console.log(`[queue] reject user=${ctx.userId.slice(0, 8)}… msg=${shortId(ctx.msgId)} reason=full size=${msgQueue.size(lane)}/${QUEUE_MAX}`)
          await notifyUser(ctx, formatQueueFullReceipt(QUEUE_MAX))
          return
        }
        if (ctx.msgId) {
          // 入队即锚定落账：queued 级也带 sessionId（重启恢复按 lane 归组）
          inflight.markStage(ctx.msgId, "queued", { queueId: queued.job.id, enqueuedAt: queued.job.enqueuedAt, ...(anchorSid ? { sessionId: anchorSid } : {}) })
        }
        console.log(
          `[queue] enqueue user=${ctx.userId.slice(0, 8)}… lane=${anchorSid ? shortId(anchorSid) : "∅"} qid=${queued.job.id} msg=${shortId(ctx.msgId)} ahead=${queued.ahead} size=${msgQueue.size(lane)}/${QUEUE_MAX}`,
        )
        // 入队前已由 claimInflight 落账；drain 重入时回填 sessionId，不重复写账。
        await notifyUser(
          ctx,
          `已排队 #${queued.job.id}（第 ${queued.ahead + 1} 位${queued.ahead > 0 ? `，前面还有 ${queued.ahead} 条` : ""}），当前任务结束后自动执行。\n发 /queue 查看队列，/cancel 可中止当前任务并清空队列；想立刻把新消息并进当前任务：/amend <补充>（打断并以原指令+补充续跑）。`,
        )
        return
      }

      activeIntents.set(lane, intentKey)
      busyUsers.add(lane)

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
      let anchorDirectory: string | undefined = undefined // 权限链目录（catch 转后台续作也要用，随 try 内赋值）
      try {
        // 会话隔离：派发跟锚定不跟漂移——锚定会话直发（哪怕绑定已切走）；
        // 无锚定（null lane，从未绑定）才 getOrCreate 解析并落新绑定。
        if (anchorSid) {
          sessionId = anchorSid
        } else {
          const session = await sessions.getOrCreate(ctx.userId)
          sessionId = session.sessionId
        }
        ctx.anchorSessionId = sessionId
        sessionLastActivity.set(sessionId, Date.now())
        // DEF-qqbot-20261112-1 同口径：权限链目录必须是「锚定会话自身」的目录——
        // 锚定≠绑定时映射缓存指向错会话，从服务端回读锚定会话目录（失败回落绑定缓存）。
        anchorDirectory = sessions.getSession(ctx.userId)?.directory
        if (sessions.getSession(ctx.userId)?.sessionId !== sessionId) {
          anchorDirectory =
            (await client.session.get({ path: { id: sessionId } }).catch(() => undefined))?.data?.location?.directory ??
            anchorDirectory
        }

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
        const promptText =
          (ctx.quoteText ? `> 引用上文：${ctx.quoteText}\n\n${promptBody}` : promptBody) + QQ_LIST_FORMAT_HINT
        // R 项（2026-10-30）：在途台账落账——派发前记录，送达才销账；
        // 进程中途死亡时启动对账据此恢复。重派回合无真实 msgId，用合成键跟踪。
        trackId = ctx.msgId || `redispatch-${sessionId}-${turnStart}`
        inflight.record({ msgId: trackId, userId: ctx.userId, sessionId, text: content.slice(0, 300), at: Date.now() })
        inflight.markStage(trackId, "dispatched", { sessionId })
        console.log(`[journal] dispatch user=${ctx.userId.slice(0, 8)}… msg=${shortId(trackId)} sid=${shortId(sessionId)}`)
        let replyText: string
        {
          replyText = await client.promptAndWait(sessionId, promptText, {
          files: files.length ? files : undefined,
          // DEF-qqbot-20261112-1：权限轮询/裁决携带会话项目目录（引擎待审按
          // location 实例分仓，裸查失明/裸 reply 404——见 design §3.6 权限实例上下文）。
          // 会话隔离：目录=锚定会话自身目录（锚定≠绑定时已从服务端回读）。
          directory: anchorDirectory,
          // 修复⑧：受领即落台账锚点 + 本地闭合变量（前台超时转后台等待要带上）
          onAccepted: (info) => {
            promptId = info.promptId
            inflight.markPromptId(trackId, info.promptId)
            // DEF-20261118-P6 来源身份守卫：promptId=用户消息 id，入镜像 QQ 派发册——
            // 网关 RESUME 迟到重放的完成事件穿透时序锁后，仍被身份核对拦下（不重复摘要）。
            mirror.markQqPrompt(sessionId, info.promptId)
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

        let turnDelivered = false // DEF-qqbot-20261110-9：实际出站与否决定销账口径
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
          // Y-1 cron 提醒（2026-11-23 学习吸收 openclaw）：正文内嵌 QQBOT_PAYLOAD 标记
          // → 注册一次性提醒并剥离标记；剥净为空则以确认句回执（不留脚手架痕迹）。
          let outboundText = extracted.text
          const cronHit = parseCronReminder(extracted.text, Date.now())
          if (cronHit) {
            const okCron = registerCron(ctx.userId, cronHit)
            const when = new Date(cronHit.atMs).toLocaleString("zh-CN", { hour12: false })
            outboundText = cronHit.cleanedText ||
              (okCron ? `⏰ 好的，已设置提醒（${when}）：${cronHit.reminderText}` : "⚠️ 提醒设置失败（同时在册超限），请重试")
          }
          if (outboundText.trim()) turnDelivered = await safeDeliver(ctx, redactSecrets(outboundText))
        }
        // DEF-qqbot-20261110-9（2026-11-10 回归实证）：有正文但被 24h 去重拦截时
        // 不得记 answered——那是「台账假已答、用户侧零内容」。改记 error 并给用户交代。
        // 会话隔离（owner 2026-11-14）：推送门拦截≠未送达——结果已入锚定会话历史
        // （QQ 只呈现当前绑定会话），按 answered 结清；仅 24h 去重拦截记 error。
        if (replyText.trim() && !turnDelivered) {
          if (ctx.anchorSessionId && !isBoundSession(ctx.userId, ctx.anchorSessionId)) {
            console.log(`[push-gate] 回合结果按历史可回读结清 answered msg=${shortId(trackId)}`)
            inflight.settle(trackId, undefined, "answered")
          } else {
            await safeDeliver(ctx, "⚠️ 本轮结果与 24h 内已发送内容重复，已被防重拦截（未重复投递）。如非预期请重发或换个说法")
            inflight.settle(trackId, undefined, "error")
          }
        } else {
          inflight.settle(trackId, undefined, "answered")
        }
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
            inflight.settle(trackId, undefined, "answered")
          } else {
            console.log(`[bridge] 回合被同会话新输入接管（superseded）msg=${shortId(trackId)} sid=${shortId(sessionId)}`)
            await safeDeliver(ctx, "⚠️ 上一条任务被同会话的新输入打断，未产出结果；如需结果请重新发送")
            inflight.settle(trackId, undefined, "superseded")
          }
        } else if (sessionId && turnStart > 0 && error instanceof Error && error.message.includes("响应超时")) {
          // 前台时限到 ≠ 放弃：任务继续跑，转入后台等待（SSE + 5 分钟轮询兜底，
          // 最长 24 小时），完成时经 deliver 被动/主动回传 —— 12 小时长任务的答案也不丢。
          // R 项：不销账——bgWait 完成投递时才销（完成前死亡由启动对账接管）。
          await safeDeliver(
            ctx,
            "⏳ 回合超过前台时限，已转后台等待：任务继续执行，完成即回传结果（最长 24 小时）。期间可用 /history 查看进展。",
          )
          startBackgroundWait(sessionId, ctx, turnStart, trackId, promptId, turnStart, anchorDirectory)
        } else if (isSessionBusyError(error)) {
          // 会话被占用（-32603，可能来自桌面端/他端并发）。不再把 Internal error 原样
          // 甩给用户，给可操作路径；每用户串行队列已挡掉我方自撞，这条只兜他端占用。
          console.error(`[bridge] 会话被占用（active prompt）sid=${shortId(sessionId)}: ${toErrorMessage(error)}`)
          await safeDeliver(
            ctx,
            "⏳ 该会话正有回合在执行（可能是桌面端在跑，或上一轮尚未结束），本轮未重复发起。\n发 /cancel 可中止当前回合后重试。",
          )
          inflight.settle(trackId, undefined, "error")
        } else {
          // Q3：额度/鉴权错误给救援话术（报类别+原文+恢复路径），不死胡同报错
          const errText = toErrorMessage(error)
          const rescue = rescueText(classifyProviderError(errText), errText)
          await safeDeliver(ctx, rescue ?? `处理失败：${errText}`)
          inflight.settle(trackId, undefined, "error") // R 项：失败反馈已送达 = 终态，销账
        }
      } finally {
        if (sessionId) unsubscribeSession(sessionId, ctx.userId) // /watch 若仍挂着则保留订阅
        // 镜像解锁：转后台的任务由 bgWait 完成时解锁，其余延迟 5 秒（SSE 事件宽限）
        if (sessionId && !bgWaits.has(sessionId)) mirror.scheduleUnlock(sessionId)
        // 会话隔离：释放本消息 lane；派发解析出的会话与锚定不同（null lane 新建会话）时一并释放
        busyUsers.delete(lane)
        if (sessionId && laneOf(ctx.userId, sessionId) !== lane) busyUsers.delete(laneOf(ctx.userId, sessionId))
        if (activeIntents.get(lane) === intentKey) activeIntents.delete(lane)
        // 队列完成回执（默认关闭）：只对 drain 重入的条目发，普通消息不刷屏。
        const finishedQueueId = queueIdOfCtx.get(ctx)
        if (finishedQueueId !== undefined && QUEUE_RECEIPTS_ENABLED) {
          await notifyUser(ctx, `队列 #${finishedQueueId} 完成（剩余 ${msgQueue.sizeUser(ctx.userId)} 条）`)
        }
        // Q1：回合结束（成功/失败/转后台）→ 自动执行该 lane 下一条；
        // 转后台等待的会话保持串行——由 bgWait 完成时再 drain（不与前序后台任务并发）
        if (sessionId && !bgWaits.has(sessionId)) void drainQueue(ctx.userId, sessionId)
      }
    } catch (error) {
      // 认领后、内层回合兜底之前的异常（如排队附件预下载失败）也必须结清，
      // 否则重启对账会把已反馈失败的消息再执行一次。
      if (claimedMsgId) inflight.settle(claimedMsgId, undefined, "error")
      if (activeIntents.get(lane) === intentKey) activeIntents.delete(lane)
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
    const pending = inflight.pending()
    if (pending.length === 0) return
    console.log(`[bridge] 启动对账：${pending.length} 条在途消息待恢复`)

    const restoreWindow = redispatchMaxAgeMs()
    const restorable = new Set<string>()
    const queueCandidates = pending.filter(
      (e) => !e.sessionId && !e.promptId && Date.now() - e.at <= restoreWindow,
    )
    if (queueCandidates.length > 0) {
      // 会话隔离（owner 2026-11-14）：按 (userId, 锚定 sessionId) 分 lane 重建——
      // 2026-11-14 起 queued 级入队即落 sessionId 快照；旧账无 sessionId 归 null lane。
      const byLane = new Map<string, InflightEntry[]>()
      for (const e of queueCandidates) {
        const lk = laneOf(e.userId, e.sessionId)
        const list = byLane.get(lk) ?? []
        list.push(e)
        byLane.set(lk, list)
      }
      for (const [lk, list] of byLane) {
        const uid = userIdOfLane(lk)
        list.sort((a, b) => (a.enqueuedAt ?? a.at) - (b.enqueuedAt ?? b.at))
        const jobs = list.map((e) => ({
          ...(e.queueId !== undefined ? { id: e.queueId } : {}),
          // 锚定取条目自身会话（QQ_LANE_SCOPE=per-peer 时同 lane 混多会话，lane 级 sid 为空会丢锚）
          ...(e.sessionId ? { sessionId: e.sessionId } : {}),
          ctx: {
            type: "c2c" as const,
            userId: uid,
            msgId: e.msgId,
            content: e.text,
            timestamp: String(e.at),
            ...(e.sessionId ? { anchorSessionId: e.sessionId } : {}),
          },
          text: e.text,
          enqueuedAt: e.enqueuedAt ?? e.at,
        }))
        const restored = msgQueue.restore(lk, uid, sessionIdOfLane(lk), jobs)
        if (restored > 0) {
          const restoredJobs = msgQueue.list(lk).slice(-restored)
          for (const job of restoredJobs) {
            // drain 重入必须跳过重复认领，否则 duplicate-msgid 会把恢复条目静默丢掉。
            claimedContexts.add(job.ctx)
            // force：旧 stage（如 dispatched 空账）在进程换代后不再可信，恢复即回到 queued。
            // 会话回填取 job 锚定（QQ_LANE_SCOPE=user 时 lane 级 sid 为空，锚在 job 上）
            const jobSid = job.sessionId
            inflight.markStage(job.ctx.msgId, "queued", { queueId: job.id, enqueuedAt: job.enqueuedAt, ...(jobSid ? { sessionId: jobSid } : {}) }, { force: true })
            restorable.add(job.ctx.msgId)
          }
          console.log(
            `[queue] restore user=${uid.slice(0, 8)}… lane=${sessionIdOfLane(lk) ? shortId(sessionIdOfLane(lk)!) : "∅"} count=${restored} window=${Math.round(restoreWindow / 60_000)}m`,
          )
          await deliver(
            ctxForUser(uid),
            `🔄 重启恢复：${restored} 条排队消息已恢复（发 /queue 查看；/queue clear 可清空）`,
          )
        }
      }
    }

    // DEF 队列容量拒收文案误标修复（owner 2026-11-14「全修剩下缺陷」批，P6）：
    // 窗口内候选被 QUEUE_MAX 截断的真实原因=队列已满，非「超过恢复窗口」——先单独结清
    // queue-full + 准确文案，防止流进下方空账分支吃误标归因（00:24 seed 实测 27 进 20 截 7）。
    const capacityRejected = queueCandidates.filter((e) => !restorable.has(e.msgId))
    if (capacityRejected.length > 0) {
      const byUser = new Map<string, InflightEntry[]>()
      for (const e of capacityRejected) {
        const list = byUser.get(e.userId) ?? []
        list.push(e)
        byUser.set(e.userId, list)
      }
      for (const [uid, list] of byUser) {
        const first = list[0]!
        const preview = first.text.length > 50 ? `${first.text.slice(0, 50)}…` : first.text
        await deliver(
          ctxForUser(uid),
          `🔄 重启恢复：${list.length} 条排队消息因队列已满（上限 ${QUEUE_MAX} 条）未恢复（如「${preview}」）。等队列消化后再发，或 /queue clear 后重发`,
        )
      }
      for (const e of capacityRejected) {
        inflight.settle(e.msgId, undefined, "queue-full")
        console.log(`[bridge] 启动对账：容量拒收结清 queue-full msgId=${e.msgId}`)
      }
    }

    for (const entry of pending) {
      if (restorable.has(entry.msgId)) continue
      const ageMs = Date.now() - entry.at
      if (ageMs > INFLIGHT_MAX_AGE_MS) {
        inflight.settle(entry.msgId, undefined, "expired") // 超 24h：清账不追溯
        continue
      }
      // 恢复投递走主动通道（原 msgId 的被动窗口早已过期）
      const ctx: MessageContext = { type: "c2c", userId: entry.userId, msgId: "", content: entry.text }
      // 修复③（2026-11-03）：排队空账治本——sessionId 为空=「从未进过会话」。
      // 2026-11-05：窗口内的已在上方恢复进队列；走到这里的只剩超窗空账，只清账通知。
      if (!entry.sessionId) {
        inflight.settle(entry.msgId, undefined, "expired")
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
          inflight.settle(entry.msgId, undefined, "answered")
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
          // DEF-20261118-P6：重挂的后台回合同属 QQ 派发来源，promptId 一并入册——
          // 重启后 RESUME 重放的完成事件同样被身份守卫拦下。
          if (entry.promptId) mirror.markQqPrompt(entry.sessionId, entry.promptId)
          // 不单独发“仍在执行”通知；完成时统一回传最终答案，避免通知也占一条回复。
          // 续作次数从台账 resumeCount 续算（重启不洗白 owner「单任务续作≤3次」裁定）。
          startBackgroundWait(
            entry.sessionId,
            ctx,
            entry.at,
            entry.msgId,
            entry.promptId ?? "",
            entry.at,
            sessions.getSession(entry.userId)?.directory,
            entry.resumeCount ?? 0,
          )
          console.log(`[bridge] 启动对账：在途任务已重挂后台等待 msgId=${entry.msgId}`)
        } else if (ageMs <= redispatchMaxAgeMs()) {
          inflight.settle(entry.msgId, undefined, "redispatch") // 旧账结清，重派回合走新账（合成 trackId）
          await deliver(ctx, `🔄 重启恢复：重新处理你之前的消息「${entry.text.length > 50 ? `${entry.text.slice(0, 50)}…` : entry.text}」`)
          void handleMessage(ctx)
          console.log(`[bridge] 启动对账：丢失消息已重派 msgId=${entry.msgId}`)
        } else {
          await deliver(ctx, `⚠️ 此前重启期间丢失一条你的消息「${entry.text.length > 50 ? `${entry.text.slice(0, 50)}…` : entry.text}」（超过自动重派窗口未重发），需要的话请重发一次`)
          inflight.settle(entry.msgId, undefined, "expired")
          console.log(`[bridge] 启动对账：超期消息仅通知 msgId=${entry.msgId}`)
        }
      } catch (error) {
        console.error(`[bridge] 启动对账单条失败 msgId=${entry.msgId}:`, error)
      }
    }
  }

  // Q1：队列 drain——取该 (用户,会话) lane 队首重走完整管线。draining 防重入；
  // handleMessage 自身的 finally 会继续 drain 下一条（链式）。
  // 会话隔离（owner 2026-11-14）：drain 只动指定 lane；锚定随 ctx 传递——
  // 排队期间绑定切走也按入队锚定派发（消息跟原会话，不跟漂移的绑定）。
  async function drainQueue(userId: string, sessionId?: string): Promise<void> {
    const lane = laneOf(userId, sessionId)
    // DEF-20261118-P5 可观测性补强（19:02–19:33 实证：lane「卡住」19 分钟零日志，
    // 事后归因只能靠读码——三道守卫静默 return 是排障黑洞）。守卫跳过分级打印：
    // draining=同 lane 排水未结束（正常并发，debug 级）；busy/pending=真阻塞信号。
    if (draining.has(lane)) {
      console.log(`[queue] drain-skip reason=draining user=${userId.slice(0, 8)}… lane=${sessionId ? shortId(sessionId) : "∅"}`)
      return
    }
    if (busyUsers.has(lane)) {
      console.log(`[queue] drain-skip reason=busy user=${userId.slice(0, 8)}… lane=${sessionId ? shortId(sessionId) : "∅"}`)
      return
    }
    // 审批挂起时不出队：此时出队只会被 handleMessage 的 pendingPerm 早退吞掉并结清
    // （消息白排队）。等挂起审批的回合走完 finally 自然会再次 drain。
    // 会话隔离：只有挂起审批属于本 lane 的会话才挡本 lane（其他会话的审批不挡）。
    const pending = perm.getPending(userId)
    if (pending && (!sessionId || pending.request.sessionID === sessionId)) {
      console.log(`[queue] drain-skip reason=pending-perm user=${userId.slice(0, 8)}… lane=${sessionId ? shortId(sessionId) : "∅"} request=${pending.request.id}`)
      return
    }
    const job = msgQueue.shift(lane)
    if (!job) return
    draining.add(lane)
    queueIdOfCtx.set(job.ctx, job.id)
    if (job.sessionId) job.ctx.anchorSessionId = job.ctx.anchorSessionId ?? job.sessionId
    if (job.ctx.msgId) inflight.markStage(job.ctx.msgId, "dispatched", { queueId: job.id })
    const remain = msgQueue.size(lane)
    console.log(`[queue] drain-start user=${userId.slice(0, 8)}… lane=${sessionId ? shortId(sessionId) : "∅"} qid=${job.id} remain=${remain}`)
    try {
      await notifyUser(job.ctx, `开始执行队列 #${job.id}（剩余 ${remain} 条）`)
      drainReentries.add(job.ctx) // 修复⑦：drain 重入跳过受理回执
      await handleMessage(job.ctx)
    } catch (error) {
      console.error("[bridge] 队列执行失败:", error)
    } finally {
      draining.delete(lane)
      console.log(`[queue] drain-done user=${userId.slice(0, 8)}… qid=${job.id} remain=${msgQueue.size(lane)}`)
      if (msgQueue.size(lane) > 0 && !busyUsers.has(lane)) void drainQueue(userId, sessionId)
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
const WATCH_FILE = storageFile("watch.json")

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

const GREETED_FILE = storageFile("greeted.json")

function loadGreetedSet(file: string = GREETED_FILE): Set<string> {
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8")
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

function saveGreetedSet(set: Set<string>, file: string = GREETED_FILE): void {
  try {
    mkdirSync(join(homedir(), ".openqq"), { recursive: true })
    writeFileSync(file, JSON.stringify([...set]))
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
// 来源）不再隐式携带里程碑，避免"没开观察（/status watch on）却在收"的噪声。
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
