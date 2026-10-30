// 缺口 4 行为断言（2026-10-30）：bot→QQ 发图/文件（sendLocalFile 白名单/类型/标记提取）。
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join, resolve } from "path"
import {
  isAllowedSendPath,
  fileTypeForPath,
  extractSendFileMarkers,
  sendLocalFile,
  allowedSendRoots,
} from "../src/core/send-media.ts"
import type { MessageContext } from "../src/qq/types.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const cwd = process.cwd()
const TMP = join(cwd, ".tmp-send-media-test")
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// —— 1) 路径白名单 ——
check("工作目录内文件放行", isAllowedSendPath(join(TMP, "a.png"), [cwd]))
check("工作目录外拒绝", !isAllowedSendPath("C:\\Windows\\System32\\drivers\\etc\\hosts", [cwd]))
check("带引号路径放行", isAllowedSendPath(`"${join(TMP, "a.png")}"`, [cwd]))
check("越级 ../../ 拒绝", !isAllowedSendPath(join(TMP, "..", "..", "Windows", "win.ini"), [cwd]))
check("根目录本身放行", isAllowedSendPath(cwd, [cwd]))
check("额外根扩展放行", isAllowedSendPath(join(TMP, "a.png"), [cwd, TMP]) && true)
// cwd 也在白名单（默认）
check("默认根含 cwd", allowedSendRoots().some((r) => r === resolveCwd()))

function resolveCwd(): string { return resolve(process.cwd()) }

// —— 2) 扩展名 → 媒体类型 ——
check("png→图片(1)", fileTypeForPath("a.png") === 1)
check("mp4→视频(2)", fileTypeForPath("a.mp4") === 2)
check("mp3→语音(3)", fileTypeForPath("a.mp3") === 3)
check("pdf→文件(4)", fileTypeForPath("a.pdf") === 4)
check("无扩展名→文件(4)", fileTypeForPath("README") === 4)

// —— 3) 标记提取 ——
const withMarker = extractSendFileMarkers(`结果在这里\nQQ_SEND_FILE: ${join(TMP, "a.png")}\n其他说明`)
check("标记行被剥离", !withMarker.text.includes("QQ_SEND_FILE"), withMarker.text)
check("剩余文本保留", withMarker.text.includes("结果在这里") && withMarker.text.includes("其他说明"), withMarker.text)
check("路径提取正确", withMarker.paths.length === 1 && withMarker.paths[0].endsWith("a.png"), withMarker.paths.join("|"))
const noMarker = extractSendFileMarkers("纯文本没有任何标记")
check("无标记原样", noMarker.paths.length === 0 && noMarker.text === "纯文本没有任何标记")
const quoted = extractSendFileMarkers(`QQ_SEND_FILE: "${join(TMP, "b.pdf")}"`)
check("带引号路径去引号", quoted.paths.length === 1 && !quoted.paths[0].includes('"'))
const multi = extractSendFileMarkers(`A\nQQ_SEND_FILE: x.png\nB\nQQ_SEND_FILE: y.png\nC`)
check("多标记全部提取且顺序保持", multi.paths.length === 2 && multi.paths[0] === "x.png" && multi.paths[1] === "y.png")

// —— 4) sendLocalFile 白名单与安全边界（不真发网） ——
const realFile = join(TMP, "real.txt")
writeFileSync(realFile, "测试内容")
const fakeCtx: MessageContext = { type: "c2c", userId: "u1", msgId: "m1", content: "" }
const sendLocalFileSafe = sendLocalFile as (c: MessageContext, p: string, d: { getToken: () => Promise<string> }) => Promise<string>

let err1 = ""
try { await sendLocalFileSafe(fakeCtx, "C:\\Windows\\win.ini", { getToken: async () => "t" }) } catch (e) { err1 = e instanceof Error ? e.message : String(e) }
check("白名单外文件被拒绝", err1.includes("白名单"), err1)

let err2 = ""
try { await sendLocalFileSafe(fakeCtx, join(TMP, "不存在.txt"), { getToken: async () => "t" }) } catch (e) { err2 = e instanceof Error ? e.message : String(e) }
check("不存在文件被拒绝", err2.includes("不存在"), err2)

const emptyFile = join(TMP, "empty.txt")
writeFileSync(emptyFile, "")
let err3 = ""
try { await sendLocalFileSafe(fakeCtx, emptyFile, { getToken: async () => "t" }) } catch (e) { err3 = e instanceof Error ? e.message : String(e) }
check("空文件被拒绝", err3.includes("空文件"), err3)

rmSync(TMP, { recursive: true, force: true })

// —— 汇总 ——
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nsend-media-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
