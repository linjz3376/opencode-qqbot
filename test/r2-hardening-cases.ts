// R2 修复批次用例（2026-10-14）：fail-closed 准入 / 下载域白名单 / watch 持久化往返
import { isAllowedUser, loadWatchedMap, saveWatchedMap } from "../src/bridge.ts"
import { isAllowedDownloadHost } from "../src/qq/media.ts"
import { unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const results: Array<[string, boolean, string?]> = []
function check(name: string, ok: boolean, detail?: string) {
  results.push([name, ok, detail])
}

// --- R2-P1-1 fail-closed ---
check("空名单→陌生人拒绝", isAllowedUser("anyone", []) === false)
check("空名单→真用户也拒绝（回归：旧代码此处放行）", isAllowedUser("284280781E67C0DE56028F147203FA83", []) === false)
check("名单内→放行", isAllowedUser("U1", ["U1", "U2"]) === true)
check("名单外→拒绝", isAllowedUser("U3", ["U1", "U2"]) === false)

// --- R2-P1-2 下载域白名单 ---
check("qpic 主域", isAllowedDownloadHost("https://multimedia.qpic.cn/a/b?sig=x") === true)
check("qpic 子域", isAllowedDownloadHost("https://x.y.qpic.cn/a") === true)
check("qq.com 域", isAllowedDownloadHost("https://cdn.qq.com/a") === true)
check("qq.com.cn 域（C2C 图片实测 CDN，2026-10-30 用户实报 multimedia.nt.qq.com.cn）", isAllowedDownloadHost("https://multimedia.nt.qq.com.cn/a.jpg") === true)
check("外域拒绝", isAllowedDownloadHost("https://evil.com/a") === false)
check("后缀伪造拒绝", isAllowedDownloadHost("https://qq.com.evil.com/a") === false)
check("非 https 拒绝", isAllowedDownloadHost("http://multimedia.qpic.cn/a") === false)
check("非法 URL 拒绝", isAllowedDownloadHost("not a url") === false)

// --- R2-P1-3 watch 持久化往返 ---
const tmp = join(tmpdir(), `watch-test-${Date.now()}.json`)
saveWatchedMap(new Map([["u1", "ses_a"], ["u2", "ses_b"]]), tmp)
const loaded = loadWatchedMap(tmp)
check("往返 u1", loaded.u1 === "ses_a")
check("往返 u2", loaded.u2 === "ses_b")
writeFileSync(tmp, "{{{ 坏文件")
check("损坏→空对象", Object.keys(loadWatchedMap(tmp)).length === 0)
try {
  unlinkSync(tmp)
} catch {
  /* 已清 */
}

const fails = results.filter(([, ok]) => !ok)
for (const [n, ok, d] of results) console.log(`${ok ? "ok  " : "FAIL"} ${n}${d ? " — " + d : ""}`)
console.log(fails.length === 0 ? "r2-hardening: ALL PASS" : `r2-hardening: ${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
