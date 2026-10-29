// @input:  ../qq/api (getAccessToken, sendC2CMessage, sendGroupMessage, InlineKeyboard),
//          ../qq/types (MessageContext, InteractionEvent),
//          ./permission (formatPermissionPrompt, PendingPermission)
// @output: encodeButtonData, decodeButtonData, buildApprovalKeyboard, sendApprovalCard,
//          handleApprovalInteraction
// @pos:    core - 卡片按钮审批（A 项 2026-10-29）
//
// 设计吸收自 P0 官方源：dsh-qqbot src/features/{button-utils,approval-channel}.ts
// （button_data 明文 JSON + t 判别字段）与 @tencent-connect/qqbot-nodejs
// protocol/types.ts（KeyboardButton/InlineKeyboard 形状）。
// 与文字菜单并行不互拆：卡片优先，发送失败自动降级文字；文字通道原样保留。
// 安全基线（fail-closed）：忽略按钮=不决策（权限保持挂起至 TTL）；
// button_data 内嵌 request.id，槽位已被新请求替换时旧按钮点击直接拒识。
import { getAccessToken, sendC2CMessage, sendGroupMessage, type InlineKeyboard, type KeyboardButton } from "../qq/api.js"
import type { InteractionEvent, MessageContext } from "../qq/types.js"
import type { PermissionDecision, PermissionRequest } from "../opencode/client.js"
import { formatPermissionPrompt, type PendingPermission } from "./permission.js"

/** QQ 按钮 label 长度限制（dsh P0 实证） */
export const BUTTON_LABEL_MAX = 10

/** button_data 统一编码：明文 JSON + t 判别字段（dsh button-utils P0 格式），
 *  r=request.id 防伪（槽位替换后旧按钮失效） */
export interface ApprovalButtonData {
  t: "approval"
  r: string
  d: "once" | "always" | "reject" | "ignore"
}

export function encodeButtonData(data: ApprovalButtonData): string {
  return JSON.stringify(data)
}

export function decodeButtonData(raw: string | undefined): ApprovalButtonData | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalButtonData>
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.t === "approval" &&
      typeof parsed.r === "string" &&
      (parsed.d === "once" || parsed.d === "always" || parsed.d === "reject" || parsed.d === "ignore")
    ) {
      return parsed as ApprovalButtonData
    }
  } catch {
    // fall through
  }
  return undefined
}

function clipLabel(text: string): string {
  const s = text.trim()
  return s.length > BUTTON_LABEL_MAX ? s.slice(0, BUTTON_LABEL_MAX - 1) + "…" : s
}

function makeButton(label: string, style: number, data: ApprovalButtonData, ownerOpenid: string): KeyboardButton {
  return {
    id: `approval-${data.d}-${data.r}`.slice(0, 64),
    render_data: { label: clipLabel(label), visited_label: clipLabel(label), style },
    // permission.type=2 + specify_user_ids：仅审批发起人可点（官方 P0 字段，
    // 防止群里其他人代点裁决）
    action: { type: 1, permission: { type: 2, specify_user_ids: [ownerOpenid] }, data: encodeButtonData(data) },
  }
}

/** 审批卡片键盘：允许一次 / 总是允许 / 拒绝 / 忽略（2×2 布局） */
export function buildApprovalKeyboard(request: PermissionRequest, ownerOpenid: string): InlineKeyboard {
  const mk = (d: ApprovalButtonData["d"], label: string, style: number): KeyboardButton =>
    makeButton(label, style, { t: "approval", r: request.id, d }, ownerOpenid)
  return {
    content: {
      rows: [
        { buttons: [mk("once", "允许一次", 1), mk("always", "总是允许", 1)] },
        { buttons: [mk("reject", "拒绝", 0), mk("ignore", "忽略", 0)] },
      ],
    },
  }
}

export interface CardApprovalDeps {
  appId: string
  clientSecret: string
}

/** 发送审批卡片；成功=true。失败由调用方降级文字菜单（本函数不外抛）。 */
export async function sendApprovalCard(
  deps: CardApprovalDeps,
  ctx: MessageContext,
  request: PermissionRequest,
  mainSessionId: string,
): Promise<boolean> {
  try {
    const token = await getAccessToken(deps.appId, deps.clientSecret)
    const keyboard = buildApprovalKeyboard(request, ctx.userId)
    // 正文复用现有格式化（用户看到的字段与文字菜单完全一致）
    const text = formatPermissionPrompt(request, mainSessionId)
    if (ctx.type === "group" && ctx.groupId) {
      await sendGroupMessage(token, ctx.groupId, text, ctx.msgId, undefined, true, keyboard)
    } else {
      await sendC2CMessage(token, ctx.userId, text, ctx.msgId, undefined, true, keyboard)
    }
    console.log(`[card-approval] 审批卡片已发送 user=${ctx.userId.slice(0, 8)}… request=${request.id}`)
    return true
  } catch (error) {
    console.error("[card-approval] 审批卡片发送失败，将降级文字菜单:", error instanceof Error ? error.message : error)
    return false
  }
}

export interface ApprovalGateLike {
  getPending: (userId: string) => PendingPermission | undefined
  resolve: (userId: string, decision: PermissionDecision) => void
}

/** 互动回调 → 审批裁决。返回 true=已消费（含 ignore 吞掉）；false=非本域事件。
 *  竞态：文字回复与按钮先到先赢（resolve 后槽位即清空，后到者自然落空）。 */
export function handleApprovalInteraction(event: InteractionEvent, gate: ApprovalGateLike): boolean {
  const userId = event.user_openid
  if (!userId) return false
  const button = decodeButtonData(event.data?.resolved?.button_data)
  if (!button) return false

  const pending = gate.getPending(userId)
  if (!pending || pending.request.id !== button.r) {
    // 槽位已空或已被新请求替换：旧按钮点击，拒识（fail-closed，不误裁决新请求）
    console.log(`[card-approval] 拒识过期按钮点击 user=${userId.slice(0, 8)}… request=${button.r}`)
    return true
  }

  if (button.d === "ignore") {
    // 忽略=不决策：权限保持挂起，用户仍可文字回复或等 TTL 自动拒绝
    console.log(`[card-approval] 用户忽略审批请求 user=${userId.slice(0, 8)}… request=${button.r}`)
    return true
  }

  console.log(`[card-approval] 按钮裁决 user=${userId.slice(0, 8)}… request=${button.r} decision=${button.d}`)
  gate.resolve(userId, button.d)
  return true
}
