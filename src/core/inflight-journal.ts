// @input:  fs/path/os（台账落盘）
// @output: recordInflight, settleInflight, pendingInflight, classifyInflight（纯函数供测试）,
//          resetInflightJournal（测试用）, INFLIGHT_MAX_AGE_MS, REDISPATCH_MAX_AGE_MS
// @pos:    core - 在途台账（重启换代丢消息修复：QQ 消息派发落账、答复送达销账、启动对账）
//
// 事故背景（2026-10-30，用户实证）：bot 重启/网关静默死亡窗口内到达的 QQ 消息
// 丢失无反馈——在途回合状态全在内存，进程换代即蒸发。本模块把"派发→送达"责任
// 落盘到 ~/.openqq/inflight.json，启动时对账恢复（bridge.recoverInflightRounds）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface InflightEntry {
  /** 跟踪键：真实 QQ msgId；重派回合为合成键 redispatch-<sessionId>-<ts> */
  msgId: string
  userId: string
  sessionId: string
  /** 用户消息原文（截 300 字，对账匹配与通知展示用） */
  text: string
  at: number
  state: "inflight" | "settled"
}

// 对账年龄上限：超 24h 的在途账不再追溯（直接清账）
export const INFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000
// 丢失消息自动重派窗口：30 分钟内视为"意图仍然新鲜"自动重派；超期只通知请用户重发
export const REDISPATCH_MAX_AGE_MS = 30 * 60 * 1000

// 测试可经 QQ_INFLIGHT_FILE 指向临时文件
function journalPath(): string {
  return process.env.QQ_INFLIGHT_FILE || join(homedir(), ".openqq", "inflight.json")
}

let cache: InflightEntry[] | null = null

function load(): InflightEntry[] {
  if (cache) return cache
  let entries: InflightEntry[] = []
  try {
    if (existsSync(journalPath())) {
      const raw = JSON.parse(readFileSync(journalPath(), "utf-8"))
      if (Array.isArray(raw)) entries = raw
    }
  } catch {
    entries = [] // 损坏即空，不阻塞启动
  }
  // 修剪：已销账超 24h 的不再保留
  cache = entries.filter((e) => e.state === "inflight" || Date.now() - e.at <= INFLIGHT_MAX_AGE_MS)
  return cache
}

function save(): void {
  if (!cache) return
  try {
    const path = journalPath()
    mkdirSync(join(path, ".."), { recursive: true })
    // 原子写：先写临时文件再改名，防写一半被杀留坏账
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2))
    renameSync(tmp, path)
  } catch (error) {
    console.warn("[inflight] 台账落盘失败:", error instanceof Error ? error.message : error)
  }
}

/** 派发落账：QQ 消息进入 AI 派发管线前调用 */
export function recordInflight(entry: Omit<InflightEntry, "state">): void {
  const entries = load()
  entries.push({ ...entry, state: "inflight" })
  save()
}

/** 销账：答复已送达（或已转入有接管的后台等待/已给用户终态反馈） */
export function settleInflight(msgId: string): void {
  const entry = load().find((e) => e.msgId === msgId && e.state === "inflight")
  if (!entry) return
  entry.state = "settled"
  save()
}

/** 待对账清单（启动恢复用） */
export function pendingInflight(): InflightEntry[] {
  return load().filter((e) => e.state === "inflight")
}

/** 测试用：清空台账缓存与文件状态 */
export function resetInflightJournal(): void {
  cache = []
  save()
}

// —— 对账分类（纯函数）——
// 与 opencode/mirror.ts buildDigest 同源的消息形状（最小依赖，避免跨层 import）。
interface HistoryMessage {
  type?: string
  text?: string
  content?: Array<{ type?: string; text?: string }>
}

export type InflightClass =
  | { kind: "answered"; answer: string }
  | { kind: "running" }
  | { kind: "lost" }

/**
 * 对账分类：台账条目 × 会话历史 → 该回合的真实状态。
 * - answered：历史里找到该用户消息且其后已有 assistant 正文 → 答案在库里没投出，补投
 * - running：找到该用户消息但尚无 assistant 正文 → 回合在跑（或被中断），重挂后台等待
 * - lost：历史里找不到该用户消息 → 消息从未到达 opencode（网关窗口丢失），重派/通知
 * 匹配口径：历史 user 文本包含台账原文前 50 字（prompt 会加引用前缀/附件注记，不能全等）。
 */
export function classifyInflight(
  entry: Pick<InflightEntry, "text">,
  messages: HistoryMessage[],
): InflightClass {
  const ordered = [...messages].reverse()
  let lastUserIdx = -1
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].type === "user") {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return { kind: "lost" }

  const userText = (ordered[lastUserIdx].text ?? "").trim()
  const probe = entry.text.trim().slice(0, 50)
  // 纯附件消息（无文字）无法文本匹配——探针为空视为匹配（由 answered 判定兜底）
  const matched = probe === "" || userText.includes(probe)
  if (!matched) return { kind: "lost" }

  const answerParts: string[] = []
  for (let i = lastUserIdx + 1; i < ordered.length; i++) {
    const m = ordered[i]
    if (m.type === "assistant") {
      for (const p of m.content ?? []) {
        if (p.type === "text" && p.text?.trim()) answerParts.push(p.text.trim())
      }
    }
  }
  const answer = answerParts.join("\n").trim()
  return answer ? { kind: "answered", answer } : { kind: "running" }
}
