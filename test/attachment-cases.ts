// 图片附件合成 + MIME 映射用例（原生附件接入 2026-10-14，计划 B5）
import {
  extForImageMime,
  groupOutcomes,
  augmentPromptWithAttachments,
} from "../src/qq/media.ts"
import type { AttachmentOutcome } from "../src/qq/media.ts"

const results: Array<[string, boolean, string?]> = []
function check(name: string, ok: boolean, detail?: string) {
  results.push([name, ok, detail])
}

// --- extForImageMime ---
check("jpeg→jpg", extForImageMime("image/jpeg") === "jpg")
check("png→png", extForImageMime("image/png") === "png")
check("带参数剥离", extForImageMime("image/webp;codec=vp9") === "webp")
check("非图片→null", extForImageMime("audio/amr") === null)
check("空→null", extForImageMime("") === null)

// --- groupOutcomes ---
const ok1: AttachmentOutcome = { path: "C:\\t\\qq-1.png", name: "qq-1.png" }
const g1 = groupOutcomes([ok1, { failed: "HTTP 403" }, { unsupported: "audio/amr" }])
check("分组:1文件", g1.files.length === 1 && g1.files[0].name === "qq-1.png")
check("分组:uri斜杠化", g1.files[0].uri === "file:///C:/t/qq-1.png", g1.files[0].uri)
check(
  "分组:2备注",
  g1.notes.length === 2 && g1.notes[0].includes("403") && g1.notes[1].includes("audio/amr"),
)

// --- augmentPromptWithAttachments ---
// 1. 文字 + 图 → 文字原样保留 + files 透传
const a1 = augmentPromptWithAttachments("看看这个bug", groupOutcomes([ok1]))
check("图文:文字保留", a1.text === "看看这个bug")
check("图文:files透传", a1.files.length === 1 && a1.files[0].uri === "file:///C:/t/qq-1.png")

// 2. 纯图（无文字）→ 占位文字 + files
const a2 = augmentPromptWithAttachments("", groupOutcomes([ok1]))
check("纯图:占位文字", a2.text.includes("QQ 发来了图片"), a2.text)
check("纯图:files在", a2.files.length === 1)

// 3. 图文 + 部分失败 → 文字在前、失败备注附后
const a3 = augmentPromptWithAttachments("发你了", groupOutcomes([{ failed: "timeout" }, ok1]))
check("混合:备注附后", a3.text.startsWith("发你了") && a3.text.includes("下载失败"), a3.text)
check("混合:成功的图仍透传", a3.files.length === 1)

// 4. 纯失败（图没下下来）→ 备注即正文，可见不静默
const a4 = augmentPromptWithAttachments("", groupOutcomes([{ failed: "HTTP 404" }]))
check("纯失败:可见正文", a4.text.includes("无法处理") && a4.text.includes("404"), a4.text)

// 5. 空附件集 → 原样
const a5 = augmentPromptWithAttachments("普通消息", { files: [], notes: [] })
check("无附件:原样", a5.text === "普通消息" && a5.files.length === 0)

const fails = results.filter(([, ok]) => !ok)
for (const [n, ok, d] of results) console.log(`${ok ? "ok  " : "FAIL"} ${n}${d ? " — " + d : ""}`)
console.log(fails.length === 0 ? "attachment-cases: ALL PASS" : `attachment-cases: ${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
