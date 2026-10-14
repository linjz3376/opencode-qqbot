// D3 行为断言回归（原 6/6 断言文件缺失重造，2026-10-14 随测试资产入库）
// maskHeaders：Authorization/cookie/token/secret 类头字段打印前掩码，明文零泄露。
import { maskHeaders } from "../src/qq/api.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.leak-canary.abc123"
const COOKIE = "session=leak-canary-cookie"
const X_TOKEN = "x-access-token-leak-canary"
const SECRET_VAL = "f6XzSvPtOtPvSzX6fFpQ1dFsV9oT9pWD"

// 1) Authorization → ***
const o1 = maskHeaders({ Authorization: BEARER })
check("Authorization 掩码", o1.Authorization === "***", `got=${o1.Authorization}`)

// 2) Cookie → ***
const o2 = maskHeaders({ Cookie: COOKIE })
check("Cookie 掩码", o2.Cookie === "***", `got=${o2.Cookie}`)

// 3) 任意 *token* 字段（X-Access-Token / access_token）→ ***
const o3 = maskHeaders({ "X-Access-Token": X_TOKEN, access_token: X_TOKEN })
check("token 字段掩码", o3["X-Access-Token"] === "***" && o3.access_token === "***", JSON.stringify(o3))

// 4) 任意 *secret* 字段（clientSecret / QQ_APP_SECRET）→ ***
const o4 = maskHeaders({ clientSecret: SECRET_VAL, "X-QQ-App-Secret": SECRET_VAL })
check("secret 字段掩码", o4.clientSecret === "***" && o4["X-QQ-App-Secret"] === "***", JSON.stringify(o4))

// 5) 无关字段原样保留（不影响排障可读性）
const o5 = maskHeaders({ "Content-Type": "application/json", "X-Request-Id": "req-42" })
check("无关字段保留", o5["Content-Type"] === "application/json" && o5["X-Request-Id"] === "req-42", JSON.stringify(o5))

// 6) 序列化输出零明文（日志实际打印的就是 JSON.stringify(掩码结果)）
const dump = JSON.stringify(maskHeaders({ Authorization: BEARER, Cookie: COOKIE, "X-Access-Token": X_TOKEN, clientSecret: SECRET_VAL, Host: "api.sgroup.qq.com" }))
const noLeak = ![BEARER, COOKIE, X_TOKEN, SECRET_VAL].some((v) => dump.includes(v))
check("打印内容零明文", noLeak, dump.slice(0, 160))

// 汇总
let fails = 0
for (const [name, ok, detail] of results) {
  if (ok) console.log(`PASS  ${name}`)
  else { fails++; console.log(`FAIL  ${name}  ${detail}`) }
}
console.log(`\nmask-headers-cases: ${results.length - fails}/${results.length} 通过`)
process.exit(fails === 0 ? 0 : 1)
