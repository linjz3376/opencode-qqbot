# OpenCode QQ Bot 系统设计文档

> 版本：0.3.15｜更新：2026-11-10｜状态：现行（随代码演进维护）
> 范围：功能模块划分、职责边界、关键机制与设计决策。编码规范见根目录 `AGENTS.md`（架构红线）。

## 1. 系统定位

**QQ 消息 ⇄ OpenCode AI ⇄ QQ 回复** 的桥接服务：让用户通过 QQ（手机/PC）驱动 OpenCode 会话，
与桌面端共享同一份会话数据，是桌面端之外的第二个交互窗口。

设计目标（按优先级）：

1. **可靠**：消息不丢（在途台账 + 重启对账）、进程可自愈（监督矩阵）、单实例不打架。
2. **安全**：审批 fail-closed、密钥不落日志、危险命令真闸。
3. **同构**：QQ 与桌面是同一后端服务的两个客户端，会话数据互通。
4. **可运维**：跨平台（TS/JS only）、可观测（四线日志 + 台账）、可回滚（双通道同源部署）。

## 2. 总体架构

### 2.1 进程模型（双进程 + 单实例铁律）

```
┌────────────────────────── OpenCode 宿主 (serve --service) ─────────────────────────┐
│  插件引导器 opencode-qqbot-plugin.js (plugin-entry.ts)                            │
│    └─ 每 5min 巡检：bot 不活则拉起（superviseOnce，与计划任务互斥）               │
└───────────────────────────────────────────────────────────────────────────────────┘
        ▲ 拉起（detached, windowsHide）                │ HTTP/SSE 127.0.0.1:28894
        │                                              ▼
┌──────────────────────────── bot 独立进程 (openqq-bot.js) ─────────────────────────┐
│ index.ts  启动编排：锁 → 心跳 → 连接检查 → bridge → gateway                        │
│   ├─ bridge.ts        核心桥接（调度/队列/投递/审批/表单/镜像/对账）               │
│   ├─ commands.ts      / 命令面（/new /stop /status /sessions /queue …）           │
│   ├─ qq/              QQ 接入层（gateway 状态机 + REST API + 发送）               │
│   ├─ opencode/        OpenCode 对接层（ACP 传输 + REST 客户端 + SSE + 会话映射）  │
│   └─ core/            领域核心（管道/台账/审批卡片/看门狗/启动器…44 模块）         │
└───────────────────────────────────────────────────────────────────────────────────┘
        ▲ 每 10min 巡检（schtasks → openqq-watchdog.js --once）
┌───────┴──────────────── 外部监督者：监督矩阵 superviseOnce ────────────────────────┐
```

铁律（AGENTS.md 架构红线）：

- **单实例**：任何时刻恰好 1 个 bot 进程。仲裁 = 锁文件 pid（`instance-lock`）；新实例 try 模式发现锁被持即退出。
- **bot 独立存活**：不随 OpenCode 同生共死；OpenCode 不在时由计划任务看门狗兜底拉起。
- **运行时代码只在插件安装目录**：`<plugins>/opencode-qqbot/`（dist 产物 + src）；`~/.openqq/` 只放数据；
  运维代码一律 TS/JS，平台差异仅允许出现在自启注册（schtasks / systemd / launchd）。

### 2.2 分层视图

| 层 | 模块 | 职责一句话 |
|---|---|---|
| 入口/运维 | index.ts、cli/*、plugin-entry.ts | 启动编排、优雅关闭、重启/看门狗/通知/自启 CLI、宿主内巡检 |
| 桥接层 | bridge.ts、commands.ts | 消息调度、队列、投递、审批、表单、镜像、重启对账、命令面 |
| QQ 接入层 | qq/* | Gateway 状态机、REST 鉴权、收发与渲染 |
| OpenCode 层 | opencode/* | ACP 传输、REST 客户端、SSE 事件、会话映射、项目归属 |
| 领域核心 | core/* | 管道、台账、锁、看门狗、审批卡片、表单、媒体、镜像、去重… |

## 3. 功能模块详述

### 3.1 QQ 接入层（`src/qq/`）

| 模块 | 职责 | 关键机制 |
|---|---|---|
| `gateway.ts` | WebSocket 状态机：IDENTIFY→心跳→事件分发→断线 RESUME | 会话/seq 持久化（gateway-state），RESUMED 回补；单活跃连接（QQ 协议约束） |
| `api.ts` | REST 封装：Token 管理、消息发送 | Token singleflight + 后台刷新；401 清缓存重试一次；密钥脱敏日志 |
| `sender.ts` | 发送管线：Markdown 化、长文分割、被动窗口 | 分条/节流/被动回复窗口（msgId 引用） |
| `media.ts` | 附件：QQ 图/语音/文件的下载与注入 | 超时/大小白名单/临时目录清场 |
| `types.ts` | 协议类型 | — |

### 3.2 OpenCode 对接层（`src/opencode/`）

| 模块 | 职责 | 关键机制 |
|---|---|---|
| `acp.ts` | ACP（Agent Client Protocol）传输客户端 | JSON-RPC 行协议；子进程生命周期状态机：exit 清 child/ready（可重启）、initialize 独立握手超时（失败即杀子进程，**不留孤儿**）、stale 守卫防迟到事件误清新传输、未连接请求立即拒绝；fail-closed 权限（无匹配选项=cancelled） |
| `acp-session.ts` | ACP 会话运行器 | 用户↔会话映射、prompt 流式聚合、`promptChain` **同会话串行链**（防 -32603 自撞）、30min 只通知/6h 硬上限、**会话归属目录加载**（load 携带会话自身 location.directory，缓存缺失经 REST 解析回填，-32602 漂移自动校正重试一次） |
| `client.ts` | REST 客户端 | OpenCode V2 API 封装（Basic Auth）；会话 get/move（项目归属补写） |
| `sessions.ts` | 用户↔会话映射管理 | 持久化 `~/.openqq/sessions.json`；目录继承链（新建/切换携带 location.directory）；模型/Agent 回放 |
| `eventstream.ts` | 全局 SSE 订阅 | 单连接、按 sessionID 分流、坏帧容错、退避重连、200KB 缓冲上限 |
| `history.ts` | 历史渲染/脱敏 | 回复文本收集、redactSecrets |
| `mirror.ts` | 镜像摘要 | 会话回合摘要投影 |

### 3.3 桥接层（`src/bridge.ts` ≈100KB，系统中枢）

一条 QQ 消息的主链路：

```
gateway 事件 → inbound-dedupe（指纹去重）→ 命令分流（commands.ts）
  → 队列（message-queue）→ 在途台账落账（inflight-journal）
  → ACP prompt（串行链）→ 流式聚合 → 投递（delivery：分割/去重/节流/渲染）
  → 台账销账 → （超时/重启时）对账补投或重挂后台等待
```

| 功能域 | 机制 |
|---|---|
| 调度与队列 | 每用户串行；排队回执；`pendingSelections`（/sessions /model 序号选择，TTL 60s） |
| 在途台账 | `inflight-journal`：派发落账/终态销账/原子落盘；**重启对账**：已有答案→补投；仍在执行→重挂后台等待（ownerPid 已死时标注"以服务端为准"）；从未到达→窗口内重派 |
| 后台等待 | `bgWait`：回合转后台后继续等结果（SSE + 5min 轮询兜底）；停滞提醒（30min 节奏，stallSnapshot 纯函数先取快照再重置，闲置分钟/执行时长跨重启不丢） |
| 审批 | ACP `session/request_permission` → 四键卡片（card-approval）→ 裁决回 ACP；无匹配选项 fail-closed；拒绝后显式 cancel 释放会话 |
| 表单/提问 | ACP elicitation → 文本多题问答（question-form：schema 归并/字母序号解析/跳过 vs 中止语义，30min TTL）；表单桥（form-bridge）兼容 REST 表单 |
| 投递 | delivery：长文分割、delivery-dedupe（指纹去重防重发）、stream-stagger 节流、reply-limiter 日配额 |
| 镜像 watch | /watch 订阅会话：工具调用/完成摘要实时推送（≥2s 节流合并，主动消息日配额） |
| 媒体出站 | send-media：本地文件按标记发送（路径白名单） |
| 传输选择 | `transport-setting.ts` 持久化 ACP/REST；ACP 传输看门狗 60s 自愈，连续失败 3 次 **exit 42 移交外部监督者** |

命令面（`commands.ts`）：/new /stop|/cancel（彻底复位：清队列+abort+杀后台等待+结清+drain）/queue /ledger /progress /status /sessions（带目录切换）/model /agent /rename /history /watch /send /mirror /help。

### 3.4 领域核心（`src/core/`，按功能分组）

**消息管道**：`message-queue`（每用户队列/恢复）、`queue-view`（对账视图）、`delivery-dedupe`、`inbound-dedupe`、`reply-limiter`、`stream-stagger`、`context-buffer`（引用/引用条上下文）。

**会话与台账**：`inflight-journal`（在途台账+启动对账）、`form-journal`（表单台账）、`gateway-state`（网关 seq 持久化）。

**审批与交互**：`permission.ts`（REST 权限等待/裁决适配）、`card-approval.ts`（审批卡片+按钮回调）、`form-bridge.ts`（REST 表单通道）、`question-form.ts`（纯函数题库）。

**镜像与通知**：`mirror.ts`（摘要镜像订阅）、`linkwatch.ts`（链接/文件监视）、`notify-sink.ts` + `outbox.ts`（离线通知出队，TTL/日配额/幂等键）。

**运维监督**：

| 模块 | 职责 |
|---|---|
| `instance-lock.ts` | 单实例锁：尝试模式/强制接管（心跳失踪判定）/锁 mtime 心跳 |
| `watchdog.ts` | **监督矩阵**（decideSupervise 纯函数 + superviseOnce 执行器）：ok / spawn / grace-kill-spawn（SIGTERM→8s→SIGKILL，**确认死亡才拉**，绝不自杀）/ cooldown(2min) / **give-up(3次/15min) + QQ 告警（30min 去抖）**；监督者认领锁互斥；强度账落盘 |
| `bot-control.ts` | 生命周期：等空闲→停→拉（restartBot）；在途计数 |
| `bot-launcher.ts` | 运行时探测（bun/node）+ detached 拉起（windowsHide、环境剥离 QQ_*/OPENCODE_*/ALLOWED_USERS，**.env 单点**） |
| `discovery.ts` | OpenCode 端口自动发现（netstat/ss 三分支+降级，401 诊断"凭据不匹配"） |
| `watchdog.ts` 心跳阈值 | 心跳 5min 未刷新=事件循环僵死；锁 30s=僵尸锁；启动宽限 60s |

**其他**：`send-media.ts`、`media` 辅助、`error-rescue.ts`（错误分类/兜底文案）、`util.ts`、`file-log.ts`（进程内文件日志双写）。

### 3.5 入口与 CLI（`src/index.ts`、`src/cli/`）

- `index.ts`：抢锁→写心跳（含 loop-lag 事件循环漂移遥测）→401 快速失败（连续 3 次认证被拒即退出释放锁）→连接检查→bridge→gateway；优雅关闭清定时器。
- `openqq-main.ts` → `dist/openqq-cli.js`：`openqq restart [--force]`（等空闲→停→拉）。
- `watchdog-main.ts` → `dist/openqq-watchdog.js`：`--once` / `--loop`（监督矩阵执行入口）。
- `service-main.ts` → 自启注册（win32=schtasks / linux=systemd user / darwin=launchd，三平台生成器纯函数可测）。
- `notify.ts`/`notify-main.ts` → `openqq notify`（出队 QQ 通知，独立可用）。

### 3.6 插件引导器（`src/plugin-entry.ts`）

OpenCode 宿主内的轻量巡检器：每 5min `superviseOnce`（与计划任务互斥）；缺凭据/缺运行时/缺入口按状态变化告警；**unload 绝不碰 bot**（D 路径：插件重载=免费看门狗）。

## 4. 关键设计决策

| 决策 | 内容 | 理由 |
|---|---|---|
| 单实例 + 锁仲裁 | 锁文件 pid 是唯一真相；心跳独立证活 | QQ 网关单活跃连接协议约束；防多实例互踢 |
| 监督矩阵 | 优雅杀/冷却/强度上限/give-up 上报 | OTP intensity + fleet-guard 升级杀 + k8s 误杀教训；不当重启永动机 |
| 在途台账 | 内存态即缺陷候选：一切"重启后要记住"的落盘 | 10-30 重启丢消息事故 |
| 超时语义 | 会话没有超时限，只有弹窗有 TTL：30min 只通知转后台，6h 硬上限兜底 | 长任务合法；误杀长回合曾致 -32603 级联 |
| 审批 fail-closed | ACP 无匹配选项=cancelled；拒绝后显式 cancel 释放 | 安全底线 |
| 会话归属目录 | 会话⇔location.directory 强绑定；load 带会话自身目录 | 对齐官方 ACP getSession 校验；治"切会话误建孤儿" |
| 传输策略 | 当前：ACP 子进程（2.2.6 上唯一实证的真闸）；演进：REST `delivery:"steer"` + 阻塞式审批（上游已修待发）→ 退役 ACP 回归纯客户端 | 见 §6 |

## 5. 数据与配置

`~/.openqq/`（数据目录，禁止放代码）：`.env`（密钥单点）、`sessions.json`（用户↔会话+目录映射）、
`inflight.json`（在途台账）、`forms.json`、`gateway-state.json`、`transport.json`、`supervisor.json`（重启强度账）、
`heartbeat`、`*.lock`、`watchdog.log`、`bot.out.log`、`outbox.json`（通知出队）、`last-discovered.json`。

`.env` 主要键：`QQ_APP_ID/QQ_APP_SECRET`、`OPENCODE_BASE_URL/OPENCODE_PASSWORD`、`ALLOWED_USERS`、
`QQBOT_TRANSPORT`(acp|rest)、`QQBOT_ACP_CWD`、`QQ_WATCHDOG_INTERVAL_MS`、`QQ_LOG_FILE`、`QQ_ACTIVE_DAILY_LIMIT` 等。

## 6. 演进方向（进行中）

1. **传输归一**：上游将 REST 审批改为真阻塞后，bot 退役 ACP 子进程，改为与桌面同构的纯 service 客户端
   （REST + SSE + `delivery:"steer"`），自动同步/单总线/单库一次到位。
2. **同步补偿（过渡）**：REST 镜像写入（synthetic 端点）作为 ACP 期的桌面同步补偿（按需落地）。
3. **运维收敛**：kill/restart 唯一权威收敛至 superviseOnce；`openqq restart` 复用其 grace-kill 原语。
4. **观测强化**：loop-lag 漂移遥测、结构化日志、指标。

## 7. 部署与验证

- **双通道同源**：`bun run deploy:plugin`（构建→本地 pack→解包进 `~/.config/opencode/plugins/opencode-qqbot/`）；
  npm registry 通道产物逐字节一致；发版/升版需当轮显式授权。
- **验证门禁**：`bun run verify`（tsc + 44 套件全绿）才可提交部署；部署后必复验日志/心跳/台账。
- **收尾闭环**：commit+push（精确路径）、AGENTS.md 同步、重启验收、汇报。
