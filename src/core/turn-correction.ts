// @input:  纯数据（无依赖）
// @output: buildAmendPrompt/selectAmendEntry/lastUserMessageId/messageTextOf/resolveBusyMode/parseGoalState
// @pos:    core - 回合修正域纯决策（2026-11-23 bridge 拆分切片：原散于 bridge.ts 顶部的
//          纯函数收敛于此，bridge 再导出保测试导入路径兼容——测试纪律「保持导入路径兼容」）
//
// 归属：undo/amend/steer 的判定与构造——无副作用、可单测、bridge 闭包函数只做编排。

/** 并入 prompt 构造：原 prompt + 补充指令块，模型读历史接着做。 */
export function buildAmendPrompt(original: string, amendment: string): string {
  return `${original}\n\n【补充指令】${amendment.trim()}`
}

/** 并入目标选择：本用户该会话最新一条已落 promptId 且有原文的在途回合。 */
export function selectAmendEntry(
  entries: Array<Pick<import("./inflight-journal.js").InflightEntry, "userId" | "sessionId" | "promptId" | "text" | "at" | "msgId" | "attemptId">>,
  userId: string,
  sessionId: string,
): (typeof entries)[number] | undefined {
  return entries
    .filter((e) => e.userId === userId && e.sessionId === sessionId && e.promptId && e.text)
    .sort((a, b) => b.at - a.at)[0]
}

/** 取会话消息列表中最后一条 user 消息的 id（回滚边界）。 */
export function lastUserMessageId(msgs: Array<{ id?: string; type?: string }>): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === "user" && msgs[i].id) return msgs[i].id as string
  }
  return null
}

/** 从消息体提取可读文本（user 消息 content 可能为字符串或 text 块数组）。 */
export function messageTextOf(m: { content?: unknown }): string {
  const c = m.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text?: unknown }).text ?? "") : "")).join("")
  }
  return ""
}

/** 忙时投递默认：owner 2026-11-23 裁定对齐官方（忙时 Enter steers）——steer 缺省；显式 queue 切回。 */
export function resolveBusyMode(envValue: string | undefined): "steer" | "queue" {
  return envValue?.trim().toLowerCase() === "queue" ? "queue" : "steer"
}

/** goal 状态报文解析（纯函数）：引擎把 goal 状态走 500 CommandExecutionError 通道返回，
 *  body 为 { _tag, command:"goal", message }——提取 message 供状态呈现与状态机通知。 */
export function parseGoalState(
  raw: string,
): { state: "active" | "paused" | "done" | "unknown"; message: string } | null {
  const text = raw.trim()
  const jsonText = text.startsWith("{") ? text : ""
  if (!jsonText) return null
  try {
    const j = JSON.parse(jsonText) as { message?: string }
    const msg = j.message ?? ""
    if (!msg) return null
    const head = msg.slice(0, 60)
    const state = /goal active|^\s*active/i.test(head) ? "active"
      : /paused/i.test(head) ? "paused"
      : /\bdone\b|complete/i.test(head) ? "done"
      : "unknown"
    return { state, message: msg }
  } catch {
    return null
  }
}
