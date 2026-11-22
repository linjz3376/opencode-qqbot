// @input:  无依赖（纯文本工具）
// @output: cmdInput/cmdEnter 标签构造、stripInteractionTags 兜底剥离、NOTICE 文案目录
// @pos:    core - 通知文案目录（2026-11-22 学习吸收轮：融合 dsh-qqbot errors.ts/session-notice.ts
//          目录制之长——用户可见文案单一出口、可测；P0 佐证=QQ 官方文档「文本交互」
//          bot.q.qq.com/wiki api-v2，2026-10-26 更新版，<qqbot-cmd-input>/<qqbot-cmd-enter> 形状确认）
//
// ⚠️ 平台边界（官方文档原文）：
// - 指令标签仅在 **markdown 消息** 内生效；纯文本兜底通道会把标签当字面文本显示
//   （尖括号泄漏）—— sender.ts formatForQQ 必须走 stripInteractionTags 兜底（AstrBot#8755 同款坑）。
// - text/show 均 ≤100 字符且须 urlencode；cmd-enter「群聊和文字子频道不支持该能力」，
//   故 recover 类提示统一用 cmd-input（插入输入框，用户确认后发送），不替用户自动发指令。

/** 参数指令标签：<qqbot-cmd-input>（P0 文本交互，点击=把 text 插入输入框）。 */
export function cmdInput(text: string, show?: string, reference = false): string {
  const enc = (s: string): string => encodeURIComponent(s)
  const attrs = [`text="${enc(text)}"`]
  if (show !== undefined) attrs.push(`show="${enc(show)}"`)
  if (reference) attrs.push('reference="true"')
  return `<qqbot-cmd-input ${attrs.join(" ")} />`
}

/** 回车指令标签：<qqbot-cmd-enter>（点击直接发送；官方文档注明群聊/文字子频道不支持——慎用）。 */
export function cmdEnter(text: string, show?: string): string {
  const enc = (s: string): string => encodeURIComponent(s)
  const attrs = [`text="${enc(text)}"`]
  if (show !== undefined) attrs.push(`show="${enc(show)}"`)
  return `<qqbot-cmd-enter ${attrs.join(" ")} />`
}

// 纯文本兜底剥离：把交互标签降级为可读文本（show 优先，其次 text），防尖括号泄漏。
const INTERACTION_TAG = /<qqbot-(cmd-input|cmd-enter)\b[^>]*\/?>/g

function tagFallback(tag: string): string {
  const show = /show="([^"]*)"/.exec(tag)?.[1]
  const text = /text="([^"]*)"/.exec(tag)?.[1]
  const pick = show ?? text
  if (!pick) return ""
  try {
    return decodeURIComponent(pick)
  } catch {
    return pick
  }
}

/** 剥离 markdown 专属交互标签（供纯文本兜底通道调用）。 */
export function stripInteractionTags(text: string): string {
  return text.replace(INTERACTION_TAG, (m: string) => tagFallback(m))
}

/**
 * 用户可见文案目录（单一出口，改文案只动这里）。
 * 每条说得出：出现场景 / 恢复路径 / 为什么用 cmd-input 而非常量文字。
 */
export const NOTICE = {
  /**
   * 僵尸收割 expired（bridge.ts reaper）：卡死回合被清理后的可见交代。
   * 恢复路径给可点指令（官方文本交互），用户不用手打 /new。
   */
  reaperExpired: (): string =>
    "⚠️ 检测到一个卡死的回合（长时间无进展），已自动清理；结果可点下面的指令开新会话重试：\n" +
    cmdInput("/new", "🆕 新会话"),
}
