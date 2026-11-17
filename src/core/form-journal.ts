// @input:  fs/path/os, ../opencode/client (FormInfo), ../qq/types (MessageContext)
// @output: FormJournalEntry, FormJournal, createFormJournal, defaultFormJournalPath
// @pos:    core - 表单交互恢复台账（同步落盘、原子替换、跨进程短临界区锁）
//
// 只保存恢复所需数据：表单定义、最小路由 ctx、答案与回显文本。QQ 原事件、附件、
// 引用内容和被动回复 msgId 一律不落盘；恢复后的通知必须使用主动消息语义。
import { storageFile } from "./storage.js"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { dirname } from "path"
import type { FormInfo } from "../opencode/client.js"
import type { MessageContext } from "../qq/types.js"

export type FormLifecycleState = "pending" | "clickReceived" | "submitting" | "replied" | "cancelled" | "expired"

export interface FormJournalEntry {
  form: FormInfo
  ctx: MessageContext
  userId: string
  createdAt: number
  state: FormLifecycleState
  answer?: Record<string, unknown>
  display?: string
  interactionId?: string
  updatedAt: number
}

export interface FormJournal {
  load: () => FormJournalEntry[]
  put: (entry: FormJournalEntry) => void
  remove: (userId: string, formID?: string) => void
  clear: () => void
  readonly path: string
}

interface FormJournalFile {
  version: 1
  entries: FormJournalEntry[]
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000
const sleepArray = new Int32Array(new SharedArrayBuffer(4))
const STATES = new Set<FormLifecycleState>(["pending", "clickReceived", "submitting", "replied", "cancelled", "expired"])

export function defaultFormJournalPath(): string {
  return process.env.QQ_FORM_JOURNAL_FILE || storageFile("forms.json")
}

/** 只保留恢复路由；空 msgId 明确表达重启后使用主动消息，而非复用过期被动窗口。 */
export function minimalFormContext(ctx: MessageContext): MessageContext {
  return {
    type: ctx.type,
    userId: ctx.userId,
    ...(ctx.type === "group" && ctx.groupId ? { groupId: ctx.groupId } : {}),
    msgId: "",
    content: "",
    ...(ctx.timestamp ? { timestamp: ctx.timestamp } : {}),
  }
}

function validForm(value: unknown): value is FormInfo {
  if (!value || typeof value !== "object") return false
  const form = value as Partial<FormInfo>
  return typeof form.id === "string" && typeof form.sessionID === "string" && typeof form.title === "string" && Array.isArray(form.fields)
}

function normalizeEntry(value: unknown): FormJournalEntry | undefined {
  if (!value || typeof value !== "object") return undefined
  const entry = value as Partial<FormJournalEntry>
  if (
    !validForm(entry.form) ||
    !entry.ctx ||
    (entry.ctx.type !== "c2c" && entry.ctx.type !== "group") ||
    typeof entry.userId !== "string" ||
    !entry.userId ||
    typeof entry.createdAt !== "number" ||
    !Number.isFinite(entry.createdAt) ||
    typeof entry.updatedAt !== "number" ||
    !Number.isFinite(entry.updatedAt) ||
    !entry.state ||
    !STATES.has(entry.state)
  ) {
    return undefined
  }
  return {
    form: entry.form,
    ctx: minimalFormContext({ ...entry.ctx, userId: entry.userId }),
    userId: entry.userId,
    createdAt: entry.createdAt,
    state: entry.state,
    ...(entry.answer && typeof entry.answer === "object" && !Array.isArray(entry.answer) ? { answer: entry.answer } : {}),
    ...(typeof entry.display === "string" ? { display: entry.display } : {}),
    ...(typeof entry.interactionId === "string" ? { interactionId: entry.interactionId } : {}),
    updatedAt: entry.updatedAt,
  }
}

function snapshot(entry: FormJournalEntry): FormJournalEntry {
  return {
    form: entry.form,
    ctx: minimalFormContext(entry.ctx),
    userId: entry.userId,
    createdAt: entry.createdAt,
    state: entry.state,
    ...(entry.answer ? { answer: entry.answer } : {}),
    ...(entry.display !== undefined ? { display: entry.display } : {}),
    ...(entry.interactionId ? { interactionId: entry.interactionId } : {}),
    updatedAt: entry.updatedAt,
  }
}

export function createFormJournal(path: string = defaultFormJournalPath()): FormJournal {
  function read(): FormJournalEntry[] {
    try {
      if (!existsSync(path)) return []
      const raw = JSON.parse(readFileSync(path, "utf-8")) as FormJournalFile | FormJournalEntry[]
      // 接受早期数组原型，写入时统一升级为带 version 的对象格式。
      const values = Array.isArray(raw) ? raw : raw?.version === 1 && Array.isArray(raw.entries) ? raw.entries : []
      const byUser = new Map<string, FormJournalEntry>()
      for (const value of values) {
        const entry = normalizeEntry(value)
        if (!entry) continue
        const previous = byUser.get(entry.userId)
        if (!previous || previous.updatedAt <= entry.updatedAt) byUser.set(entry.userId, entry)
      }
      return [...byUser.values()].sort((a, b) => a.createdAt - b.createdAt)
    } catch (error) {
      // 损坏文件不阻塞 bot 启动；调用方仍可按服务端 reconcile 重建本地槽。
      console.warn("[form-journal] 台账读取失败，按空台账处理:", error instanceof Error ? error.message : error)
      return []
    }
  }

  function write(entries: FormJournalEntry[]): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    const payload: FormJournalFile = { version: 1, entries: entries.map(snapshot) }
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
      renameSync(tmp, path)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* 已 rename 或清理失败 */ }
      throw error
    }
  }

  function withLock<T>(fn: () => T): T {
    mkdirSync(dirname(path), { recursive: true })
    const lockPath = `${path}.lock`
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx", 0o600)
        try { writeFileSync(fd, token) } finally { closeSync(fd) }
        break
      } catch (error) {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath)
        } catch { /* 锁不存在或另一进程正在接管 */ }
        if (Date.now() >= deadline) {
          throw new Error(`表单台账锁等待超时: ${error instanceof Error ? error.message : error}`)
        }
        Atomics.wait(sleepArray, 0, 0, 10)
      }
    }
    try {
      return fn()
    } finally {
      try {
        if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath)
      } catch { /* 已被 stale 清理 */ }
    }
  }

  function mutate(fn: (entries: FormJournalEntry[]) => void): void {
    withLock(() => {
      const entries = read()
      fn(entries)
      write(entries)
    })
  }

  return {
    path,
    load: read,
    put(entry) {
      mutate((entries) => {
        const index = entries.findIndex((item) => item.userId === entry.userId)
        if (index >= 0) entries[index] = snapshot(entry)
        else entries.push(snapshot(entry))
      })
    },
    remove(userId, formID) {
      mutate((entries) => {
        const index = entries.findIndex((item) => item.userId === userId && (!formID || item.form.id === formID))
        if (index >= 0) entries.splice(index, 1)
      })
    },
    clear() {
      withLock(() => write([]))
    },
  }
}
