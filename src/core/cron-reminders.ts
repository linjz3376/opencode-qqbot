// @input:  纯文本（无依赖）+ setTimeout（调度器）
// @output: parseCronReminder / ReminderScheduler
// @pos:    core - 定时提醒（2026-11-23 学习吸收 Y-1，源=openclaw outbound/cron-scheduler.ts P0）
//
// 触发形态（AI 在正文内嵌标记，与 openclaw 同款）：
//   QQBOT_PAYLOAD: {"type":"cron_reminder","at":"in 30m","text":"去开评审会"}
// at 支持：ISO 8601 / Unix ms（>1e12）/ "in Nm/Nh/Nd"；过去时刻拒收。
// 标记从用户可见正文剥离（不留脚手架痕迹）；剥完为空则以确认句回执。
// 单次提醒（setTimeout，进程内存态）——重启即失，与 openclaw 同口径；
// 每用户同时在册上限防标记轰炸。

/** 解析 cron 标记（纯函数供测试）。命中并合法 → 绝对时刻/提醒文本/剥净正文；否则 null。 */
export function parseCronReminder(
  text: string,
  now: number,
): { atMs: number; reminderText: string; cleanedText: string } | null {
  const m = /QQBOT_PAYLOAD:\s*(\{[\s\S]*?\})/.exec(text)
  if (!m) return null
  let payload: { type?: unknown; at?: unknown; text?: unknown }
  try {
    payload = JSON.parse(m[1]) as typeof payload
  } catch {
    return null
  }
  if (payload?.type !== "cron_reminder") return null
  const reminderText = typeof payload.text === "string" ? payload.text.trim().slice(0, 200) : ""
  if (!reminderText) return null
  const atMs = resolveAt(payload.at, now)
  if (atMs === null || atMs <= now + 5_000) return null
  // 剥净：含标记的整行移除，残余空行收敛
  const cleanedText = text
    .split("\n")
    .filter((line) => !line.includes("QQBOT_PAYLOAD:"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return { atMs, reminderText, cleanedText }
}

/** at 字段解析（纯函数）：ISO / Unix ms / "in Nm|Nh|Nd"。 */
export function resolveAt(at: unknown, now: number): number | null {
  if (typeof at === "number" && Number.isFinite(at)) {
    return at > 1e12 ? at : null // 小于 1e12 按秒记的可能性不存在于本域，拒收防误用
  }
  if (typeof at !== "string") return null
  const rel = /^in\s+(\d+)\s*([mhd])$/i.exec(at.trim())
  if (rel) {
    const n = Number(rel[1])
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2].toLowerCase()] ?? 0
    return now + n * unit
  }
  const t = Date.parse(at)
  return Number.isNaN(t) ? null : t
}

/** 进程内单次提醒调度：每用户同时在册上限（防标记轰炸），到点投递并出册。 */
export class ReminderScheduler {
  private readonly pending = new Map<string, Set<ReturnType<typeof setTimeout>>>()
  constructor(private readonly maxPerUser = 10) {}

  /** 注册。返回 false=被拒（超上限/参数非法），调用方如实回执。 */
  schedule(userId: string, atMs: number, text: string, deliver: (userId: string, text: string) => void): boolean {
    if (!userId || !text.trim() || atMs <= Date.now()) return false
    const set = this.pending.get(userId) ?? new Set()
    if (set.size >= this.maxPerUser) return false
    const timer = setTimeout(() => {
      set.delete(timer)
      console.log(`[cron] 提醒到点 user=${userId.slice(0, 8)}… text=${text.slice(0, 30)}`)
      try {
        deliver(userId, `⏰ 提醒：${text}`)
      } catch (error) {
        console.error("[cron] 提醒投递失败:", error)
      }
    }, atMs - Date.now())
    set.add(timer)
    this.pending.set(userId, set)
    return true
  }

  /** 在册数（测试断言用）。 */
  size(userId: string): number {
    return this.pending.get(userId)?.size ?? 0
  }
}
