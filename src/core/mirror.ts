// @input:  ../opencode/{client, eventstream, mirror, sessions}, ../qq/types, ../commands, fs/path/os
// @output: createMirror
// @pos:    根层/core - 摘要镜像域（O7d 2026-10-15 自 bridge.ts 拆出：会话订阅、
//          QQ 回合标记与延迟解锁、回合完成摘要投递、开关持久化）
import { storageFile, storageRoot } from "./storage.js"
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import type { MessageContext } from "../qq/types.js"
import type { OpencodeClient } from "../opencode/client.js"
import { createEventStream } from "../opencode/eventstream.js"
import {
  buildDigest,
  clipDigestTitle,
  digestAnchorUserId,
  digestSessionLabel,
  digestTurnKey,
} from "../opencode/mirror.js"
import { laneKeyOf } from "./message-queue.js"
import { redactSecrets } from "../opencode/history.js"
import type { DeliveryContentOptions, OnSentMessage } from "./delivery.js"
import type { MirrorAnchorStore } from "./mirror-anchors.js"
import type { SessionManager } from "../opencode/sessions.js"
import type { MirrorApi } from "../commands.js"

type EventStream = ReturnType<typeof createEventStream>

// 摘要镜像开关（~/.openqq/settings.json 持久；BOM 防御与 greeted 一致）
const MIRROR_SETTINGS_FILE = storageFile("settings.json")

function loadMirrorEnabled(file: string = MIRROR_SETTINGS_FILE): boolean {
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8").replace(/^\uFEFF/, "")
      const parsed = JSON.parse(raw)
      if (typeof parsed?.mirror === "boolean") return parsed.mirror
    }
  } catch {
    // fall through to default
  }
  return true // 默认开（用户点单 A 摘要镜像）
}

function saveMirrorEnabled(enabled: boolean, file: string = MIRROR_SETTINGS_FILE): void {
  try {
    mkdirSync(storageRoot(), { recursive: true })
    let existing: Record<string, unknown> = {}
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, "utf-8").replace(/^\uFEFF/, "")
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === "object") existing = parsed
      } catch {
        // 损坏则重建
      }
    }
    existing.mirror = enabled
    writeFileSync(file, JSON.stringify(existing, null, 2), "utf-8")
  } catch (error) {
    console.error("[mirror] 保存设置失败:", error)
  }
}

export interface MirrorDeps {
  sessions: SessionManager
  eventStream: EventStream
  client: OpencodeClient
  lastCtx: ReadonlyMap<string, MessageContext> // bridge 拥有写权，本域只读
  safeDeliver: (
    ctx: MessageContext,
    text: string,
    onSent?: OnSentMessage,
    content?: DeliveryContentOptions,
  ) => Promise<boolean>
  bgWaits: ReadonlyMap<string, { cancel: () => void }> // 后台等待在途则不解锁
  busyUsers: ReadonlySet<string> // 会话主人在忙则不解锁（5 秒宽限内再判定）
  /** 多角色（2026-11-17）：镜像开关文件可按角色注入；缺省 legacy 全局 settings.json */
  settingsFile?: string
  /** 角色级摘要回复锚点；缺省仅用于轻量组件测试，不持久化。 */
  anchorStore?: MirrorAnchorStore
  /** A 方案（2026-11-23）：摘要投递前过 cron 标记钩——注册提醒并返回剥净正文。
   *  桌面端发起的回合也会输出 QQBOT_PAYLOAD，不经此钩会原样泄漏到 QQ。 */
  onDigest?: (userId: string, digest: string) => string
  /** kickoff 归属 bot 侧标记（2026-11-23）：goal 设定时的目标原文——buildDigest
   *  对「边界 user 文本==目标原文」的回合标 🎯（引擎不给 kickoff 打标的近似识别）。 */
  goalObjectiveOf?: (sessionID: string) => string | undefined
}

export interface Mirror {
  api: MirrorApi
  ensureSubs: () => void
  beginTurn: (sessionId: string) => void // 新 QQ 回合：补挂订阅 + 在途标记
  /** DEF-20261118-P6 来源身份守卫：QQ 派发回合的 promptId（=用户消息 id）入册，
   *  镜像前核对锚定用户消息 id 命中即跳过——SSE 重放再迟也穿透不了身份核对。 */
  markQqPrompt: (sessionId: string, promptId: string) => void
  scheduleUnlock: (sessionId: string) => void
}

export function createMirror(deps: MirrorDeps): Mirror {
  const { sessions, eventStream, client, lastCtx, safeDeliver, bgWaits, busyUsers } = deps
  const mirrorUnsubs = new Map<string, () => void>() // 摘要镜像订阅（独立于 /watch）
  const qqTurnActive = new Set<string>() // QQ 发起的轮次在途（镜像跳过防重复）
  // DEF-20261118-P6（2026-11-18 晚 owner 拍板「判断信息来源非常重要」）：
  // 时序锁（qqTurnActive + 5s 宽限）只能防毫秒级竞态；网关 RESUME 会把断线期间的
  // execution.succeeded 迟到重放（21:23 实证穿透误发摘要——QQ 直答过的回合又收一张
  // 冗余摘要卡）。来源身份守卫不看快慢：派发时把 promptId（=引擎侧用户消息 id）记入
  // 本册，镜像前核对摘要锚定的用户消息 id 是否命中——重放再迟也改变不了消息来源。
  const qqPromptIds = new Map<string, Set<string>>() // sessionId -> QQ 派发过的 promptId 环
  const QQ_PROMPT_ID_CAP = 200
  const MIRROR_SESSION_STATE_CAP = 500
  function markQqPrompt(sessionId: string, promptId: string): void {
    if (!promptId) return
    const set = qqPromptIds.get(sessionId) ?? new Set<string>()
    qqPromptIds.delete(sessionId) // LRU：最近使用移到末尾
    if (set.size >= QQ_PROMPT_ID_CAP) {
      const first = set.values().next().value
      if (first !== undefined) set.delete(first)
    }
    set.add(promptId)
    qqPromptIds.set(sessionId, set)
    while (qqPromptIds.size > MIRROR_SESSION_STATE_CAP) {
      const oldest = qqPromptIds.keys().next().value
      if (oldest === undefined) break
      qqPromptIds.delete(oldest)
    }
  }
  const mirroredTurns = new Map<string, string>() // 逻辑回合幂等：多 location/重复完成事件只投一次
  function rememberMirroredTurn(sessionId: string, turnKey: string): void {
    mirroredTurns.delete(sessionId)
    mirroredTurns.set(sessionId, turnKey)
    while (mirroredTurns.size > MIRROR_SESSION_STATE_CAP) {
      const oldest = mirroredTurns.keys().next().value
      if (oldest === undefined) break
      mirroredTurns.delete(oldest)
    }
  }
  const mirrorState = { enabled: loadMirrorEnabled(deps.settingsFile) }

  // ===== 摘要镜像（E 阶段 A 方案）：桌面会话轮次完成 → QQ 摘要卡 =====
  // 与 /watch 观察推送互补：观察给过程里程碑，镜像给问答正文摘要。
  // QQ 自己发起的轮次由 promptAndWait 正常回复，不重复镜像（qqTurnActive 守卫）。
  // 订阅不是历史累加：始终是「当前绑定 sessionId 去重集」的幂等投影。
  function ensureMirrorSubs(): void {
    const desired = new Set(
      (mirrorState.enabled ? sessions.all() : []).map((binding) => binding.sessionId),
    )
    let added = 0
    let removed = 0
    for (const [sessionId, unsub] of [...mirrorUnsubs]) {
      if (desired.has(sessionId)) continue
      unsub()
      mirrorUnsubs.delete(sessionId)
      removed++
    }
    for (const sessionId of desired) {
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
      added++
    }
    if (added > 0 || removed > 0) {
      console.log(
        `[mirror-reconcile] desired=${desired.size} added=${added} removed=${removed} actual=${mirrorUnsubs.size}`,
      )
    }
  }

  // 所有绑定变更即时对账；60s 周期只作遗漏兜底。定时器不阻止进程退出。
  if (typeof sessions.onBindingChange === "function") {
    sessions.onBindingChange(() => ensureMirrorSubs())
  }
  const reconcileTimer = setInterval(ensureMirrorSubs, 60_000)
  reconcileTimer.unref?.()

  // QQ 轮次结束后延迟解锁镜像：SSE 完成事件可能晚于 promptAndWait 返回，
  // 5 秒宽限内若又有新 QQ 回合/后台等待在途则不解锁（防竞态开窗）。
  function scheduleMirrorUnlock(sessionId: string): void {
    setTimeout(() => {
      if (bgWaits.has(sessionId)) return
      // 会话隔离（owner 2026-11-14）：busyUsers 存 lane 键——只看本会话 lane 是否忙，
      // 该用户的其他会话在跑不阻止本会话镜像解锁。
      const ownerBusy = sessions
        .all()
        .some((x) => x.sessionId === sessionId && busyUsers.has(laneKeyOf(x.userId, sessionId)))
      if (ownerBusy) return
      qqTurnActive.delete(sessionId)
    }, 5000)
  }

  async function mirrorTurn(sessionID: string): Promise<void> {
    try {
      const bindings = sessions.all().filter((x) => x.sessionId === sessionID)
      const owners = bindings.map((x) => x.userId)
      if (owners.length === 0) {
        console.log(`[mirror] 跳过：会话无映射主人 session=${sessionID}`)
        return
      }
      let title: string | undefined
      if (typeof client.session.get === "function") {
        try {
          title = (await client.session.get({ path: { id: sessionID } }))?.data?.title
        } catch {
          // 标题只是展示元数据：服务端读取失败走映射缓存，不阻断摘要正文。
        }
      }
      title ??= bindings.find((binding) => binding.title?.trim())?.title
      const listJson = await client.session.messages({ path: { id: sessionID } })
      const messages = listJson?.data ?? []
      const turnKey = digestTurnKey(messages)
      if (turnKey && mirroredTurns.get(sessionID) === turnKey) {
        console.log(`[mirror] 跳过：逻辑回合已镜像 session=${sessionID} turn=${turnKey}`)
        return
      }
      // 来源身份守卫（DEF-20261118-P6）：锚定用户消息 id 命中 QQ 派发册 = 本回合由
      // QQ 直答，无论完成事件是实时还是 RESUME 重放，一律不重复镜像。登记幂等键防
      // 同回合被后续重放反复评估。
      const anchorId = digestAnchorUserId(messages)
      if (anchorId && qqPromptIds.get(sessionID)?.has(anchorId)) {
        console.log(`[mirror] 跳过：QQ 直答回合（来源身份核对命中）session=${sessionID} prompt=${anchorId}`)
        if (turnKey) rememberMirroredTurn(sessionID, turnKey)
        return
      }
      const digest = buildDigest(messages, deps.goalObjectiveOf?.(sessionID), {
        sessionId: sessionID,
        title,
      })
      if (!digest) {
        console.log(`[mirror] 跳过：无可摘要内容（空轮/纯工具轮）session=${sessionID}`)
        return
      }
      // 在投递前占位：两个完成事件并发到达时，后到的回调也会命中同一回合并被去重。
      if (turnKey) rememberMirroredTurn(sessionID, turnKey)
      for (const userId of owners) {
        // 无最近 ctx（重启后尚未收到新消息）→ 构造主动通道 ctx，
        // deliver 的被动尝试失败会自然降级为主动消息（D4 配额内）。
        // anchorSessionId=本摘要所属会话：出站推送门据此拦截（绑定切走不推，历史可回读）。
        const recent = lastCtx.get(userId)
        const ctx: MessageContext = recent
          ? { ...recent, anchorSessionId: sessionID }
          : { type: "c2c", userId, msgId: "", content: "", anchorSessionId: sessionID }
        const cronHook = deps.onDigest
        const outText = cronHook ? cronHook(userId, digest) : digest
        if (!outText.trim()) continue // 纯提醒标记的摘要：注册即全部语义，无可镜像内容
        const onSent: OnSentMessage = (receipt) => {
          if (!deps.anchorStore) return
          if (!receipt.refIdx) {
            console.warn(
              `[mirror-anchor] QQ 未返回 ref_idx，摘要不可安全路由 session=${sessionID} user=${userId.slice(0, 8)}…`,
            )
            return
          }
          try {
            deps.anchorStore.record({
              refIdx: receipt.refIdx,
              messageId: receipt.id,
              userId,
              sessionId: sessionID,
              title: clipDigestTitle(redactSecrets(title ?? "")),
              sentAt: Date.now(),
            })
            console.log(
              `[mirror-anchor] 已登记 session=${digestSessionLabel(sessionID)} user=${userId.slice(0, 8)}…`,
            )
          } catch (error) {
            console.error("[mirror-anchor] 锚点落盘失败，后续引用将 fail-closed:", error)
          }
        }
        await safeDeliver(ctx, outText, onSent, {
          continuationPrefix: `📋 摘要续 · ${digestSessionLabel(sessionID)}\n`,
        })
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
      saveMirrorEnabled(enabled, deps.settingsFile)
      if (enabled) {
        if (!prev) ensureMirrorSubs()
      } else {
        ensureMirrorSubs()
      }
      return enabled
        ? "✅ 摘要镜像已开启：桌面会话轮次完成后推送问答摘要"
        : "🔇 摘要镜像已关闭（/status mirror on 重新开启）"
    },
    status() {
      if (!mirrorState.enabled) return "📋 摘要镜像：关（/status mirror on 开启）"
      const desired = new Set(sessions.all().map((binding) => binding.sessionId))
      const actual = mirrorUnsubs.size
      const aligned = desired.size === actual && [...desired].every((sessionId) => mirrorUnsubs.has(sessionId))
      return aligned
        ? "📋 摘要镜像：开"
        : `⚠️ 摘要镜像：开 · 订阅对账异常（期望 ${desired.size} / 实际 ${actual}）`
    },
  }

  return {
    api,
    ensureSubs: ensureMirrorSubs,
    beginTurn(sessionId: string): void {
      ensureMirrorSubs()
      qqTurnActive.add(sessionId)
    },
    markQqPrompt,
    scheduleUnlock: scheduleMirrorUnlock,
  }
}
