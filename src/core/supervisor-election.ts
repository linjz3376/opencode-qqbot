// @input:  fs、时钟
// @output: electSupervisor(channel, opts?)
// @pos:    core - 监督通道选主租约（2026-11-20 owner 批「双触发器归一」）
//
// 背景：superviseOnce 的监督矩阵已是杀/拉唯一权威，但触发器有两个——
// service（计划任务 openqq-watchdog --once）与 plugin（引擎内嵌引导器巡检）。
// 双触发器相位不一，监督者认领互斥（90s claim）只能逐 tick 串行，历史上造成
// 排程撞车（11-20 激活亲历 restart 与巡检互相踩相位）。
// 归一：本租约选出一个独占监督通道——赢家每 tick 续租并照常 superviseOnce，
// 输家整轮让贤（连 superviseOnce 都不进：不抢认领、不写强度账、零干扰）；
// 租约过期（赢家死亡/停排，TTL 10 分钟）后另一通道自动接管，双向自愈。
//
// 2026-11-25 租约定稿（owner 令）：channel 优先级 service>plugin + 时间戳判定，
// pid 降级为纯诊断字段——旧版按 pid 判「非我」致 --once 每轮新 pid 自相让贤
// （5min 计划任务实际 10min 一轮，issue 实证）。规则：
//   ①他 channel 租约新鲜：优先级高者当值（service 恒压 plugin）；低者让贤。
//   ②同 channel：pid 相同=续租；service 下 pid 不同照常续租（--once 短进程语义）；
//     plugin 下 pid 不同且租约新鲜=让贤（多引擎并发加载互斥）。
//   ③租约过期/缺失：本 channel 当值并覆盖写。
//   ④service 恢复即抢回（无「后占先」态）。
// fail-open：租约文件不可写时放行监督——监督缺失比双触发更糟。
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export type SupervisorChannel = "service" | "plugin"

export interface SupervisorLease {
  channel: SupervisorChannel
  pid: number
  until: number
}

const LEASE_PATH = join(homedir(), ".openqq", "supervisor-lease.json")
const LEASE_TTL_MS = 10 * 60_000
const PRIORITY: Record<SupervisorChannel, number> = { service: 2, plugin: 1 }

/** 选主：持有/夺得租约返回 true（可监督）；他通道高优先级或同 plugin channel 他 pid 持新鲜租约返回 false（让贤）。 */
export function electSupervisor(
  channel: SupervisorChannel,
  opts?: { ttlMs?: number; now?: number; path?: string; pid?: number },
): boolean {
  const ttlMs = opts?.ttlMs ?? LEASE_TTL_MS
  const now = opts?.now ?? Date.now()
  const path = opts?.path ?? LEASE_PATH
  const pid = opts?.pid ?? process.pid
  try {
    let cur: Partial<SupervisorLease> | null = null
    try {
      cur = JSON.parse(readFileSync(path, "utf-8")) as Partial<SupervisorLease>
    } catch {
      /* 无租约或损坏 → 视为可夺 */
    }
    if (cur && typeof cur.until === "number" && cur.until > now && cur.channel) {
      if (cur.channel !== channel) {
        // 他 channel：按恒定优先级裁决——service 恒压 plugin；本端优先级低则让贤
        if (PRIORITY[cur.channel] > PRIORITY[channel]) return false
      } else if (channel === "plugin" && cur.pid !== pid) {
        // 同 plugin channel 他 pid：多引擎并发加载互斥（service --once 不受此限）
        return false
      }
    }
    writeFileSync(path, JSON.stringify({ channel, pid, until: now + ttlMs }))
    return true
  } catch {
    return true // fail-open：租约不可写不阻断监督
  }
}
