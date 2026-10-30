// @input:  （模块级单例缓存）
// @output: recordMessage, resolveQuote, scopeKeyOf, resetContextBuffer（测试用）
// @pos:    core - 消息上下文索引缓存（引用消息解析）
//
// 设计吸收自 P0：qqbot-nodejs middleware/quote-ref.ts（MemoryRefIndexStore +
// msgIdx 索引 + 解析）。QQ C2C/群消息的引用经由 message_reference.message_id
// 透传；QQ 不提供 C2C 历史消息拉取，故引用解析只能靠本缓存——我方发出的回复
// 也记录（消息 id 取服务端回执 MessageResponse.id），保证"引用 AI 答案"可解析。
// 单进程 bot 用进程内 LRU（每域 200 条）足够；跨重启引用解析为空属可接受降级。
interface RefEntry {
  text: string
  at: number
}

const MAX_ENTRIES_PER_SCOPE = 200
const scopeBuffers = new Map<string, Map<string, RefEntry>>()

/** 域键：C2C 按用户，群聊按群（引用多在群内发生） */
export function scopeKeyOf(ctx: { type: string; userId: string; groupId?: string }): string {
  return ctx.type === "group" && ctx.groupId ? `group:${ctx.groupId}` : `c2c:${ctx.userId}`
}

function bufferOf(scope: string): Map<string, RefEntry> {
  let b = scopeBuffers.get(scope)
  if (!b) {
    b = new Map()
    scopeBuffers.set(scope, b)
  }
  return b
}

/** 记录一条消息（入站用户消息 + 我方出站回复） */
export function recordMessage(scope: string, msgId: string, text: string): void {
  if (!msgId) return
  const b = bufferOf(scope)
  if (b.size >= MAX_ENTRIES_PER_SCOPE && !b.has(msgId)) {
    const first = b.keys().next().value
    if (first !== undefined) b.delete(first)
  }
  b.set(msgId, { text, at: Date.now() })
}

/** 按引用 id 解析被引消息文本；不存在返回 null */
export function resolveQuote(scope: string, referencedMsgId: string): string | null {
  const entry = scopeBuffers.get(scope)?.get(referencedMsgId)
  return entry?.text ?? null
}

/** 测试/运维用：清空全部缓存 */
export function resetContextBuffer(): void {
  scopeBuffers.clear()
}
