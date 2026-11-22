// @input:  纯文本（无依赖）
// @output: stripScaffolding
// @pos:    core - 出站脚手架消毒（2026-11-23 学习吸收 Z 项，源=openclaw outbound/sanitize.ts P0）
//
// 背景：模型偶发把内部推理/脚手架块写进正文（ thinking/system-reminder 等），
// QQ 会把原始标签渲染给用户。出站前统一剥离——主路径（formatForQQMarkdown）与
// 纯文本兜底（formatForQQ）同口径，围栏代码块内容不动（调用方在围栏外逐段应用
// 或由 sender 在剥标签后再做围栏保护，顺序：消毒 → 围栏保护/转义）。

/** 内部脚手架块：成对块先剥（含跨行），再剥残留开/闭标签；
 *  deepseek 反引号形态 `think`…`/think` 与 claude 尖括号形态都收。 */
const BLOCK_PATTERNS: RegExp[] = [
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<previous_response\b[^>]*>[\s\S]*?<\/previous_response>/gi,
  /`think`[\s\S]*?`\/think`/gi,
  /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi,
  // 残留裸标签（不成对的开/闭）
  /<\s*\/?\s*(?:system-reminder|previous_response)\b[^>]*\/?\s*>/gi,
  /<\s*\/?\s*think(?:ing)?\b[^>]*\/?\s*>/gi,
]

/** 剥离内部运行时脚手架块（幂等；连续空行收敛为一行）。 */
export function stripScaffolding(text: string): string {
  let result = text
  for (const re of BLOCK_PATTERNS) {
    result = result.replace(re, "")
  }
  return result.replace(/\n{3,}/g, "\n\n")
}
