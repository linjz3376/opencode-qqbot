// @input:  ./client (OpencodeClient)
// @output: SessionManager, UserSession
// @pos:    opencode层 - QQ用户<->OpenCode Session 映射管理（持久化到 ~/.openqq/sessions.json）
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { homedir } from "os"
import type { OpencodeClient } from "./client.js"

interface UserSession {
  sessionId: string
  title?: string
  modelId?: string
  providerId?: string
  agentId?: string
  /** 项目归属（location.directory）缓存——新建会话继承链的同步来源；由 enforceLocation 回写 */
  directory?: string
}

const STORE_DIR = join(homedir(), ".openqq")
const STORE_FILE = join(STORE_DIR, "sessions.json")

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private client: OpencodeClient
  /** DEF-qqbot-20261112-7：持久化路径可注入——单测必须写临时文件，禁写生产映射
   *  （2026-11-12 实证：session-model/status-title 套件直写 ~/.openqq/sessions.json，
   *    夹具 u1-u4/sid2-4 垃圾入库；多管理器陈旧整图回写还把 owner 绑定顶回去） */
  private readonly storeFile: string

  constructor(client: OpencodeClient, storeFile: string = STORE_FILE) {
    this.client = client
    this.storeFile = storeFile
    this.loadSessions()
  }

  // 持久化映射：bot 重启（升级/故障）不再丢失 QQ↔会话绑定
  //（2026-10-13 实测教训：重启清空内存映射 → 用户 QQ 消息落到全新会话，AI 失忆从零探索）。
  private loadSessions(): void {
    try {
      if (!existsSync(this.storeFile)) return
      // 手工编辑或 PowerShell Out-File 常带 BOM，JSON.parse 会炸——先剥掉
      const raw = readFileSync(this.storeFile, "utf8").replace(/^\uFEFF/, "")
      const parsed = JSON.parse(raw) as Record<string, UserSession>
      for (const [userId, session] of Object.entries(parsed)) {
        if (session?.sessionId) this.sessions.set(userId, session)
      }
      if (this.sessions.size > 0) {
        console.log(`[sessions] 已从磁盘恢复 ${this.sessions.size} 个用户会话映射`)
      }
    } catch (error) {
      console.error("[sessions] 会话映射加载失败（忽略，按全新处理）:", error)
    }
  }

  private saveSessions(): void {
    try {
      const dir = dirname(this.storeFile)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.storeFile, JSON.stringify(Object.fromEntries(this.sessions), null, 2), "utf8")
    } catch (error) {
      console.error("[sessions] 会话映射持久化失败:", error)
    }
  }

  async getOrCreate(userId: string): Promise<UserSession> {
    const existing = this.sessions.get(userId)
    if (existing) return existing

    const directory = this.peekInheritDirectory(userId)
    const result = await this.client.session.create({ location: { directory } })
    const session: UserSession = {
      sessionId: result.data!.id,
      title: result.data!.title,
    }
    this.sessions.set(userId, session)
    this.saveSessions()
    await this.enforceLocation(userId, session.sessionId, directory)
    return session
  }

  async createNew(userId: string): Promise<UserSession> {
    const directory = this.peekInheritDirectory(userId)
    // owner 裁定 2026-11-09：/new 继承「当前会话」的模型/Agent（仅新建这一次性代入；
    // 切换已有会话永不继承——见 switchSession）。
    const prev = this.sessions.get(userId)
    const inheritedModel = prev?.providerId && prev.modelId ? { providerID: prev.providerId, id: prev.modelId } : undefined
    const inheritedAgent = prev?.agentId
    const result = await this.client.session.create({ location: { directory } })
    const session: UserSession = {
      sessionId: result.data!.id,
      title: result.data!.title,
      ...(inheritedModel ? { providerId: inheritedModel.providerID, modelId: inheritedModel.id } : {}),
      ...(inheritedAgent ? { agentId: inheritedAgent } : {}),
    }
    this.sessions.set(userId, session)
    this.saveSessions()
    if (inheritedModel) {
      void this.client.session
        .setModel({ path: { id: session.sessionId }, body: { model: inheritedModel } })
        .catch((error) => console.error("[sessions] 新会话继承模型失败（映射已存）:", error))
    }
    if (inheritedAgent) {
      void this.client.session
        .setAgent({ path: { id: session.sessionId }, body: { agent: inheritedAgent } })
        .catch((error) => console.error("[sessions] 新会话继承 Agent 失败（映射已存）:", error))
    }
    await this.enforceLocation(userId, session.sessionId, directory)
    return session
  }

  // 2026-11-09 对齐官方会话归属校验（引擎 session/load 语义）：
  // 会话与 location.directory 强绑定，load 必须携带会话自己的目录，否则 -32602。
  // 因此切换会话时必须显式携带目标会话的 directory（来自 /sessions 列表的 location）。
  switchSession(userId: string, sessionId: string, title?: string, directory?: string): void {
    const prev = this.sessions.get(userId)
    const changed = prev?.sessionId !== sessionId
    this.sessions.set(userId, {
      ...prev,
      sessionId,
      title,
      // 显式传入的 directory（切换场景，可能跨项目）；undefined=未知，
      // 加载时经 resolveDirectory 从服务端回填，绝不沿用旧会话目录
      directory,
    })
    this.saveSessions()
    // 2026-11-09 owner 裁定（反转 2026-10-29 设计）：切换**不继承**——模型/Agent
    // 是会话级状态（桌面端同语义），不得用本用户在此前会话的偏好覆盖目标会话；
    // 反向从目标会话回读真实设置写回映射（/status 与后续 /model 以目标为准）。
    if (changed) {
      void this.refreshSettingsFromServer(userId)
    }
  }

  /** 切换后回读目标会话的会话级设置（model/agent）写回映射；服务端未设则清空（显示「默认」）。 */
  private async refreshSettingsFromServer(userId: string): Promise<void> {
    const s = this.sessions.get(userId)
    if (!s) return
    try {
      const detail = await this.client.session.get({ path: { id: s.sessionId } })
      const model = detail?.data?.model
      const agent = detail?.data?.agent
      const cur = detail?.data
      if (!cur) return
      if (model?.providerID && model?.id) {
        s.providerId = model.providerID
        s.modelId = model.id
      } else {
        delete s.providerId
        delete s.modelId
      }
      if (typeof agent === "string" && agent) s.agentId = agent
      else delete s.agentId
      this.saveSessions()
    } catch (error) {
      // 回读失败保留旧显示（不阻断切换主操作）
      console.error("[sessions] 回读目标会话设置失败（保留旧映射）:", error)
    }
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId)
  }

  // ===== 项目归属继承链（2026-11-09 缺陷修复：孤儿会话 desktop 不可见）=====
  // 根因：此前 session.create({}) 空体创建 → location.directory 为空 → desktop 端
  // 会话不归任何项目（location 是 desktop 会话列表与配置链、服务加载的单位）。
  // 取值：① 继承当前绑定会话的 location.directory ② 无绑定/继承失败 → 部署默认
  //（QQBOT_DEFAULT_CWD 约定 → bot 进程 cwd）。

  /** 新建会话应继承的项目目录（同步取值：当前绑定详情内缓存优先，缺则默认）。 */
  peekInheritDirectory(userId: string): string {
    const current = this.sessions.get(userId)
    const cached = current?.directory
    if (cached) return cached
    return process.env.QQBOT_DEFAULT_CWD ?? process.cwd()
  }

  /** 创建/接管后强制项目归属（REST 路径共用）：
   *  服务端已带 location 则不动；为空用 move 端点补写 desired（缺省=继承链）。
   *  补写失败只记日志——不阻断会话，但桌面端可见性缺失要在日志可见。 */
  async enforceLocation(userId: string, sessionId: string, desired?: string): Promise<void> {
    const target = desired ?? this.peekInheritDirectory(userId)
    try {
      const detail = await this.client.session.get({ path: { id: sessionId } })
      const dir = detail?.data?.location?.directory
      if (dir) {
        // 顺手把继承值缓存到映射（后续 /new 二次继承不再依赖远端现取）
        const s = this.sessions.get(userId)
        if (s && s.sessionId === sessionId && s.directory !== dir) {
          s.directory = dir
          this.saveSessions()
        }
        return
      }
      await this.client.session.move({ path: { id: sessionId }, body: { directory: target } })
      const s = this.sessions.get(userId)
      if (s && s.sessionId === sessionId) {
        s.directory = target
        this.saveSessions()
      }
      console.log(`[sessions] 会话 ${sessionId} 补写项目归属: ${target}`)
    } catch (error) {
      console.error("[sessions] 项目归属补写失败（会话可用，但桌面端可能不可见）:", error)
    }
  }

  /** 从服务端详情回填目录缓存：目录解析/重试成功后落盘。 */
  cacheDirectory(userId: string, sessionId: string, directory: string): void {
    const s = this.sessions.get(userId)
    if (s && s.sessionId === sessionId && s.directory !== directory) {
      s.directory = directory
      this.saveSessions()
    }
  }

  // 枚举全部映射（摘要镜像订阅、会话→用户反查、interactionTick 权限分仓轮询用）
  all(): Array<{ userId: string; sessionId: string; directory?: string }> {
    return [...this.sessions.entries()].map(([userId, s]) => ({ userId, sessionId: s.sessionId, directory: s.directory }))
  }

  // v2: 模型/agent 是 session 级（/prompt body 会被剥离），必须调 session 端点。
  // 先服务端成功再落本地，避免 /model 显示成功但实际没生效。
  async setModel(userId: string, providerId: string, modelId: string): Promise<void> {
    const s = this.sessions.get(userId)
    if (!s) return
    await this.client.session.setModel({
      path: { id: s.sessionId },
      body: { model: { providerID: providerId, id: modelId } },
    })
    s.providerId = providerId
    s.modelId = modelId
    this.saveSessions()
  }

  async setAgent(userId: string, agentId: string): Promise<void> {
    const s = this.sessions.get(userId)
    if (!s) return
    await this.client.session.setAgent({ path: { id: s.sessionId }, body: { agent: agentId } })
    s.agentId = agentId
    this.saveSessions()
  }

  // （2026-11-09 移除 applySettings：切换即重放已被 owner 裁定废除——
  //   模型/Agent 是会话级状态，覆盖目标会话=破坏其归属；显式 /model /agent 命令
  //   仍直接写当前会话（setModel/setAgent），/new 的继承走 createNew 内置路径。）

  getModel(userId: string): { providerId?: string; modelId?: string } {
    const s = this.sessions.get(userId)
    return { providerId: s?.providerId, modelId: s?.modelId }
  }

  getAgent(userId: string): string | undefined {
    return this.sessions.get(userId)?.agentId
  }
}

export type { UserSession }
