// @input:  fs/path/crypto（角色级摘要锚点持久化）
// @output: createMirrorAnchorStore、pruneMirrorAnchorEntries、MirrorAnchorEntry
// @pos:    core - QQ 发送回执 ref_idx → (用户,会话) 的有界持久化索引
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

export const MIRROR_ANCHOR_TTL_MS = 24 * 60 * 60 * 1000
export const MIRROR_ANCHOR_MAX_PER_USER = 500

export interface MirrorAnchorEntry {
  /** 发送响应 ext_info.ref_idx；入站 ref_msg_idx 的 lookup 主键 */
  refIdx: string
  /** 发送响应 id；仅诊断/撤回关联，不参与引用 lookup */
  messageId: string
  userId: string
  sessionId: string
  title: string
  sentAt: number
}

export interface MirrorAnchorStore {
  readonly filePath: string
  record: (entry: MirrorAnchorEntry) => void
  resolve: (userId: string, refIdx: string | undefined, now?: number) => MirrorAnchorEntry | undefined
  list: () => MirrorAnchorEntry[]
}

interface AnchorDocument {
  version: 1
  entries: MirrorAnchorEntry[]
}

function validEntry(value: unknown): value is MirrorAnchorEntry {
  const entry = value as Partial<MirrorAnchorEntry> | null
  return !!entry &&
    typeof entry.refIdx === "string" && !!entry.refIdx &&
    typeof entry.messageId === "string" && !!entry.messageId &&
    typeof entry.userId === "string" && !!entry.userId &&
    typeof entry.sessionId === "string" && !!entry.sessionId &&
    typeof entry.title === "string" &&
    typeof entry.sentAt === "number" && Number.isFinite(entry.sentAt) && entry.sentAt > 0
}

/** TTL + 每用户 LRU；返回按 sentAt 升序排列，便于稳定落盘与测试。 */
export function pruneMirrorAnchorEntries(
  input: readonly MirrorAnchorEntry[],
  now = Date.now(),
): MirrorAnchorEntry[] {
  const fresh = input.filter((entry) =>
    validEntry(entry) && entry.sentAt <= now && now - entry.sentAt < MIRROR_ANCHOR_TTL_MS,
  )
  const newestFirst = [...fresh].sort((a, b) => b.sentAt - a.sentAt)
  const counts = new Map<string, number>()
  const seen = new Set<string>()
  const retained: MirrorAnchorEntry[] = []
  for (const entry of newestFirst) {
    const identity = `${entry.userId}\u0000${entry.refIdx}`
    if (seen.has(identity)) continue
    const count = counts.get(entry.userId) ?? 0
    if (count >= MIRROR_ANCHOR_MAX_PER_USER) continue
    seen.add(identity)
    counts.set(entry.userId, count + 1)
    retained.push(entry)
  }
  return retained.sort((a, b) => a.sentAt - b.sentAt)
}

export function createMirrorAnchorStore(filePath: string): MirrorAnchorStore {
  let entries: MirrorAnchorEntry[] = []

  function save(nextEntries: MirrorAnchorEntry[] = entries): void {
    const document: AnchorDocument = { version: 1, entries: nextEntries }
    mkdirSync(dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 })
      renameSync(temporary, filePath)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* 已 rename 或清理失败 */ }
      throw error
    }
  }

  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as Partial<AnchorDocument>
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("锚点文件格式无效")
      const loaded = parsed.entries.filter(validEntry)
      const pruned = pruneMirrorAnchorEntries(loaded)
      entries = pruned
      if (loaded.length !== parsed.entries.length || pruned.length !== loaded.length) save()
    }
  } catch (error) {
    // 原字节保留在诊断副本；空表意味着旧摘要一律按未知锚点 fail-closed。
    try {
      const backup = `${filePath}.corrupt-${Date.now()}`
      renameSync(filePath, backup)
      console.error(`[mirror-anchor] 锚点文件损坏，已保留诊断副本：${backup}`)
    } catch (backupError) {
      console.error("[mirror-anchor] 损坏文件备份失败:", backupError)
    }
    entries = []
    console.error("[mirror-anchor] 锚点恢复失败，按空表 fail-closed:", error)
  }

  return {
    filePath,
    record(entry): void {
      if (!validEntry(entry)) throw new Error("摘要锚点字段不完整")
      // 同步读改写：单角色事件循环内天然串行；原子 rename 防半截文件。
      const next = pruneMirrorAnchorEntries([
        ...entries.filter((item) => !(item.userId === entry.userId && item.refIdx === entry.refIdx)),
        entry,
      ])
      // 先盘后备内存：落盘失败的锚点绝不可在本进程内侥幸放行。
      save(next)
      entries = next
    },
    resolve(userId, refIdx, now = Date.now()): MirrorAnchorEntry | undefined {
      if (!refIdx) return undefined
      const entry = entries.find((item) => item.userId === userId && item.refIdx === refIdx)
      if (!entry) return undefined
      if (entry.sentAt > now || now - entry.sentAt >= MIRROR_ANCHOR_TTL_MS) {
        const before = entries.length
        entries = pruneMirrorAnchorEntries(entries, now)
        if (entries.length !== before) {
          try { save() } catch (error) { console.error("[mirror-anchor] 过期锚点清理失败:", error) }
        }
        return undefined
      }
      return { ...entry }
    },
    list(): MirrorAnchorEntry[] {
      return entries.map((entry) => ({ ...entry }))
    },
  }
}
