# OpenCode QQ Bot 系统设计文档

> 本文档描述系统的功能模块与设计决策，是设计信息的唯一入口。
> 维护约定：结构或机制变更时同步修订本文；不记录历史台账（时间线、做了/没做、版本迭代）。

## 1. 系统定位与设计目标

**QQ 消息 ⇄ OpenCode AI ⇄ QQ 回复** 的桥接服务：让用户通过 QQ（手机/PC）驱动 OpenCode 会话，
与桌面端共享同一份会话数据，是桌面端之外的第二个交互窗口。

设计目标（按优先级）：

1. **可靠**：消息不丢（在途台账 + 重启对账）、进程可自愈（监督矩阵）、单实例不打架。
2. **安全**：审批 fail-closed、密钥不落日志、危险命令真闸。
3. **同构**：QQ 与桌面是同一后端服务的两个客户端，会话数据互通。
4. **可运维**：跨平台（TS/JS only）、可观测（日志 + 台账 + 派生视图）、可回滚（双通道同源部署）。

## 2. 总体架构

### 2.1 进程模型

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
│   ├─ commands.ts      / 命令面（/new /stop /status /sessions /queue /ledger …）   │
│   ├─ qq/              QQ 接入层（gateway 状态机 + REST API + 发送）               │
│   ├─ opencode/        OpenCode 对接层（REST 客户端 + SSE + 回合运行器 + 会话映射）│
│   └─ core/            领域核心（管道/台账/审批卡片/看门狗/启动器…）                 │
└───────────────────────────────────────────────────────────────────────────────────┘
        ▲ 每 10min 巡检（schtasks → openqq-watchdog.js --once）
┌───────┴──────────────── 外部监督者：监督矩阵 superviseOnce ────────────────────────┐
```

三条铁律（架构红线，违反即返工）：

- **单实例**：任何时刻恰好 1 个 bot 进程。仲裁 = 锁文件 pid（`instance-lock`）；新实例 try 模式发现锁被持即退出；持锁实例 60s 自检（pid 易主/锁消失→自杀），杜绝双 believer 并存。
- **bot 独立存活**：不随 OpenCode 同生共死；OpenCode 不在时由计划任务看门狗兜底拉起。
- **运行时代码只在插件安装目录**：`<plugins>/opencode-qqbot/`（dist 产物 + src）；`~/.openqq/` 只放数据；
  运维代码一律 TS/JS，平台差异仅允许出现在自启注册（schtasks / systemd / launchd）。

### 2.2 分层视图

| 层 | 模块 | 职责一句话 |
|---|---|---|
| 入口/运维 | index.ts、cli/*、plugin-entry.ts | 启动编排、优雅关闭、重启/看门狗/通知/自启 CLI、宿主内巡检 |
| 桥接层 | bridge.ts、commands.ts | 消息调度、队列、投递、审批、表单、镜像、重启对账、命令面 |
| QQ 接入层 | qq/* | Gateway 状态机、REST 鉴权、收发与渲染 |
| OpenCode 层 | opencode/* | REST 客户端、回合运行器、SSE 事件、会话映射、项目归属 |
| 领域核心 | core/* | 管道、台账、锁、看门狗、审批卡片、表单、媒体、镜像、去重 |

## 3. 功能模块

### 3.1 QQ 接入层（`src/qq/`）

| 模块 | 职责 | 关键机制 |
|---|---|---|
| `gateway.ts` | WebSocket 状态机：IDENTIFY→心跳→事件分发→断线 RESUME | 会话/seq 持久化（gateway-state），重启优先 RESUME、seq 回补观测；单活跃连接（QQ 协议约束） |
| `api.ts` | REST 封装：Token 管理、消息发送 | Token singleflight + 后台刷新；401 清缓存重试一次；密钥脱敏日志 |
| `sender.ts` | 发送管线：Markdown 化、长文分割、被动窗口 | 分条/节流/被动回复窗口（msgId 引用） |
| `media.ts` | 附件下载与注入 | 超时/大小白名单/临时目录清场 |
| `types.ts` | 协议类型 | — |

### 3.2 OpenCode 对接层（`src/opencode/`）

| 模块 | 职责 | 关键机制 |
|---|---|---|
| `client.ts` | REST 客户端 | V2 API 封装（Basic Auth）：steer prompt、会话 get/move、权限 reply、表单端点、interrupt |
| `runner`（回合运行器） | 回合执行与流式聚合 | `delivery:"steer"` prompt 下发（声明前台在场 → 引擎审批门闭合）→ SSE 事件流聚合（step/text/tool）→ promptId 锚定回合边界（turnStateOf）→ **同会话串行链**（防并发自撞）→ 30min 只通知/6h 硬上限；会话加载携带自身 location.directory（缓存缺失经 REST 解析回填） |
| `sessions.ts` | 用户↔会话映射 | 持久化 `~/.openqq/sessions.json`；目录继承链；模型/Agent 重放 |
| `eventstream.ts` | 全局 SSE 订阅 | 单连接、按 sessionID 分流；`permission.asked` 即时推送（裁决前送达）；坏帧容错、退避重连、200KB 缓冲上限 |
| `history.ts` | 历史渲染/脱敏 | 回复文本收集、redactSecrets |
| `mirror.ts` | 镜像摘要投影 | — |

### 3.3 桥接层（`src/bridge.ts`，系统中枢）

一条 QQ 消息的主链路：

```
gateway 事件 → inbound-dedupe（K1/K2 幂等）→ 命令分流（commands.ts）
  → 队列（message-queue）→ 在途台账落账（inflight-journal）
  → steer prompt（REST，串行链）→ SSE 流式聚合 → 回合边界判定（promptId 锚定，turnStateOf）
  → 投递（delivery：分割/去重/节流/渲染）→ 台账销账
  → 超时/重启时：对账补投 或 重挂后台等待
```

| 功能域 | 机制 |
|---|---|
| 调度 | 每用户串行；`pendingSelections`（/sessions /model 序号选择，TTL 60s） |
| 回合边界 | prompt API 受理返回 promptId 精确锚定；前台直答/后台等待/补投共用 `turnStateOf` 判定，不依赖"下一条 user 消息"启发式 |
| 后台等待 | `bgWait`：回合转后台后继续等结果（SSE + 5min 轮询兜底）；停滞提醒（30min 节奏，stallSnapshot 纯函数先取快照再重置，闲置分钟/执行时长跨重启不丢） |
| 审批 | SSE `permission.asked` **即时推送**（裁决前到达）→ 四键卡片（card-approval）→ REST permission reply 结算引擎 deferred；真闸来自 steer 前台在场语义；无匹配裁决 fail-closed；拒绝后 REST cancel 释放回合 |
| 表单/提问 | REST form 端点 + SSE 事件（form-bridge 渲染/回执/台账；question-form 多题问答：跳过 vs 中止语义，30min TTL，旧挂起作废防串线） |
| 镜像 watch | /watch 订阅会话：工具调用/完成摘要实时推送（≥2s 节流合并，主动消息日配额） |
| 媒体出站 | send-media：本地文件按标记发送（路径白名单） |
| 服务健康 | SSE 断线退避重连 + `/status` 服务探活；单进程单连接，无子进程看护面 |

命令面（`commands.ts`）：/new /stop|/cancel（彻底复位：清队列+abort+杀后台等待+结清+drain）/queue /ledger /progress /status /sessions（带目录切换）/model /agent /rename /history /watch /send /mirror /help。

### 3.4 消息管道与队列

**受理幂等（inbound-dedupe）**——消息进入系统即建立防线：

| 防线 | 键 | 语义 |
|---|---|---|
| K1 | msgId 原子认领（跨进程文件锁） | 同一 msgId 重复受理 → 静默拒（QQ 重推/重放不产生二次执行） |
| K2 | 内容指纹（稳定尾段随机段） | 窗口内同内容 → 短提示拒；窗口外重投按重发处理 |

**队列（message-queue）**：每用户 FIFO，上限 20；两条独立语义同时呈现——

| 概念 | 语义 | 复用规则 |
|---|---|---|
| 票号 `#N` | 该用户进程内入队序号，只增不减 | 永不复用（drop/日志/台账关联） |
| 位置 `第M位` | 当前实际排队次序 | 出队/删除后前移 |

入队回执：`已排队 #N（第M位，前面还有 X 条）`；拒绝回执（队列满）固定文案并指向 /queue。

**派生视图（queue-view，`deriveQueueView` 纯函数）**——输入固定（台账条目 + 队列 job + 运行态 + now），输出可复算；不制造新事实，join 键优先级 `msgId > queueId > fingerprint`。

对外 9 个状态（文案唯一）：

| 状态 | 含义 | 判定 |
|---|---|---|
| claimed | 已受理，未入队/派发 | 台账 inflight；不在队列/运行；age ≤ 90s |
| queued | 排队中 | inflight + 在内存队列 |
| dispatched | 已派发，等 prompt 落库 | inflight + 有 sessionId 无 promptId |
| running | 执行中 | inflight + 有 promptId + busyUsers 命中 |
| background | 后台等待 | bgWaits 命中该 session |
| settled | 已答 | settled + reason=answered |
| rejected | 已拒/作废 | settled + reason ∈ {queue-full, duplicate-*, cancelled, dropped, expired, error, manual} |
| orphan | 孤儿 | inflight；不在队列/运行/后台；age > 90s（`QQ_ORPHAN_MS` 可调） |
| ghost | 幽灵 | 在队列但台账无 inflight（违例，必须显示） |

计算顺序：队列逐条（台账有→queued / 无→ghost）→ 台账 inflight 逐条（busy 命中→running；bgWaits→background；超阈→orphan；否则→claimed）→ 最近拒绝（30min 内）→ 不变量校验。

不变量（每次计算校验并展示违例）：

| # | 不变量 |
|---|---|
| I1 | 队列每条 job 都能在台账找到 inflight（否则 ghost） |
| I2 | 每条 inflight 必属 queued/running/background/claimed/orphan 之一 |
| I3 | settled 不得出现在队列 |
| I4 | 队列长度 ≤ 上限；票号单调唯一 |
| I5 | 队列顺序 = 入队顺序 |
| I6 | `at` 不得晚于 now；`updatedAt` 不得早于 `at` |

**重启恢复顺序**（队列语义 = 继续排队，不是重跑）：

1. 读台账取 inflight；
2. `stage=queued`（或无 sessionId/promptId 且 age 在窗口内）→ 按 enqueuedAt/at 升序重建内存队列；
3. 其余 inflight → `classifyInflight`（查会话历史）：answered→补投并结清；running→重挂后台等待；lost→窗口内重派 / 超窗仅通知；
4. 全部动作写日志 + updatedAt。

**孤儿处置**：孤儿巡检每 60s 扫描；仅新增孤儿且距上次提醒 >10min 发汇总（不刷屏）；修复路径 = /ledger check（自动分类）与 /ledger settle（人工，二次确认）；**禁止静默删除**，所有结清带 settleReason 并留日志。

### 3.5 会话与台账（inflight-journal）

**台账 schema**（字段均可选，向后兼容）：

```ts
interface InflightEntry {
  msgId; userId; sessionId?; text; at; fingerprint; attemptId;
  state: "inflight" | "settled"
  stage?: "claimed" | "queued" | "dispatched" | "running" | "background" | "settled"
  queueId?: number        // 票号，对齐队列 #id
  enqueuedAt?: number     // 重建 FIFO 用
  updatedAt?: number
  settleReason?: "answered" | "queue-full" | "duplicate-msgid" | "duplicate-content"
               | "cancelled" | "dropped" | "expired" | "error" | "redispatch" | "manual"
  ownerPid?: number       // 跨进程归属（诊断）
  lastError?: string      // 截 200 字
}
```

**API**：`claimInflightDetailed`（落账）/`markInflightStage`/`settleInflight(msgId, attemptId?, reason?)`/`listInflightView`。
**保留策略**：inflight 全留；settled 保留 24h 且最新 20 条。
**结账纪律**：所有退出路径必须结账——`/queue drop`→dropped、`/queue clear` 与 `/cancel`→cancelled（逐条）、drain 失败→error、排队空账（无 sessionId）→清账不重派。

**对账回复契约**（命令路径零模型调用，单条 ≤1800 字符，超出分页）：

- `/queue`：头行固定三要素（当前任务 / 队列占用 N/20 / 台账在途）；队列逐条 `#票号 · 第M位 · age · 预览 · 状态`；异常区（孤儿/幽灵/最近拒绝）各 ≤8 条；**空队列但有孤儿时禁止只回"队列：空"**。
- `/queue all`：全量按时间升序，附 msgId/attemptId 尾 6 位 + stage。
- `/ledger`：台账快照分页；子命令 orphan / rejected / `<尾号>` 详情（指纹+stage 时间线+lastError）/ check（逐条 classify 给修复建议）/ settle `<尾号>` confirm（人工结清）。
- `/status`：五行现状 + 一行队列/台账摘要；日志路径 + 最后写入秒数（>5min 显示"日志停滞"）。
- 数字口径固定：`N/20`、`N 条`、`Nm 前`；本地时区；禁用 QQ 不支持的 markdown 表格（`·` 分隔）。

### 3.6 审批与交互

| 组件 | 设计 |
|---|---|
| 审批门 | 引擎侧请求-响应阻塞：工具停在裁决前（deferred）；steer 声明前台在场 → 门闭合；`permission.asked` 经 SSE 即时推送；REST reply 结算（once/always/reject）；无匹配裁决 fail-closed（cancelled）；拒绝后 REST cancel 释放回合 |
| 审批卡片（card-approval） | 四键（允许一次/总是/拒绝/忽略）+ 文字裁决等价；intent 位 + 互动响应时限；过期按钮拒识；拒绝遇"他端已处理"冲突即告警（不静默） |
| 权限保险网（core/permission.ts） | 裁决等待的兜底：10min 无裁决告警、冲突裁决通知 |
| 表单桥（form-bridge） | REST 表单通道：渲染/回执/台账（form-journal）/孤儿表单作废 |
| 提问（question-form） | 纯函数题库：schema 归一（合并 `*_custom`）、字母/序号/原文/自定义/多选解析；未答语义——可选题跳过（accept 部分答案）、必填题中止（cancel）；30min TTL，旧挂起提问作废防串线 |

### 3.7 投递与渲染（delivery）

| 机制 | 设计 |
|---|---|
| 长文分割 | message-split 按长度切分多气泡 |
| 出站去重 | delivery-dedupe：投递指纹防重发（补投/重挂路径必经） |
| 流式节流 | stream-stagger / reply-limiter（主动消息日配额） |
| 列表平面化 | `N.` → `N、`（被动通道 100% 保真；代码围栏不动、幂等）+ 纯文本回落 + 提示词约束三层对策 |
| 受理回执 | 「已收到」开关制（`QQ_ACK_RECEIPT=1` 开启，默认关） |

### 3.8 镜像与通知

`mirror.ts`（摘要镜像订阅）、`linkwatch.ts`（链接/文件监视）、`notify-sink.ts` + `outbox.ts`
（离线通知出队：TTL/日配额/幂等键，bot 不在时也能入队、恢复后送达）。

### 3.9 运维监督

| 模块 | 设计 |
|---|---|
| instance-lock | 单实例锁：尝试模式 / 强制接管（心跳失踪判定）/ 锁 mtime 心跳 30s / 持锁 60s 自检自杀 |
| watchdog（监督矩阵） | `decideSupervise` 纯函数 + `superviseOnce` 执行器：ok / spawn / grace-kill-spawn（SIGTERM→8s→SIGKILL，**确认死亡才拉**，绝不自杀）/ cooldown(2min) / **give-up（3 次/15min）+ QQ 告警（30min 去抖）**；监督者认领锁互斥（插件引导器 × 计划任务不双开）；强度账落盘 supervisor.json |
| 心跳判据 | 心跳 5min 未刷新 = 事件循环僵死（启动宽限 60s）；loop-lag 漂移遥测（>5s 告警） |
| bot-control | 生命周期原语：等空闲、在途计数、拉起；杀/停一律委托 superviseOnce 的 grace-kill（确认死亡才拉） | 见 §4"杀/重启权威" |
| bot-launcher | 运行时探测（bun/node）+ detached 拉起（windowsHide、环境剥离 QQ_*/OPENCODE_*/ALLOWED_USERS，**.env 单点**）；插件 dist 整目录部署 + 哈希对账（版本同一性）；进程内文件日志常开（core/file-log 双写 bot.out.log） |
| discovery | OpenCode 端口自动发现（netstat/ss 三分支+降级，401 诊断"凭据不匹配"） |

### 3.10 入口、CLI 与插件引导器

- `index.ts`：抢锁→写心跳→401 快速失败（连续 3 次认证被拒即退出释放锁）→连接检查→bridge→gateway；优雅关闭清定时器。
- `openqq-main.ts` → `openqq-cli.js`：`openqq restart [--force]`（等空闲→停→拉）。
- `watchdog-main.ts` → `openqq-watchdog.js`：`--once` / `--loop`（监督矩阵执行入口）。
- `service-main.ts`：自启注册（win32=schtasks / linux=systemd user / darwin=launchd，三平台生成器纯函数可测）。
- `notify.ts` → `openqq notify`：通知出队，独立可用。
- `plugin-entry.ts`：OpenCode 宿主内轻量巡检器（5min superviseOnce；缺凭据/运行时按状态变化告警；**unload 绝不碰 bot**——插件重载=免费看门狗）。

## 4. 关键设计决策

| 决策 | 内容 | 理由 |
|---|---|---|
| 单实例 + 锁仲裁 | 锁文件 pid 是唯一真相；心跳独立证活；持锁自检自杀 | QQ 网关单活跃连接协议约束；防多实例互踢与"暗 believer" |
| 受理幂等 K1/K2 | msgId 跨进程原子认领 + 内容指纹窗口去重 | 网关 backlog 重放、消息重推、启动对账重派都必须收敛到"同内容不重复投递" |
| 网关状态持久化 | session/seq 落盘，重启优先 RESUME | 重启 IDENTIFY 失忆会引发 backlog 重放，与幂等/台账叠加成风暴 |
| 监督矩阵 | 优雅杀/冷却/强度上限/give-up 上报 | 重启必须受控：同因反复死亡时停止循环并通知操作者，而不是当永动机 |
| 在途台账 | 一切"重启后要记住"的状态落盘；退出路径必须结账 | 内存态即缺陷候选；孤儿/幽灵必须可观测、可修复、禁静默删除 |
| 队列恢复语义 | 重启后 queued 条目重建队列"继续排队"，非重跑 | "重跑一条"会重复副作用；"继续排队"保持用户意图 |
| 回合边界 | promptId 精确锚定（turnStateOf），不依赖消息启发式 | 共享会话里"下一条 user/assistant"启发式必然张冠李戴 |
| 超时语义 | 会话没有超时限，只有弹窗有 TTL：30min 只通知转后台，6h 硬上限兜底 | 长任务合法；误杀长回合会造成 -32603 级联 |
| 审批 fail-closed | 无匹配选项=cancelled；拒绝后显式 cancel；冲突即告警 | 安全底线 |
| 会话归属目录 | 会话 ⇔ location.directory 强绑定；load 携带会话自身目录 | 对齐官方会话归属校验；切会话不建孤儿 |
| 传输 | **单一传输路径：纯 service 客户端**（与桌面同构）——REST `delivery:"steer"` prompt + SSE 事件订阅（含 permission.asked 即时推送）+ REST 裁决；无 ACP 子进程、无私有服务器 | 引擎审批门=在场语义（steer 前台 / queue 无人值守）；QQ 与桌面共享同一服务的单实例、单事件总线、单数据库，会话天然同步——传输路径多于一条即破坏该模型 |
| 杀/重启权威 | **唯一权威 = superviseOnce（监督矩阵）**；`openqq restart` 降级为请求式入口，复用同一 grace-kill 原语（确认死亡才拉），不设第二套杀逻辑 | kill+spawn 分散多处 = 互杀与边杀边拉的根源；所有重启受冷却/强度/give-up 约束 |

## 5. 数据与配置

`~/.openqq/`（数据目录，禁止放代码）：`.env`（密钥单点）、`sessions.json`（用户↔会话+目录映射）、
`inflight.json`（在途台账）、`forms.json`、`gateway-state.json`、`supervisor.json`（重启强度账）、
`heartbeat`、`*.lock`、`watchdog.log`、`bot.out.log`（+ 进程内双写）、`outbox.json`、`last-discovered.json`。

`.env` 主要键：`QQ_APP_ID/QQ_APP_SECRET`、`OPENCODE_BASE_URL/OPENCODE_PASSWORD`、`ALLOWED_USERS`、
`QQBOT_DEFAULT_CWD`、`QQ_WATCHDOG_INTERVAL_MS`、`QQ_ORPHAN_MS`、`QQ_ACK_RECEIPT`、
`QQ_LOG_FILE`、`QQ_ACTIVE_DAILY_LIMIT`、`QQ_EVENT_PROBE`。

## 6. 部署与验证

- **双通道同源**：`bun run deploy:plugin`（构建→本地 pack→解包进 `~/.config/opencode/plugins/opencode-qqbot/`）；
  npm registry 通道产物逐字节一致。
- **验证门禁**：`bun run verify`（tsc + 全套件）全绿才可提交部署；部署后必复验日志/心跳/台账。
- **日志规范**：结构化 `k=v` 行；队列/台账关键动作固定前缀（`[queue]`/`[journal]`）；文件日志常开 + 轮转。
