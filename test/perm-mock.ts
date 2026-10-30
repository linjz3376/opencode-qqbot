// Phase 1.1 逻辑级 E2E：mock fetch 验证 promptAndWait 审批链路
// 场景: prompt → 第1轮发现待审批 → onPermission 回调 → POST reply → 第2轮 idle → 返回答案
import { createClient } from "../src/opencode/client.ts"

const now = Date.now()
const FAKE_PERM = {
  id: "per_mock_0001",
  sessionID: "ses_mock_0001",
  action: "bash",
  resources: ["echo mock-perm"],
  message: "Run echo mock-perm",
}

const state = {
  permissionChecks: 0,
  replied: null as null | any,
  messagePolls: 0,
  replyIdleAfterDecision: false,
  callbackCalls: 0,
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  const method = init?.method ?? "GET"
  const path = url.replace("http://localhost:49374/api", "")

  const respond = (status: number, body: any) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })

  if (method === "POST" && path === "/session") return respond(200, { data: { id: "ses_mock_0001" } })
  if (method === "POST" && path === "/session/ses_mock_0001/prompt")
    return respond(200, { data: { time: { created: now } } })

  if (path === "/permission/request") {
    state.permissionChecks++
    // 前 2 次轮询返回待审批；reply 之后返回空（且验证不会重复推送）
    if (state.replied) return respond(200, { location: { directory: "x" }, data: [] })
    if (state.permissionChecks >= 1) return respond(200, { location: { directory: "x" }, data: [FAKE_PERM] })
    return respond(200, { location: { directory: "x" }, data: [] })
  }

  if (method === "POST" && /^\/session\/ses_mock_0001\/permission\/per_mock_0001\/reply$/.test(path)) {
    state.replied = JSON.parse(init.body)
    return respond(204, undefined)
  }

  if (path === "/session/ses_mock_0001/message") {
    state.messagePolls++
    if (state.replied) {
      // 决策后：出现 idle + 助手答案
      return respond(200, {
        data: [
          { type: "assistant", time: { created: now + 1 }, content: [{ type: "text", text: "命令执行完成：mock-perm" }] },
          { type: "idle", time: { created: now + 2 } },
        ],
      })
    }
    return respond(200, { data: [] }) // 决策前：无 idle（会话阻塞）
  }

  return respond(404, { error: "unmocked: " + method + " " + path })
}) as any

const client = createClient("http://localhost:49374/api")

const t0 = Date.now()
try {
  const reply = await client.promptAndWait("ses_mock_0001", "test", {
    onPermission: async (req) => {
      state.callbackCalls++
      console.log("callback got:", JSON.stringify(req))
      // 校验回调收到的字段完整
      if (req.id !== FAKE_PERM.id || req.sessionID !== FAKE_PERM.sessionID || req.action !== "bash") {
        throw new Error("callback request fields mismatch")
      }
      return "once"
    },
  })
  console.log("PASS final reply:", JSON.stringify(reply), `(${Date.now() - t0}ms)`)
} catch (e) {
  console.log("FAIL:", String(e))
}

const results = {
  callbackCalls: state.callbackCalls,
  replyBody: state.replied,
  permissionChecks: state.permissionChecks,
  messagePolls: state.messagePolls,
}
console.log("results:", JSON.stringify(results, null, 2))

// 断言
const assert = (cond: boolean, msg: string) => { if (!cond) { console.log("ASSERT FAIL:", msg); process.exitCode = 1 } else console.log("assert ok:", msg) }
assert(state.callbackCalls === 1, "onPermission 恰好调用 1 次（无重复推送）")
assert(state.replied?.decision === "once", "POST reply 载荷 {decision:'once'}")
assert(state.replied?.message === undefined, "无多余字段")
assert(state.messagePolls >= 1, "决策后继续轮询至 idle（决策当轮 continue 跳过消息轮询是预期优化）")

// ── 场景 2：D2 冲突确定性版（10-30 深度自测补）——reply 被 404（另一端已受理）→
// onPermissionConflict 触发、onPermissionReplied 不触发、轮次照常收敛（不依赖环境运气）──
const state2 = { settled: false, conflicts: 0, repliedCb: 0 }
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  const method = init?.method ?? "GET"
  const path = url.replace("http://localhost:49374/api", "")
  const respond = (status: number, body: any) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  if (method === "POST" && path === "/session") return respond(200, { data: { id: "ses_mock_0002" } })
  if (method === "POST" && path === "/session/ses_mock_0002/prompt")
    return respond(200, { data: { time: { created: now } } })
  if (path === "/permission/request") {
    if (state2.settled) return respond(200, { data: [] })
    return respond(200, { data: [{ ...FAKE_PERM, id: "per_mock_0002", sessionID: "ses_mock_0002" }] })
  }
  if (method === "POST" && path.startsWith("/session/ses_mock_0002/permission/")) {
    state2.settled = true
    return respond(404, { error: "already answered" }) // 桌面端抢先受理
  }
  if (path === "/session/ses_mock_0002/message") {
    return respond(200, {
      data: state2.settled
        ? [{ type: "assistant", time: { created: now + 1 }, content: [{ type: "text", text: "done" }] }, { type: "idle", time: { created: now + 2 } }]
        : [],
    })
  }
  return respond(404, { error: "unmocked: " + method + " " + path })
}) as any

const client2 = createClient("http://localhost:49374/api")
try {
  const reply2 = await client2.promptAndWait("ses_mock_0002", "test", {
    onPermission: async () => "once",
    onPermissionConflict: () => { state2.conflicts++ },
    onPermissionReplied: () => { state2.repliedCb++ },
  })
  assert(reply2 === "done", "D2 冲突后轮次照常收敛")
} catch (e) {
  console.log("FAIL D2:", String(e)); process.exitCode = 1
}
assert(state2.conflicts === 1, "D2：404 → onPermissionConflict 恰触发 1 次")
assert(state2.repliedCb === 0, "D2：onPermissionReplied 未触发（不误报'已允许'）")

globalThis.fetch = realFetch
