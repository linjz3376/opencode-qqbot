// @input:  node:fs/node:zlib（OOXML zip/XML 只读解析）
// @output: officeKindForPath, isLegacyOfficePath, extractOfficeTextFromFile
// @pos:    core - Office Open XML 文档文本提取（docx/xlsx/pptx 及 macro 变体）
//
// 设计边界：只支持 ZIP 容器 + XML 的现代 Office 格式；传统 .doc/.xls/.ppt
// 是 OLE 二进制，跨平台零依赖无法安全解析，由调用方明确拒识并指引转换。
import { readFileSync } from "node:fs"
import { inflateRawSync } from "node:zlib"

export type OfficeKind = "docx" | "xlsx" | "pptx"

const MAX_ENTRY_COUNT = 10_000
const MAX_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024
export const MAX_OFFICE_TEXT_CHARS = 200_000

export function officeKindForPath(path: string): OfficeKind | null {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ""
  if (ext === "docx" || ext === "docm") return "docx"
  if (ext === "xlsx" || ext === "xlsm") return "xlsx"
  if (ext === "pptx" || ext === "pptm") return "pptx"
  return null
}

export function isLegacyOfficePath(path: string): boolean {
  return /\.(doc|xls|ppt)$/i.test(path)
}

interface ZipEntry {
  name: string
  flags: number
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557) // EOCD 22B + 最大 comment 65535B
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error("不是有效的 ZIP/OOXML 文件")
}

function readZipEntries(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEndOfCentralDirectory(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  if (count > MAX_ENTRY_COUNT) throw new Error("ZIP 条目过多")
  const entries = new Map<string, ZipEntry>()
  let offset = centralOffset
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP 中央目录损坏")
    }
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const uncompressedSize = buf.readUInt32LE(offset + 24)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localHeaderOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString("utf8")
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) throw new Error(`ZIP 条目过大：${name}`)
    entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if ((entry.flags & 0x1) !== 0) throw new Error(`加密 ZIP 条目不支持：${entry.name}`)
  const offset = entry.localHeaderOffset
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`ZIP 本地头损坏：${entry.name}`)
  }
  const nameLength = buf.readUInt16LE(offset + 26)
  const extraLength = buf.readUInt16LE(offset + 28)
  const dataOffset = offset + 30 + nameLength + extraLength
  const dataEnd = dataOffset + entry.compressedSize
  if (dataEnd > buf.length) throw new Error(`ZIP 数据越界：${entry.name}`)
  const data = buf.subarray(dataOffset, dataEnd)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) {
    const out = inflateRawSync(data)
    if (out.length !== entry.uncompressedSize) throw new Error(`ZIP 解压长度不符：${entry.name}`)
    return out
  }
  throw new Error(`ZIP 压缩方式不支持：${entry.name}`)
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) {
    out[match[1]] = xmlUnescape(match[2])
  }
  return out
}

function normalizeExtractedText(value: string): string {
  const cleaned = xmlUnescape(value.replace(/<[^>]+>/g, ""))
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/ +/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return cleaned.length > MAX_OFFICE_TEXT_CHARS
    ? `${cleaned.slice(0, MAX_OFFICE_TEXT_CHARS)}\n…（Office 文档内容过长，已截断）`
    : cleaned
}

function extractDocx(entries: Map<string, ZipEntry>, zip: Buffer): string {
  const entry = entries.get("word/document.xml")
  if (!entry) throw new Error("DOCX 缺少 word/document.xml")
  const xml = readZipEntry(zip, entry).toString("utf8")
  const text = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, "$1")
  return normalizeExtractedText(text)
}

function extractPptx(entries: Map<string, ZipEntry>, zip: Buffer): string {
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0))
  if (slides.length === 0) throw new Error("PPTX 缺少幻灯片 XML")
  const parts: string[] = []
  for (const [index, name] of slides.entries()) {
    const xml = readZipEntry(zip, entries.get(name)!).toString("utf8")
    const text = xml
      .replace(/<a:br\b[^>]*\/>/g, "\n")
      .replace(/<\/a:p>/g, "\n")
      .replace(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, "$1")
    const cleaned = normalizeExtractedText(text)
    if (cleaned) parts.push(`## Slide ${index + 1}\n${cleaned}`)
  }
  return normalizeExtractedText(parts.join("\n\n"))
}

function sharedStrings(entries: Map<string, ZipEntry>, zip: Buffer): string[] {
  const entry = entries.get("xl/sharedStrings.xml")
  if (!entry) return []
  const xml = readZipEntry(zip, entry).toString("utf8")
  const out: string[] = []
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const texts = [...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlUnescape(m[1]))
    out.push(texts.join(""))
  }
  return out
}

function workbookSheets(entries: Map<string, ZipEntry>, zip: Buffer): Array<{ name: string; path: string }> {
  const workbookEntry = entries.get("xl/workbook.xml")
  if (!workbookEntry) throw new Error("XLSX 缺少 xl/workbook.xml")
  const workbook = readZipEntry(zip, workbookEntry).toString("utf8")
  const rels = new Map<string, string>()
  const relEntry = entries.get("xl/_rels/workbook.xml.rels")
  if (relEntry) {
    const relXml = readZipEntry(zip, relEntry).toString("utf8")
    for (const rel of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const a = attrs(rel[0])
      if (a.Id && a.Target) rels.set(a.Id, a.Target.replace(/^\//, ""))
    }
  }
  const sheets: Array<{ name: string; path: string }> = []
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*\/>/g)) {
    const a = attrs(sheet[0])
    const rid = a["r:id"] ?? a.id
    const target = rid ? rels.get(rid) : undefined
    const path = target?.startsWith("xl/") ? target : target ? `xl/${target}` : undefined
    if (a.name && path && entries.has(path)) sheets.push({ name: a.name, path })
  }
  if (sheets.length > 0) return sheets
  return [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/sheet(\d+)\.xml$/)?.[1] ?? 0))
    .map((path, index) => ({ name: `Sheet${index + 1}`, path }))
}

function cellText(cellTag: string, body: string, shared: string[]): string {
  const type = attrs(cellTag).t
  if (type === "s") {
    const index = Number(body.match(/<v>(\d+)<\/v>/)?.[1] ?? "-1")
    return shared[index] ?? ""
  }
  if (type === "inlineStr") {
    return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlUnescape(m[1])).join("")
  }
  const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
  return value === undefined ? "" : xmlUnescape(value)
}

function extractXlsx(entries: Map<string, ZipEntry>, zip: Buffer): string {
  const shared = sharedStrings(entries, zip)
  const parts: string[] = []
  for (const sheet of workbookSheets(entries, zip)) {
    const xml = readZipEntry(zip, entries.get(sheet.path)!).toString("utf8")
    const rows: string[] = []
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        cells.push(cellText(`<c ${cell[1]}>`, cell[2], shared))
      }
      if (cells.some((cell) => cell.trim())) rows.push(cells.join("\t").trimEnd())
    }
    if (rows.length > 0) parts.push(`## Sheet: ${sheet.name}\n${rows.join("\n")}`)
  }
  return normalizeExtractedText(parts.join("\n\n"))
}

export function extractOfficeTextFromFile(filePath: string): string {
  const kind = officeKindForPath(filePath)
  if (!kind) throw new Error("不是支持的 Office 文档格式")
  const zip = readFileSync(filePath)
  const entries = readZipEntries(zip)
  if (kind === "docx") return extractDocx(entries, zip)
  if (kind === "pptx") return extractPptx(entries, zip)
  return extractXlsx(entries, zip)
}
