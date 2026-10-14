# src

OpenCode QQ Bot 源码根目录。QQ 消息 -> OpenCode AI -> QQ 回复。

## 文件

| 文件 | 职责 |
|------|------|
| config.ts | 环境变量加载 + 校验 |
| bridge.ts | 核心桥接: QQ 消息 -> OpenCode -> QQ 回复 |
| commands.ts | 命令系统: /new /stop /status /sessions /help /model /agent /rename |
| index.ts | 入口: 启动编排 + 优雅关闭 |

## 子目录

| 目录 | 职责 |
|------|------|
| qq/ | QQ Bot 接入层 (WebSocket + REST API + 消息收发) |
| opencode/ | OpenCode 对接层 (SDK + SSE 事件 + 会话管理) |
