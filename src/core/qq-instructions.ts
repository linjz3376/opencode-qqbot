// @input:  fs/path + ./storage (storageRoot) + ./send-requests (findQQBinding)
// @output: QQ_INSTRUCTION_KEY, QQ_INSTRUCTION_TEXT, listQQBindings, qqInstructionStateFile, syncQQInstructions
// @pos:    core - QQ 会话系统级指令注入（owner 2026-11-24 批准）：治显性注入污染
//
// 病灶：QQ_LIST_FORMAT_HINT/QQ_SEND_FILE_HINT 拼在 user prompt 正文——格式约定以用户消息
// 气泡进入会话历史（桌面端可见），污染阅读且占用 user 语义位。
// 方案（官方 plugins/server 文档取证）：优先 session.instructions.entry（keyed 指令条目，
// key="qq" 即通道标签，<context key="qq"> 块注入系统指令，每回合生效且不入历史）；
// 旧引擎无 entry API 时降级 session.hook("context")（event.system.push 逐发注入）；
// 两者皆无→不写状态文件，bridge 继续 prompt 正文注入（现状兜底）。
// 三态经 ~/.openqq/qq-system-instructions.json 状态文件告知 bridge（见 delivery.qqPromptHints）。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { storageRoot } from "./storage.js"
import { findQQBinding } from "./send-requests.js"

export const QQ_INSTRUCTION_KEY = "qq"

/** 系统层指令正文（与 delivery.ts 两个 HINT 同语义，迁出 user 消息体）。 */
export const QQ_INSTRUCTION_TEXT = [
  "本对话经 QQ 渲染：",
  "- 输出格式：用「1、2、3、」顿号或「-」无序列表代替 markdown 有序列表，避免表格；代码块不受影响可正常使用。",
  "- 发送本机文件/图片给 QQ 用户：优先调用 qq_send_file 工具（若工具清单提供，失败会返回精确原因可据以修正）；无该工具时，在回复末尾独立一行写 `QQ_SEND_FILE: <绝对路径>`（路径须在发送白名单内，默认 QQ 图片缓存目录与 bot 工作目录）。",
].join("\n")

export interface QQBinding {
  userId: string
  sessionId: string
  appId?: string
}

export function qqInstructionStateFile(): string {
  return join(storageRoot(), "qq-system-instructions.json")
}

/** 全量绑定枚举（插件巡检用）：legacy + roles/* 的 sessions.json 全部有效映射。 */
export function listQQBindings(root = storageRoot()): QQBinding[] {
  const candidates: Array<{ file: string; appId?: string }> = [{ file: join(root, "sessions.json") }]
  const rolesDir = join(root, "roles")
  if (existsSync(rolesDir)) {
    for (const role of readdirSync(rolesDir)) candidates.push({ file: join(rolesDir, role, "sessions.json"), appId: role })
  }
  const out: QQBinding[] = []
  for (const { file, appId } of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, { sessionId?: string }>
      for (const [userId, v] of Object.entries(parsed)) {
        if (typeof v?.sessionId === "string" && v.sessionId.startsWith("ses_")) {
          out.push(appId ? { userId, sessionId: v.sessionId, appId } : { userId, sessionId: v.sessionId })
        }
      }
    } catch {
      // 单文件缺失/坏 JSON 不阻断其余角色
    }
  }
  return out
}

interface EntryApi {
  list?: (input: { sessionID: string }) => Promise<Array<{ key?: string; value?: string }>>
  put?: (input: { sessionID: string; key: string; value: string }) => Promise<unknown>
}
interface CtxLike {
  session?: {
    instructions?: { entry?: EntryApi }
    hook?: (name: string, fn: (event: { sessionID?: string; system?: Array<{ type: string; text: string }> }) => void) => Promise<unknown>
  }
}

// hook 模式防重复注册（插件 hourly reload 重跑 setup 是常态，模块级标记跨 ensure 周期）
let hookRegistered = false

/**
 * 同步 QQ 系统指令（插件 ensure 每周期调用，幂等）：
 * entry 模式逐绑定补齐条目；hook 模式注册一次后仅刷新状态文件。
 * 返回模式并落状态文件（bridge 以 15min 新鲜度判定是否停用 prompt 注入）。
 * 任何失败不抛出——宿主引导器永不被阻断。
 */
export async function syncQQInstructions(
  ctx: CtxLike | undefined,
  opts: { bindings?: QQBinding[]; stateFile?: string } = {},
): Promise<"entry" | "hook" | "none"> {
  const bindings = opts.bindings ?? listQQBindings()
  const stateFile = opts.stateFile ?? qqInstructionStateFile()
  const writeState = (mode: "entry" | "hook"): void => {
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ mode, at: Date.now() }), "utf-8")
  }
  try {
    const entry = ctx?.session?.instructions?.entry
    if (entry?.put && entry?.list) {
      for (const b of bindings) {
        const existing = await entry.list({ sessionID: b.sessionId }).catch(() => [])
        const has = (existing ?? []).some((e) => e?.key === QQ_INSTRUCTION_KEY && e?.value === QQ_INSTRUCTION_TEXT)
        if (!has) await entry.put({ sessionID: b.sessionId, key: QQ_INSTRUCTION_KEY, value: QQ_INSTRUCTION_TEXT })
      }
      writeState("entry")
      return "entry"
    }
    if (typeof ctx?.session?.hook === "function") {
      if (!hookRegistered) {
        const cache = new Map<string, { bound: boolean; at: number }>()
        await ctx.session.hook("context", (event) => {
          const sid = event?.sessionID
          if (!sid || !event?.system) return
          let hit = cache.get(sid)
          if (!hit || Date.now() - hit.at > 60_000) {
            hit = { bound: Boolean(findQQBinding(sid)), at: Date.now() }
            cache.set(sid, hit)
          }
          if (hit.bound) event.system.push({ type: "text", text: QQ_INSTRUCTION_TEXT })
        })
        hookRegistered = true
      }
      writeState("hook")
      return "hook"
    }
  } catch {
    // 同步失败不落状态——bridge 继续 prompt 注入兜底
  }
  return "none"
}
