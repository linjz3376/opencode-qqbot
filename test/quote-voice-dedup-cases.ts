// 生态观察缺口补齐断言（2026-10-30）：
// 缺口 1 引用上下文（context-buffer）+ 缺口 2 语音转写（asr_refer_text）+ 缺口 3 消息去重（markSeenAndFilter）。
import { recordMessage, resolveQuote, scopeKeyOf, resetContextBuffer } from "../src/core/context-buffer.ts"
import { groupOutcomes, downloadQQAttachment } from "../src/qq/media.ts"
import { markSeenAndFilter } from "../src/qq/gateway.ts"
import type { MessageContext } from "../src/qq/types.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

// —— 缺口 1：引用上下文缓存 ——
resetContextBuffer()
const c2cScope = scopeKeyOf({ type: "c2c", userId: "u1" })
const groupScope = scopeKeyOf({ type: "group", userId: "u1", groupId: "g1" })
check("域键：C2C 按用户", c2cScope === "c2c:u1")
check("域键：群聊按群", groupScope === "group:g1")

recordMessage(c2cScope, "m1", "第一段回答内容")
check("记录后可解析", resolveQuote(c2cScope, "m1") === "第一段回答内容")
check("无引用 id → null", resolveQuote(c2cScope, "m404") === null)
check("域隔离：群域查不到 C2C 的 m1", resolveQuote(groupScope, "m1") === null)

// LRU 上限
resetContextBuffer()
for (let i = 0; i < 205; i++) recordMessage(c2cScope, `m${i}`, `内容${i}`)
check("LRU 上限：最早被驱逐", resolveQuote(c2cScope, "m0") === null)
check("LRU 上限：最新保留", resolveQuote(c2cScope, "m204") === "内容204")
check("空 msgId 不记录", (() => { recordMessage(c2cScope, "", "x"); return resolveQuote(c2cScope, "") === null })())

// —— 缺口 2：语音转写 ——
const voiceOutcome = await downloadQQAttachment({
  content_type: "audio/silk",
  url: "https://c2cpicdw.qpic.cn/x",
  asr_refer_text: "明天上午开会别迟到",
})
check("语音+ASR → voice 结果（零下载）", "voice" in voiceOutcome && voiceOutcome.voice === "明天上午开会别迟到")

const noAsrVoice = await downloadQQAttachment({
  content_type: "audio/silk",
  url: "https://c2cpicdw.qpic.cn/x",
})
check("语音无 ASR → unsupported", "unsupported" in noAsrVoice)

check("分组：voice → notes（语音转写：…）", (() => {
  const g = groupOutcomes([{ voice: "明天上午开会别迟到" }])
  return g.files.length === 0 && g.notes.length === 1 && g.notes[0].includes("语音转写")
})())
check("分组：混合 voice+图片文件", (() => {
  const g = groupOutcomes([{ voice: "v" }, { path: "C:\\t\\x.png", name: "x.png" }])
  return g.files.length === 1 && g.notes.length === 1
})())

// —— 缺口 3：去重 ——
const seen = new Set<string>()
check("首次通过", markSeenAndFilter(seen, "m1") === true)
check("同 id 重投被滤", markSeenAndFilter(seen, "m1") === false)
check("新 id 通过", markSeenAndFilter(seen, "m2") === true)
check("LRU：500+ 后最早被挤", (() => {
  const s = new Set<string>()
  for (let i = 0; i < 500; i++) markSeenAndFilter(s, `x${i}`)
  markSeenAndFilter(s, "x500")
  return markSeenAndFilter(s, "x0") === true // x0 已被挤出，可再标记
})())

// —— 汇总 ——
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nquote-voice-dedup-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
