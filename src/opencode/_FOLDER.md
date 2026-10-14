# opencode

OpenCode 对接层：SDK 客户端、SSE 事件路由、会话管理。

## 文件

| 文件 | 职责 |
|------|------|
| client.ts | OpenCode SDK 客户端封装 + 健康检查 |
| events.ts | 全局 SSE 事件订阅 + 按 sessionId 分发 |
| sessions.ts | QQ用户<->OpenCode Session 映射管理 |
