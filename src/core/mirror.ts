// @input:  ../opencode/{client, eventstream, mirror, sessions}, ../qq/types, ../commands, fs/path/os
// @output: createMirror
// @pos:    根层/core - 摘要镜像域（O7d 2026-10-15 自 bridge.ts 拆出：会话订阅、
//          QQ 回合标记与延迟解锁、回合完成摘要投递、开关持久化）
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { MessageContext } from "../qq/types.js"
import type { OpencodeClient } from "../opencode/client.js"
import { createEventStream } from "../opencode/eventstream.js"
import { buildDigest } from "../opencode/mirror.js"
import type { SessionManager } from "../opencode/sessions.js"
import type { MirrorApi } from "../commands.js"

type EventStream = ReturnType<typeof createEventStream>

// 摘要镜像开关（~/.openqq/settings.json 持久；BOM 防御与 greeted 一致）
const MIRROR_SETTINGS_FILE = join(homedir(), ".openqq", "settings.json")

function loadMirrorEnabled(): boolean {
  try {
    if (existsSync(MIRROR_SETTINGS_FILE)) {
      const raw = readFileSync(MIRROR_SETTINGS_FILE, "utf-8").replace(/^\uFEFF/, "")
      const parsed = JSON.parse(raw)
      if (typeof parsed?.mirror === "boolean") return parsed.mirror
    }
  } catch {
    // fall through to default
  }
  return true // 默认开（用户点单 A 摘要镜像）
}

function saveMirrorEnabled(enabled: boolean): void {
  try {
    mkdirSync(join(homedir(), ".openqq"), { recursive: true })
    let existing: Record<string, unknown> = {}
    if (existsSync(MIRROR_SETTINGS_FILE)) {
      try {
        const raw = readFileSync(MIRROR_SETTINGS_FILE, "utf-8").replace(/^\uFEFF/, "")
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === "object") existing = parsed
      } catch {
        // 损坏则重建
      }
    }
    existing.mirror = enabled
    writeFileSync(MIRROR_SETTINGS_FILE, JSON.stringify(existing, null, 2), "utf-8")
  } catch (error) {
    console.error("[mirror] 保存设置失败:", error)
  }
}

export interface MirrorDeps {
  sessions: SessionManager
  eventStream: EventStream
  client: OpencodeClient
  lastCtx: ReadonlyMap<string, MessageContext> // bridge 拥有写权，本域只读
  safeDeliver: (ctx: MessageContext, text: string) => Promise<void>
  bgWaits: ReadonlyMap<string, { cancel: () => void }> // 后台等待在途则不解锁
  busyUsers: ReadonlySet<string> // 会话主人在忙则不解锁（5 秒宽限内再判定）
}

export interface Mirror {
  api: MirrorApi
  ensureSubs: () => void
  beginTurn: (sessionId: string) => void // 新 QQ 回合：补挂订阅 + 在途标记
  scheduleUnlock: (sessionId: string) => void
}

export function createMirror(deps: MirrorDeps): Mirror {
  const { sessions, eventStream, client, lastCtx, safeDeliver, bgWaits, busyUsers } = deps
  const mirrorUnsubs = new Map<string, () => void>() // 摘要镜像订阅（独立于 /watch）
  const qqTurnActive = new Set<string>() // QQ 发起的轮次在途（镜像跳过防重复）
  const mirrorState = { enabled: loadMirrorEnabled() }

  // ===== 摘要镜像（E 阶段 A 方案）：桌面会话轮次完成 → QQ 摘要卡 =====
  // 与 /watch 观察推送互补：观察给过程里程碑，镜像给问答正文摘要。
  // QQ 自己发起的轮次由 promptAndWait 正常回复，不重复镜像（qqTurnActive 守卫）。
  function ensureMirrorSubs(): void {
    if (!mirrorState.enabled) return
    for (const { sessionId } of sessions.all()) {
      if (mirrorUnsubs.has(sessionId)) continue
      mirrorUnsubs.set(
        sessionId,
        eventStream.subscribe(sessionId, (ev) => {
          if (!mirrorState.enabled) return
          if (ev.type !== "session.execution.succeeded") return
          if (qqTurnActive.has(sessionId)) {
            console.log(`[mirror] 跳过：QQ 回合在途（由 promptAndWait 直答）session=${sessionId}`)
            return
          }
          void mirrorTurn(sessionId)
        }),
      )
    }
  }

  function disableMirrorSubs(): void {
    for (const unsub of mirrorUnsubs.values()) unsub()
    mirrorUnsubs.clear()
  }

  // QQ 轮次结束后延迟解锁镜像：SSE 完成事件可能晚于 promptAndWait 返回，
  // 5 秒宽限内若又有新 QQ 回合/后台等待在途则不解锁（防竞态开窗）。
  function scheduleMirrorUnlock(sessionId: string): void {
    setTimeout(() => {
      if (bgWaits.has(sessionId)) return
      const ownerBusy = sessions
        .all()
        .some((x) => x.sessionId === sessionId && busyUsers.has(x.userId))
      if (ownerBusy) return
      qqTurnActive.delete(sessionId)
    }, 5000)
  }

  async function mirrorTurn(sessionID: string): Promise<void> {
    try {
      const owners = sessions.all().filter((x) => x.sessionId === sessionID).map((x) => x.userId)
      if (owners.length === 0) {
        console.log(`[mirror] 跳过：会话无映射主人 session=${sessionID}`)
        return
      }
      const listJson = await client.session.messages({ path: { id: sessionID } })
      const digest = buildDigest(listJson?.data ?? [])
      if (!digest) {
        console.log(`[mirror] 跳过：无可摘要内容（空轮/纯工具轮）session=${sessionID}`)
        return
      }
      for (const userId of owners) {
        // 无最近 ctx（重启后尚未收到新消息）→ 构造主动通道 ctx，
        // deliver 的被动尝试失败会自然降级为主动消息（D4 配额内）。
        const recent = lastCtx.get(userId)
        const ctx: MessageContext = recent ?? { type: "c2c", userId, msgId: "", content: "" }
        await safeDeliver(ctx, digest)
      }
      console.log(`[mirror] 会话 ${sessionID} 摘要已镜像给 ${owners.length} 个用户`)
    } catch (error) {
      console.error("[mirror] 摘要镜像失败:", error)
    }
  }

  const api: MirrorApi = {
    set(enabled) {
      const prev = mirrorState.enabled
      mirrorState.enabled = enabled
      saveMirrorEnabled(enabled)
      if (enabled) {
        if (!prev) ensureMirrorSubs()
      } else {
        disableMirrorSubs()
      }
      return enabled
        ? "✅ 摘要镜像已开启：桌面会话轮次完成后推送问答摘要"
        : "🔇 摘要镜像已关闭（/mirror on 重新开启）"
    },
    status() {
      const subs = mirrorUnsubs.size
      return mirrorState.enabled
        ? `📋 摘要镜像：开（已挂 ${subs} 个会话订阅）`
        : "📋 摘要镜像：关（/mirror on 开启）"
    },
  }

  return {
    api,
    ensureSubs: ensureMirrorSubs,
    beginTurn(sessionId: string): void {
      ensureMirrorSubs()
      qqTurnActive.add(sessionId)
    },
    scheduleUnlock: scheduleMirrorUnlock,
  }
}
