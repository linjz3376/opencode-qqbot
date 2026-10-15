// @input:  (纯文本工具，无依赖)
// @output: truncate
// @pos:    根层/core - 共用小工具（审批菜单与里程碑格式共用，O7 拆分自 bridge.ts）

export function truncate(value: string, max: number): string {
  const s = value.replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
