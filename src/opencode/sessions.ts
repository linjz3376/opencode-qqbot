// @input:  ./client (OpencodeClient)
// @output: SessionManager, UserSession
// @pos:    opencode层 - QQ用户<->OpenCode Session 映射管理（持久化到 ~/.openqq/sessions.json）
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { OpencodeClient } from "./client.js"

interface UserSession {
  sessionId: string
  title?: string
  modelId?: string
  providerId?: string
  agentId?: string
}

const STORE_DIR = join(homedir(), ".openqq")
const STORE_FILE = join(STORE_DIR, "sessions.json")

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private client: OpencodeClient

  constructor(client: OpencodeClient) {
    this.client = client
    this.loadSessions()
  }

  // 持久化映射：bot 重启（升级/故障）不再丢失 QQ↔会话绑定
  //（2026-10-13 实测教训：重启清空内存映射 → 用户 QQ 消息落到全新会话，AI 失忆从零探索）。
  private loadSessions(): void {
    try {
      if (!existsSync(STORE_FILE)) return
      // 手工编辑或 PowerShell Out-File 常带 BOM，JSON.parse 会炸——先剥掉
      const raw = readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, "")
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
      if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
      writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(this.sessions), null, 2), "utf8")
    } catch (error) {
      console.error("[sessions] 会话映射持久化失败:", error)
    }
  }

  async getOrCreate(userId: string): Promise<UserSession> {
    const existing = this.sessions.get(userId)
    if (existing) return existing

    const result = await this.client.session.create({})
    const session: UserSession = {
      sessionId: result.data!.id,
      title: result.data!.title,
    }
    this.sessions.set(userId, session)
    this.saveSessions()
    return session
  }

  async createNew(userId: string): Promise<UserSession> {
    const result = await this.client.session.create({})
    const session: UserSession = {
      sessionId: result.data!.id,
      title: result.data!.title,
    }
    this.sessions.set(userId, session)
    this.saveSessions()
    return session
  }

  switchSession(userId: string, sessionId: string, title?: string): void {
    const prev = this.sessions.get(userId)
    const changed = prev?.sessionId !== sessionId
    this.sessions.set(userId, {
      ...prev,
      sessionId,
      title,
    })
    this.saveSessions()
    // 切到别的会话时，把本用户记住的模型/Agent 重放到目标会话
    //（v2 模型是 session 级设置，不跟随 prompt）。
    if (changed) {
      void this.applySettings(userId)
    }
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId)
  }

  // 枚举全部映射（摘要镜像订阅、会话→用户反查用）
  all(): Array<{ userId: string; sessionId: string }> {
    return [...this.sessions.entries()].map(([userId, s]) => ({ userId, sessionId: s.sessionId }))
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

  private async applySettings(userId: string): Promise<void> {
    const s = this.sessions.get(userId)
    if (!s) return
    try {
      if (s.providerId && s.modelId) {
        await this.client.session.setModel({
          path: { id: s.sessionId },
          body: { model: { providerID: s.providerId, id: s.modelId } },
        })
      }
      if (s.agentId) {
        await this.client.session.setAgent({ path: { id: s.sessionId }, body: { agent: s.agentId } })
      }
    } catch (error) {
      // 切会话是主操作，设置重放失败只记日志（目标会话用其自身/默认设置）
      console.error("[sessions] 重放模型/Agent 设置失败:", error)
    }
  }

  getModel(userId: string): { providerId?: string; modelId?: string } {
    const s = this.sessions.get(userId)
    return { providerId: s?.providerId, modelId: s?.modelId }
  }

  getAgent(userId: string): string | undefined {
    return this.sessions.get(userId)?.agentId
  }
}

export type { UserSession }
