// @input:  ../qq/api (uploadQQMedia/sendQQMediaMessage/MediaFileType), ../qq/types, node:fs/path
// @output: isAllowedSendPath, fileTypeForPath, extractSendFileMarkers, sendLocalFile, MAX_SEND_BYTES
// @pos:    core - 本地文件/图片发送到 QQ（生态观察缺口 4：bot→QQ 发图，用户拍板双通道）
//
// 双通道：①AI 回复里的 `QQ_SEND_FILE: <路径>` 标记（bridge 拦截）② /send <路径> 指令。
// 安全：路径白名单（默认只允许 QQ 图片缓存目录与 bot 工作目录，QQ_SEND_EXTRA_ROOTS 可扩）；
// 大小上限 20MB（官方单次上传上限，base64 前检查）。
import { readFileSync, statSync } from "node:fs"
import { resolve, extname, basename } from "node:path"
import { imageDir } from "../qq/media.js"
import { uploadQQMedia, sendQQMediaMessage, MediaFileType } from "../qq/api.js"
import type { MessageContext } from "../qq/types.js"

export const MAX_SEND_BYTES = 20 * 1024 * 1024

/** 允许发送的根目录白名单（默认：QQ 图片缓存 + bot 工作目录；env QQ_SEND_EXTRA_ROOTS 逗号追加） */
export function allowedSendRoots(extraEnv = process.env.QQ_SEND_EXTRA_ROOTS): string[] {
  const roots = [imageDir(), process.cwd()]
  if (extraEnv) {
    for (const r of extraEnv.split(",").map((s) => s.trim()).filter(Boolean)) roots.push(r)
  }
  return roots.map((r) => resolve(r))
}

/** 路径白名单校验：规范化后必须落在某个允许根目录内 */
export function isAllowedSendPath(filePath: string, roots = allowedSendRoots()): boolean {
  const full = resolve(filePath.trim().replace(/^"|"$/g, ""))
  return roots.some((root) => full === root || full.startsWith(root + "\\") || full.startsWith(root + "/"))
}

/** 扩展名 → QQ MediaFileType（图片=1/视频=2/语音=3/其余=文件） */
export function fileTypeForPath(filePath: string): number {
  const ext = extname(filePath).toLowerCase()
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return MediaFileType.IMAGE
  if ([".mp4", ".mov", ".webm", ".mkv"].includes(ext)) return MediaFileType.VIDEO
  if ([".mp3", ".amr", ".silk", ".wav", ".ogg"].includes(ext)) return MediaFileType.VOICE
  return MediaFileType.FILE
}

/** 从 AI 回复中提取 QQ_SEND_FILE 标记（整行，路径可带引号），返回剩余文本与路径列表 */
export function extractSendFileMarkers(text: string): { text: string; paths: string[] } {
  const paths: string[] = []
  const lines = text.split("\n")
  const keep: string[] = []
  for (const line of lines) {
    const m = /^\s*QQ_SEND_FILE:\s*(.+?)\s*$/.exec(line)
    if (m) {
      paths.push(m[1].replace(/^"|"$/g, ""))
    } else {
      keep.push(line)
    }
  }
  return { text: keep.join("\n").replace(/\n{3,}/g, "\n\n").trim(), paths }
}

export interface SendLocalFileDeps {
  getToken: () => Promise<string>
}

/** 白名单校验 → 读取 → 上传 → 发送媒体消息；错误以中文短语抛出（调用方回显用户）。 */
export async function sendLocalFile(
  ctx: MessageContext,
  filePath: string,
  deps: SendLocalFileDeps,
): Promise<string> {
  const trimmed = filePath.trim()
  if (!isAllowedSendPath(trimmed)) {
    throw new Error(`路径不在白名单（仅允许：${allowedSendRoots().join("、")}；可加 QQ_SEND_EXTRA_ROOTS）`)
  }
  let stat
  try {
    stat = statSync(trimmed)
  } catch {
    throw new Error("文件不存在或不可读")
  }
  if (!stat.isFile()) throw new Error("不是文件")
  if (stat.size === 0) throw new Error("空文件")
  if (stat.size > MAX_SEND_BYTES) throw new Error(`超过 20MB 上限（实际 ${Math.round(stat.size / 1024 / 1024)}MB）`)

  const token = await deps.getToken()
  const fileType = fileTypeForPath(trimmed)
  const name = basename(trimmed)
  const uploaded = await uploadQQMedia(token, ctx, {
    fileType,
    fileData: readFileSync(trimmed).toString("base64"),
    fileName: fileType === MediaFileType.FILE ? name : undefined,
  })
  await sendQQMediaMessage(token, ctx, uploaded.file_info, name)
  return `已发送：${name}`
}
