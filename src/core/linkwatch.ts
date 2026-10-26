// HC2（2026-10-26）：运行中链路自愈巡检。
// 复盘3 教训：bot 与 opencode 平时零流量 + 看门狗只验进程心跳 → 下游死亡
// 不可观测（2026-10-26 实证：端口漂移后黑暗 3 天，直到用户消息撞上）。
// 本模块给链路装独立心跳：
//   每 OPENCODE_LINKWATCH_MINUTES（默认 30）分钟静默 healthCheck；
//   失败 → 立即端口发现 → 命中即原地热换基（client.rebase + onRebase 联动
//   eventstream）→ 立即复验；
//   事故状态机落盘 ~/.openqq/incident.json（open/closed/attempts/rebasedTo，
//   跨重启延续计数、重启不洗白）；
//   告警走 QQ 主动消息（每事故 open + fixed 各 ≤1 条，去重不骚扰）。
// @input:  client（healthCheck/rebase）、discoverOpencode、alarm 回调、fs
// @output: startLinkWatch, LinkWatchDeps, IncidentRecord, incidentPath
// @pos:    core - 链路巡检（HC2）
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { discoverOpencode, persistDiscovery, type OpencodeDiscovery } from "./discovery.js"
import { healthCheck, type OpencodeClient } from "../opencode/client.js"

export interface LinkWatchDeps {
  client: OpencodeClient
  // 热换基联动：eventstream 等持有同源 base 的组件在此同步换址
  onRebase?: (baseUrl: string, discovery: OpencodeDiscovery) => void
  // 告警通道（QQ 主动消息）；未提供则仅落盘+日志
  alarm?: (text: string) => Promise<void>
  intervalMin?: number
  // 测试注入：跳过 netstat 全扫描
  discover?: (password?: string) => Promise<OpencodeDiscovery | null>
  // 测试注入：事故文件路径（默认 ~/.openqq/incident.json）
  incidentFile?: string
}

export interface IncidentRecord {
  state: "open" | "closed"
  since: string // ISO：首次失败时刻
  lastCheck: string // ISO
  lastError: string
  attempts: number
  rebasedTo?: string
}

export function incidentPath(): string {
  return join(homedir(), ".openqq", "incident.json")
}

function saveIncident(path: string, rec: IncidentRecord): void {
  try {
    writeFileSync(path, JSON.stringify(rec, null, 2))
  } catch (error) {
    console.error("[linkwatch] incident 落盘失败:", error instanceof Error ? error.message : error)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export interface LinkWatch {
  stop(): void
  // 测试/手动触发一轮巡检（与定时循环共用同一状态机，busy 互斥）
  runOnce(): Promise<void>
}

export function startLinkWatch(deps: LinkWatchDeps): LinkWatch {
  const envMin = Number(process.env.OPENCODE_LINKWATCH_MINUTES)
  const intervalMs = Math.max(1, deps.intervalMin ?? (Number.isFinite(envMin) && envMin > 0 ? envMin : 30)) * 60_000
  const file = deps.incidentFile ?? incidentPath()
  const discover = deps.discover ?? ((p?: string) => discoverOpencode({ password: p }))
  const password = process.env.OPENCODE_PASSWORD

  let rec: IncidentRecord | null = null
  let alarmOpenSent = false // 去重：每事故 open 告警只发一次（含跨重启）
  let stopped = false
  let busy = false
  let loopTimer: ReturnType<typeof setTimeout> | null = null

  // 恢复落盘的未结事故（跨重启延续；重启后不重发 open 告警，避免看门狗
  // 周期重启导致告警风暴）
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as IncidentRecord
      if (raw?.state === "open" && typeof raw.since === "string") {
        rec = raw
        alarmOpenSent = true
        console.log(`[linkwatch] 恢复未结事故：自 ${raw.since}（attempts=${raw.attempts}），继续自愈`)
      }
    }
  } catch {
    // 损坏即视为无事故
  }

  async function fire(text: string): Promise<void> {
    try {
      await deps.alarm?.(text)
    } catch (error) {
      console.error("[linkwatch] 告警发送失败:", error instanceof Error ? error.message : error)
    }
  }

  async function tick(): Promise<void> {
    if (stopped || busy) return
    busy = true
    try {
      try {
        await healthCheck(deps.client, true)
        // 健康：若有未结事故 → 结案（含恢复告警）
        if (rec?.state === "open") {
          const open = rec
          const durMin = Math.max(1, Math.round((Date.now() - new Date(open.since).getTime()) / 60_000))
          console.log(`[linkwatch] 链路恢复（中断约 ${durMin} 分钟，共 ${open.attempts} 次巡检失败）`)
          if (!open.rebasedTo) {
            // rebase 恢复路径在切换时已发过 fixed 告警；只有自然恢复才发恢复通知
            await fire(`✅ OpenCode 链路恢复（中断约 ${durMin} 分钟，共 ${open.attempts} 次巡检失败）`)
          }
          saveIncident(file, { ...open, state: "closed", lastCheck: nowIso() })
          rec = null
          alarmOpenSent = false
        }
        return
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (!rec) {
          rec = { state: "open", since: nowIso(), lastCheck: nowIso(), lastError: msg, attempts: 0 }
          console.error(`[linkwatch] ⚠️ 链路失联开始（${msg}），转入自愈巡检`)
        }
        const inc = rec
        inc.attempts++
        inc.lastError = msg
        inc.lastCheck = nowIso()

        // 首次失败才发 open 告警（去重）
        if (!alarmOpenSent) {
          alarmOpenSent = true
          await fire(
            `⚠️ OpenCode 链路失联（自 ${inc.since.slice(11, 16)} 起，错误：${msg.slice(0, 80)}）。已转入自动自愈：发现新端口会自动切换并通知。`,
          )
        }

        // 自愈：端口发现 → 热换基 → 复验
        const found = await discover(password)
        if (found && found.baseUrl !== deps.client.baseUrl) {
          deps.client.rebase(found.baseUrl)
          deps.onRebase?.(found.baseUrl, found)
          persistDiscovery(found)
          inc.rebasedTo = found.baseUrl
          saveIncident(file, inc)
          console.log(`[linkwatch] 热换基完成 → ${found.baseUrl}（v${found.version}），复验中…`)
          try {
            await healthCheck(deps.client, true)
            console.log("[linkwatch] ✅ 换基复验通过，链路恢复")
            await fire(`✅ OpenCode 端口已漂移，已自动切换旧地址 → ${found.baseUrl}（v${found.version}），链路恢复。`)
            saveIncident(file, { ...inc, state: "closed", lastCheck: nowIso() })
            rec = null
            alarmOpenSent = false
          } catch (e2) {
            inc.lastError = e2 instanceof Error ? e2.message : String(e2)
            inc.lastCheck = nowIso()
            saveIncident(file, inc)
            console.error("[linkwatch] 换基后仍失联，下轮继续:", inc.lastError)
          }
        } else {
          // 未发现新端口（服务真宕/同口抖动）：保持 open，下一轮再试
          saveIncident(file, inc)
          console.error(`[linkwatch] 第 ${inc.attempts} 次巡检失败，未发现新端口（${msg.slice(0, 80)}）`)
        }
      }
    } finally {
      busy = false
    }
  }

  // 可取消 sleep：stop() 清掉 pending 定时器，独立脚本（runOnce 后退出）不再悬挂
  function waitInterval(): Promise<void> {
    return new Promise((resolve) => {
      loopTimer = setTimeout(resolve, intervalMs)
    })
  }

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await waitInterval()
      if (stopped) break
      await tick()
    }
  }
  void loop()

  return {
    stop: () => {
      stopped = true
      if (loopTimer) clearTimeout(loopTimer)
    },
    runOnce: tick,
  }
}
