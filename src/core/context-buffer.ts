// @input:  （模块级单例缓存）
// @output: recordMessage, resolveQuote, scopeKeyOf, resetContextBuffer（测试用）
// @pos:    core - 消息上下文索引缓存（引用消息解析）
//
// 引用索引与回退思路参考 qqbot-nodejs 的 quote-ref 中间件。
// QQ C2C/群消息的引用经由 message_reference.message_id 透传；QQ 不提供 C2C 历史
// 消息拉取，故引用解析需本地缓存——我方发出的回复也记录（消息 id 取服务端回执
// MessageResponse.id；0.3.20 起同时登记 ext_info.ref_idx），保证"引用 AI 答案"可解析。此处按项目会话域以 Map 实现
// 每域 200 条的进程内缓存；跨重启引用解析为空属可接受降级。上游见 THIRD_PARTY_NOTICES.md。
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

// N 项（2026-10-30，参考竞品 opencode-qq-v2 的引用消息双通道思路）：
// QQ 在 message_type=103 时把被引内容嵌在 msg_elements 里随事件透传（官方未完全
// 文档化结构，做防御性递归提取）；命中即权威来源，不再依赖本缓存（跨重启/引用
// 老消息也能解析）。提取为空时调用方回落 resolveQuote 缓存通道。
export function extractEmbeddedQuote(event: { message_type?: unknown; msg_elements?: unknown } | undefined): string | null {
  if (!event || Number(event.message_type) !== 103 || !event.msg_elements) return null
  const out: string[] = []
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || out.join("\n").length > 4000) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>
      if (typeof obj.content === "string" && obj.content.trim()) out.push(obj.content.trim())
      for (const key of Object.keys(obj)) {
        if (key !== "content") walk(obj[key], depth + 1)
      }
    }
  }
  walk(event.msg_elements, 0)
  const text = out.join("\n").trim()
  return (text.length > 2000 ? `${text.slice(0, 2000)}…` : text) || null // 截断必带省略号；空内容回落缓存通道
}

/** 测试/运维用：清空全部缓存 */
export function resetContextBuffer(): void {
  scopeBuffers.clear()
}
