// @input:  ./inflight-journal（InflightEntry 类型）, ../opencode/client（TurnState 形状）
// @output: decideReap, REAPER_MIN_AGE_MS, REAPER_SILENCE_MS, resolveReaperMs
// @pos:    core - 僵尸收割决策核（DEF-qqbot-20261112-02 修法②，owner 2026-11-14 授权）
//
// 收割对象：busy lane 悬挂态——前台时限（30min 转后台）与 bgWait 自保（进度心跳/
// 停滞提醒/24h giveup）双层都漏过的「lane 持有中、无 bgWait、无完成事件」。
// 三级门全判别实验式，宁漏杀勿误杀（健康长任务消息持续落，永不误触）：
//   ① 年龄门：busy 持续 > minAgeMs（缺省 40min=前台 30min+10min 宽限）；
//      台账 updatedAt 60s 内被碰过 = 有活人照看，跳过
//   ② 引擎探针：turnStateOf 核实（与 bgWait finish 同判据）——回合实已完成 → L1
//      （补投终稿 + answered；完成但无正文 = 被杀回合 → 仍走 L1 但 text 为空，
//      由调用方按 expired 结清）
//   ③ 静默门：回合未完 + 会话最后消息静默 > silenceMs（缺省 30min）→ L2（abort+expired）
// 本模块纯函数：不读盘、不触网、不取时间（now 注入），供单测复算。
import type { InflightEntry } from "./inflight-journal.ts"

/** 收割年龄门缺省：40min（前台 30min 时限 + 10min 宽限）。 */
export const REAPER_MIN_AGE_MS = 40 * 60_000
/** 静默门缺省：30min（真长任务 SSE/消息持续落；安静即可疑）。 */
export const REAPER_SILENCE_MS = 30 * 60_000
/** 账被碰后的「活人照看」观察窗：60s 内有更新 = 有人正在处理，不抢。 */
export const REAPER_FRESH_TOUCH_MS = 60_000

/** 引擎侧回合状态（turnStateOf 返回形状的最小依赖）。 */
export interface ReaperTurnState {
  anchored: boolean
  hasIdle: boolean
  text: string
  textCompleted: boolean
}

export type ReaperAction =
  | { kind: "skip-young" }
  | { kind: "skip-cooldown" }
  | { kind: "skip-fresh-touch" }
  | { kind: "skip-progressing" }
  | { kind: "skip-probe-failed" }
  /** L1：回合实已完成（text 可能为空=被杀回合，调用方按有无正文分 answered/expired） */
  | { kind: "reap-completed"; text: string }
  /** L2：回合未完且静默超时——调用方单会话 abort 后按 expired 结清 */
  | { kind: "reap-stalled" }

export interface ReaperInput {
  /** 该 lane 的台账在途条目 */
  entry: Pick<InflightEntry, "msgId" | "at"> & Partial<Pick<InflightEntry, "attemptId" | "updatedAt" | "promptId">>
  /** 引擎探针结果；null=探针失败（网络/服务不可达）——本轮不动手，下轮再判 */
  turn: ReaperTurnState | null
  /** 该会话最后一条消息时刻（探针顺带计算；无消息=entry.at） */
  lastMsgAt: number
  /** per-lane 冷却截止（上次收割/失败动作后 5min 内不重复动该 lane） */
  cooldownUntil: number
  now: number
  minAgeMs?: number
  silenceMs?: number
}

/** 与 bgWait finish 同口径的「回合实已完成」判据。 */
function turnFinished(turn: ReaperTurnState): boolean {
  return turn.anchored
    ? turn.hasIdle || Boolean(turn.text && turn.textCompleted)
    : // anchored=false 回落命中：不应用 textCompleted 守卫（对齐 DEF-qqbot-20261110-9 注释口径）
      turn.hasIdle || Boolean(turn.text)
}

export function decideReap(input: ReaperInput): ReaperAction {
  const minAgeMs = input.minAgeMs ?? REAPER_MIN_AGE_MS
  const silenceMs = input.silenceMs ?? REAPER_SILENCE_MS
  if (input.now < input.cooldownUntil) return { kind: "skip-cooldown" }
  if (input.now - input.entry.at < minAgeMs) return { kind: "skip-young" }
  // 账刚被碰过 = 有活人照看（人工 settle/阶段推进进行中），收割器不抢
  if (input.entry.updatedAt !== undefined && input.now - input.entry.updatedAt < REAPER_FRESH_TOUCH_MS) {
    return { kind: "skip-fresh-touch" }
  }
  if (!input.turn) return { kind: "skip-probe-failed" }
  if (turnFinished(input.turn)) return { kind: "reap-completed", text: input.turn.text }
  // 回合未完：静默判定（lastMsgAt 至少退回受理时刻，防空会话除零）
  const silentFor = input.now - Math.max(input.lastMsgAt, input.entry.at)
  if (silentFor >= silenceMs) return { kind: "reap-stalled" }
  return { kind: "skip-progressing" }
}

/** env 解析：非法值回退缺省（与 resolveOrphanMs 同风格）。合法域 5min ~ 6h。 */
export function resolveReaperMs(envValue: string | undefined, fallback: number): number {
  const raw = Number(envValue ?? "")
  if (Number.isFinite(raw) && raw >= 300_000 && raw <= 21_600_000) return raw
  return fallback
}
