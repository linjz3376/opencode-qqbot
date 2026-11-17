// @input:  process.env（QQ_DATA_DIR）、appId（可选）
// @output: storageRoot, storageFile, isMultiRole
// @pos:    core - 数据分桶路径解析（多角色隔离的地基）
//
// 多角色改造（2026-11-17，owner 裁定单进程多 bot 身份）：
//   - legacy 单角色：一切数据文件照旧在 ~/.openqq/（零迁移，存量部署行为不变）；
//   - 多角色（QQ_BOTS 配置了 ≥1 个角色）：每个角色的运行时文件落在
//     ~/.openqq/roles/<appId>/ 子目录——gateway-state（RESUME 会话/seq）、
//     inflight 台账、pending-permissions、forms、quota、sessions 映射等
//     按角色物理隔离，杜绝两角色互踩（11-17 实证：135 上两实例共享
//     ~/.openqq 互踩隐患）。
//   - 进程级共享文件不走路由：heartbeat、openqq.log、supervisor 台账、
//     .env 本体、incident.json（引擎侧事故留痕，跨角色一份更合理）。
// 设计取舍：不用 AsyncLocalStorage 隐式传角色——ALS 在个别异步边界丢上下文
// 的失效模式是「静默写错角色的文件」，比显式传参危险；本模块只做纯路径解析，
// 角色归属由调用方显式传入。
import { homedir } from "os"
import { join } from "path"

export const LEGACY_ROOT = join(homedir(), ".openqq")

/**
 * 角色数据根目录。appId 为空 = legacy 根（~/.openqq）。
 * QQ_DATA_DIR env 可整体重定向（测试/容器场景），角色子目录挂在其下。
 */
export function storageRoot(appId?: string): string {
  const base = (process.env.QQ_DATA_DIR ?? "").trim() || LEGACY_ROOT
  return appId ? join(base, "roles", appId) : base
}

/** 角色作用域下的具名数据文件路径。appId 为空时退化为 legacy 路径。 */
export function storageFile(name: string, appId?: string): string {
  return join(storageRoot(appId), name)
}
