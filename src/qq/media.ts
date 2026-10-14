// @input:  ./api (getAccessToken), ./types (MessageAttachment), node:fs/os/path
// @output: extForImageMime, imageDir, downloadQQAttachment, prepareQQAttachments,
//          groupOutcomes, augmentPromptWithAttachments, purgeOldQQImages
// @pos:    qq层 - QQ 图片下载落盘 + prompt 文本/附件合成（原生附件接入 2026-10-14）
//
// QQ 图片消息到网关只有 URL（MessageAttachment.url）；本模块下载落盘成文件，
// 再转成 prompt body 的 files（{uri, name}，v2 PromptInput schema 内字段）。
// 纯文本桥时代图片被静默丢弃——现在任何失败（下载不通/类型不支持）都转成
// 可见的文字备注，绝不静默。

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { MessageAttachment } from "./types.js"

export interface PromptFile {
  uri: string
  name?: string
}

export interface PreparedAttachments {
  files: PromptFile[]
  notes: string[]
}

/** 下载结果（纯数据，便于单测分组逻辑） */
export type AttachmentOutcome =
  | { path: string; name: string }
  | { failed: string }
  | { unsupported: string }

export function extForImageMime(mime: string): string | null {
  const m = (mime || "").toLowerCase().split(";")[0].trim()
  if (m === "image/jpeg") return "jpg"
  for (const x of ["png", "gif", "webp", "bmp"]) if (m === `image/${x}`) return x
  return null
}

export function imageDir(): string {
  return join(tmpdir(), "opencode", "qq-images")
}

async function fetchWithTimeout(url: string, ms: number, auth?: string): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: auth ? { Authorization: `QQBot ${auth}` } : {},
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载 QQ 图片附件到本地。非图片类型返回 unsupported；下载失败返回 failed
 * （reason）。401/403 时带 access_token 重试一次（CDN 签名 URL 通常免鉴权，
 * 此为兜底）。
 */
export async function downloadQQAttachment(
  att: MessageAttachment,
  getAuth?: () => Promise<string>,
): Promise<AttachmentOutcome> {
  const ext = extForImageMime(att.content_type || "")
  if (!ext) return { unsupported: att.content_type || att.filename || "未知类型" }
  try {
    const dir = imageDir()
    mkdirSync(dir, { recursive: true })
    const name = `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    let res = await fetchWithTimeout(att.url, 15000)
    if ((res.status === 401 || res.status === 403) && getAuth) {
      try {
        const tok = await getAuth()
        res = await fetchWithTimeout(att.url, 15000, tok)
      } catch {
        /* 鉴权兜底失败：保持原状态，走下方 !res.ok 归 failed */
      }
    }
    if (!res.ok) return { failed: `HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return { failed: "空响应" }
    const full = join(dir, name)
    writeFileSync(full, buf)
    return { path: full, name }
  } catch (e) {
    return { failed: e instanceof Error ? e.message : String(e) }
  }
}

/** 下载一组附件并汇总（bridge 的唯一入口） */
export async function prepareQQAttachments(
  attachments: MessageAttachment[] | undefined,
  getAuth?: () => Promise<string>,
): Promise<PreparedAttachments> {
  if (!attachments?.length) return { files: [], notes: [] }
  const outcomes: AttachmentOutcome[] = []
  for (const att of attachments) outcomes.push(await downloadQQAttachment(att, getAuth))
  return groupOutcomes(outcomes)
}

/** 下载结果分组（纯函数，供单测） */
export function groupOutcomes(outcomes: AttachmentOutcome[]): PreparedAttachments {
  const files: PromptFile[] = []
  const notes: string[] = []
  for (const o of outcomes) {
    if ("path" in o) {
      files.push({ uri: `file:///${o.path.replace(/\\/g, "/")}`, name: o.name })
    } else if ("failed" in o) {
      notes.push(`（图片下载失败：${o.failed}）`)
    } else {
      notes.push(`（暂不支持的附件类型：${o.unsupported}）`)
    }
  }
  return { files, notes }
}

/**
 * 把附件合成进 prompt（纯函数，供单测）：
 * - 有文字：文字保留，失败/不支持备注附在其后
 * - 纯图（无文字）：占位文字，模型经 files 直接看到图
 * - 纯失败（图没下下来）：备注即正文，QQ 端可见而不是静默
 */
export function augmentPromptWithAttachments(
  rawContent: string,
  prepared: PreparedAttachments,
): { text: string; files: PromptFile[] } {
  const base = rawContent.trim()
  const { files, notes } = prepared
  let text = base
  if (!text && files.length > 0) text = "（用户通过 QQ 发来了图片，未附文字）"
  if (!text && notes.length > 0) text = "（用户通过 QQ 发来了内容，但无法处理）"
  if (notes.length > 0) text = text ? `${text}\n\n${notes.join("\n")}` : notes.join("\n")
  return { text, files }
}

/** 启动清理：删掉 7 天前的落盘图片（只在自己的子目录内操作） */
export function purgeOldQQImages(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  try {
    const dir = imageDir()
    const now = Date.now()
    for (const f of readdirSync(dir)) {
      const full = join(dir, f)
      try {
        if (now - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full)
      } catch {
        /* 单文件失败忽略 */
      }
    }
  } catch {
    /* 目录不存在等忽略 */
  }
}
