# qq

QQ Bot 接入层：WebSocket 连接、REST API 封装、消息收发。
代码主体从 sliverp/qqbot 剥离，去除 OpenClaw 依赖。

## 文件

| 文件 | 职责 |
|------|------|
| types.ts | QQ Bot 消息事件和协议类型定义 |
| api.ts | QQ Bot REST API 鉴权+请求封装 (Token singleflight + 后台刷新) |
| gateway.ts | WebSocket Gateway 状态机 (心跳/重连/消息分发) |
| sender.ts | 消息发送 (Markdown格式化 + 分割 + 被动回复) |
