// @input:  fs/path/os（落盘）、env（窗口可调）
// @output: loadGatewayState, saveGatewayState, clearGatewayState, GATEWAY_STATE_FILE
// @pos:    core - QQ 网关 session/seq 持久化（修复②：重启不再 IDENTIFY 失忆重刷 backlog）
//
// 背景（2026-11-03 定案）：gateway 的 session/seq 原先只在内存，进程重启即失忆 →
// 走 IDENTIFY → 服务端断线窗口事件重放 + 启动对账把旧账再跑一遍 = 放大器A
// （openqq423/429 ghost 铁证）。持久化后重启优先 RESUME，失败由服务端
// op9 InvalidSession 回退 IDENTIFY（gateway 已有该处理路径，无死循环）。
// 风控：文件只存 session_id/seq/时间戳，无凭据；损坏/超龄一律作废不阻塞启动；
// 保存走临时文件原子 rename，与台账同风格。
import { storageFile } from "./storage.js"
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs"
import { join } from "path"

export interface GatewayPersistState {
  session_id: string
  seq: number
  savedAt: number
}

export const GATEWAY_STATE_FILE = storageFile("gateway-state.json")

/**
 * RESUME 尝试窗口：QQ 网关断线会话 TTL 观测约 1h（427 每小时 RESUMED 实证）。
 * 这里放宽到 6h 只是「值得试」的上限——超龄直接 IDENTIFY；RESUME 失败有 op9 回退，
 * 不会死循环。env QQ_GATEWAY_STATE_MAX_HOURS 可调。
 */
export function gatewayStateMaxAgeMs(): number {
  const h = Number(process.env.QQ_GATEWAY_STATE_MAX_HOURS ?? "6")
  return Number.isFinite(h) && h > 0 ? Math.floor(h * 3600_000) : 6 * 3600_000
}

/** 读取持久化网关状态；缺损/超龄返回 null（调用方走 IDENTIFY） */
export function loadGatewayState(file: string = GATEWAY_STATE_FILE, now: number = Date.now()): GatewayPersistState | null {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<GatewayPersistState>
    if (!raw || typeof raw.session_id !== "string" || !raw.session_id) return null
    if (typeof raw.seq !== "number" || raw.seq < 0) return null
    if (typeof raw.savedAt !== "number" || !Number.isFinite(raw.savedAt)) return null
    if (now - raw.savedAt > gatewayStateMaxAgeMs()) return null // 超龄作废
    return { session_id: raw.session_id, seq: raw.seq, savedAt: raw.savedAt }
  } catch {
    return null // 损坏即无状态，不阻塞启动
  }
}

/** 原子落盘网关状态（每载荷推进调用；小文件低频，不做节流） */
export function saveGatewayState(sessionId: string, seq: number, file: string = GATEWAY_STATE_FILE): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ session_id: sessionId, seq, savedAt: Date.now() }))
    renameSync(tmp, file)
  } catch (error) {
    // 持久化失败不致命：本连接周期内仍走内存态，重叠留观
    console.warn("[gateway-state] 落盘失败:", error instanceof Error ? error.message : error)
  }
}

/** 清账：仅在服务端明确作废会话（op9 不可恢复/Resume 失效码）时调用 */
export function clearGatewayState(file: string = GATEWAY_STATE_FILE): void {
  try {
    unlinkSync(file)
  } catch {
    /* 不存在/已清理 */
  }
}
