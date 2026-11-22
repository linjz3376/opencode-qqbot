// @input:  node:fs/path/os、process.env（QQ_CONFIG_FILE 测试覆盖）
// @output: parseConfigJson/computeOverlay/applyConfigOverlay/configJsonPath
// @pos:    core - 行为配置分层（2026-11-23 owner 裁定 P2：对齐官方「json=行为、env=密钥」）
//
// 层级（高→低）：继承环境 > ~/.openqq/.env > ~/.openqq/config.json > 内置默认。
// config.json 为平铺 JSON，键名与 env 相同（零映射表，文档一句讲清）；
// 只收行为键，密钥（QQ_APP_SECRET/OPENCODE_PASSWORD 等）仍必须走 .env——
// 叠加规则「已设不覆盖」：在 .env 加载前应用，天然落位最低用户层。
// 叠加方式是写入 process.env——业务代码 51 处读取点零改动（最小侵入）。

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** config.json 路径：QQ_CONFIG_FILE 覆盖（测试/多实例隔离用），默认 ~/.openqq/config.json */
export function configJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.QQ_CONFIG_FILE?.trim() || join(homedir(), ".openqq", "config.json")
}

/** 解析平铺配置（纯函数供测试）：只收 string/number/boolean 叶值并转字符串；嵌套对象忽略。 */
export function parseConfigJson(raw: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn("[config] config.json 不是合法 JSON，已忽略")
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn("[config] config.json 必须是平铺 JSON 对象，已忽略")
    return {}
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v)
    }
  }
  return out
}

/** 计算应叠加的键（纯函数供测试）：config 中 env 已存在的键跳过（继承环境最高优先）。 */
export function computeOverlay(
  env: NodeJS.ProcessEnv,
  config: Record<string, string>,
): Array<[string, string]> {
  return Object.entries(config).filter(([k]) => env[k] === undefined)
}

/** 读 config.json 并叠加进 env（缺省 process.env）；返回叠加条数；文件缺失/读失败静默 0。 */
export function applyConfigOverlay(env: NodeJS.ProcessEnv = process.env): number {
  const path = configJsonPath(env)
  if (!existsSync(path)) return 0
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return 0
  }
  const overlay = computeOverlay(env, parseConfigJson(raw))
  for (const [k, v] of overlay) env[k] = v
  if (overlay.length > 0) {
    console.log(`[config] config.json 已叠加 ${overlay.length} 项（env/.env 优先）: ${path}`)
  }
  return overlay.length
}
