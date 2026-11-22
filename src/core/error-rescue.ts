// @input:  （错误消息文本）
// @output: classifyProviderError, rescueText
// @pos:    core - 模型侧错误救援话术（Q3 学习 pi-qqbot billing.ts：把沉默失败变可操作失败）
//
// 402（余额不足）/401（key 失效）/quota 类错误时，不给"处理失败：xxx"的死胡同文案，
// 而是报出类别 + 原文摘要 + 可立即执行的恢复路径（换模型 / 桌面更新 key）。
// 安全边界：不提供"把 key 发给 bot"的通道（模型 key 归 opencode 侧管理，bot 不经手）。

export type ProviderErrorKind = "billing" | "auth" | null

/** 分类：余额/额度 → billing；鉴权/key → auth；其余 → null（走普通错误路径） */
export function classifyProviderError(message: string): ProviderErrorKind {
  const m = message.toLowerCase()
  if (/\b402\b|insufficient|balance|余额|额度不足|quota exceeded|credit/i.test(m)) return "billing"
  if (/\b401\b|unauthorized|invalid.{0,20}(key|token)|鉴权|密钥错误|api.?key/i.test(m)) return "auth"
  return null
}

/** 救援话术；kind 为 null 时返回 null（调用方走普通错误文案） */
export function rescueText(kind: ProviderErrorKind, rawMessage: string): string | null {
  if (!kind) return null
  const clipped = rawMessage.replace(/\s+/g, " ").trim()
  const raw = clipped.length > 200 ? `${clipped.slice(0, 200)}…` : clipped // 截断必带省略号
  const head = kind === "billing" ? "❌ 当前模型的余额/额度不足，暂时无法继续对话" : "❌ 当前模型的鉴权信息失效（401/key 无效）"
  return [
    head,
    `服务端原文：${raw}`,
    "",
    "恢复方式（都不用等模型在线）——",
    "1. 换现成模型：发 /models 看列表，或 /models provider/id 直接切换",
    "2. 更新 key：在桌面端 opencode 里更新该服务的 key 后，直接重发你的问题",
  ].join("\n")
}
