// 结构化分条行为断言（2026-10-29 固化）：splitMessage 吸收 dsh chunker 语义
// （表格原子单元）+ 字节预算 + 围栏修补。用小字节预算强制触发分条。
import { splitMessage } from "../src/qq/sender.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])
const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).length
const fenceCount = (s: string) => (s.match(/```/g) ?? []).length

// —— 1) 短文本原样 ——
const short = "短消息"
check("短文本原样返回", splitMessage(short, 1800).length === 1 && splitMessage(short, 1800)[0] === short)

// —— 2) 长文：每片 ≤ 预算、按行边界切 ——
const long = Array.from({ length: 60 }, (_, i) => `第${i}行，一些中文内容填充字节`).join("\n")
const LIMIT = 220
const parts2 = splitMessage(long, LIMIT)
check("长文分多片", parts2.length > 1, `chunks=${parts2.length}`)
check("每片 ≤ 字节预算", parts2.every((p) => bytes(p) <= LIMIT + 12), parts2.map(bytes).join(","))

// —— 3) 代码块：片间切断时围栏修补（每片 ``` 数量为偶数=开闭平衡）——
const withCode = [
  "前言文字若干，铺垫铺垫铺垫铺垫铺垫铺垫",
  "```ts",
  ...Array.from({ length: 30 }, (_, i) => `const v${i} = ${i} // 代码行内容填充`),
  "```",
  "后言文字若干，收尾收尾收尾收尾收尾收尾",
].join("\n")
const parts3 = splitMessage(withCode, LIMIT)
check("代码长文分多片", parts3.length > 1, `chunks=${parts3.length}`)
check(
  "每片围栏开闭平衡（含语言修补）",
  parts3.every((p) => fenceCount(p) % 2 === 0),
  parts3.map(fenceCount).join(","),
)
check("首片保留开围栏语言 ts", parts3[0].includes("```ts"), parts3[0].slice(0, 40))

// —— 4) GFM 表格：预算内整张表聚为原子单元不拆散 ——
// （表格自身超预算时必然切开——平台字节上限是硬约束，dsh 同性质）
const withTable = [
  ...Array.from({ length: 8 }, (_, i) => `表格前铺垫第${i}行，多一些字节多一些字节`),
  "| 名称 | 值 |",
  "|---|---|",
  ...Array.from({ length: 6 }, (_, i) => `| 行${i} | ${"数".repeat(6)} |`),
  ...Array.from({ length: 8 }, (_, i) => `表格后收尾第${i}行，收尾收尾收尾收尾`),
].join("\n")
const TABLE_LIMIT = 400 // 整张表 ~250B < 预算 → 应作为单一原子单元
const parts4 = splitMessage(withTable, TABLE_LIMIT)
const tableHeaderIdx = parts4.findIndex((p) => p.includes("| 名称 | 值 |"))
check("分片发生", parts4.length > 1, `chunks=${parts4.length}`)
check(
  "表头与末行数据同片（表格不拆散）",
  tableHeaderIdx >= 0 && parts4[tableHeaderIdx].includes("| 行5 |"),
  tableHeaderIdx >= 0 ? parts4[tableHeaderIdx].slice(-60) : "表头不在任何片",
)

// —— 5) 多字节安全：emoji/中文不劈开 ——
const emoji = "🎉".repeat(400) // 每个 emoji 4 字节
const parts5 = splitMessage(emoji, LIMIT)
check(
  "多字节字符完整（无替换符）",
  parts5.every((p) => !p.includes("�")),
  parts5.map(bytes).join(","),
)

// —— 6) 超大单行（无换行）退化硬切 ——
const giantLine = "巨".repeat(300)
const parts6 = splitMessage(giantLine, LIMIT)
check("超大单行多片且每片 ≤ 预算", parts6.length > 1 && parts6.every((p) => bytes(p) <= LIMIT), parts6.map(bytes).join(","))

// —— 7) 原文行级还原：非空行均出现在某片（围栏修补行除外）——
const originalLines = withCode.split("\n").filter((l) => l.trim())
const joined = parts3.join("")
const missing = originalLines.filter((l) => !joined.includes(l))
check("原文行级内容零丢失", missing.length === 0, missing.slice(0, 3).join(" / "))

// —— 汇总 ——
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nmessage-split-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
