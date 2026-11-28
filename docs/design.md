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
│ index.ts  启动编排：锁 → 心跳 → 连接检查 → 角色装配（1..N 个，QQ_BOTS）→ gateway   │
│   ├─ bridge.ts        核心桥接（调度/队列/投递/审批/表单/镜像/对账），每角色一套     │
│   ├─ commands.ts      / 命令面（/new /stop /status /sessions /queue /ledger …）   │
│   ├─ qq/              QQ 接入层（gateway 状态机 + REST API + 发送）               │
│   ├─ opencode/        OpenCode 对接层（REST 客户端 + SSE + 回合运行器 + 会话映射）│
│   └─ core/            领域核心（管道/台账/审批卡片/看门狗/启动器…）                 │
└───────────────────────────────────────────────────────────────────────────────────┘
        ▲ 每 10min 巡检（schtasks → openqq-watchdog.js --once）
┌───────┴──────────────── 外部监督者：监督矩阵 superviseOnce ────────────────────────┐
```

三条铁律（架构红线，违反即返工）：

- **单实例**：任何时刻恰好 1 个 bot 进程。仲裁 = 锁文件 pid（`instance-lock`）；新实例 try 模式发现锁被持即退出；持锁实例 60s 自检（pid 易主/锁消失→自杀），杜绝双 believer 并存。例外（宽进严出）：自检发现 holder pid 存活但锁 mtime 陈旧（疑 PID 复用）时不自杀，交由 stale 强抢接管——宁留残 instance 不误杀良民。
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

### 2.3 隔离模型（角色 × 用户 × 会话三级，2026-11-17 owner 裁定）

> owner 原话为设计硬约束：「全部数据以及队列，至少用户级隔离，可配置用户+会话隔离」。
> 本节是整份文档的隔离权威口径；模块章节出现隔离语义时以本节为准。

**术语**：

- **角色（Role）**：一个 QQ bot 应用身份 = appId。QQ 平台侧完全独立（独立申请/凭据/白名单/连接）。
- **用户（User）**：QQ openid。**openid 按 app 签发**——同一个 QQ 号在不同角色下是两个不相交的用户身份，这是平台语义，是本设计的第一块基石。
- **会话（Session）**：引擎 sessionId；一个用户同一时间绑定一个当前会话（/sessions 可切、/new 可建）。
- **lane**：并发调度与排队的隔离单位，粒度由 `QQ_LANE_SCOPE` 决定（见下）。

**三级隔离矩阵**：

| 层 | 隔离键 | 机制 | 数据落点 | 配置性 |
|---|---|---|---|---|
| 角色 | appId | 独立网关连接、独立 token 槽与 API 底座（沙箱/生产 per role）、独立白名单、独立启动对账；单实例锁本就按 appId 分文件 | `~/.openqq/roles/<appId>/` 物理分目录（§5.1） | `QQ_BOTS` 成员即隔离，不可关闭 |
| 用户 | openid | 会话映射、在途台账、审批挂起、表单日志、日配额、入队票号、问候/观察集合——全部按 userId 分桶 | 角色目录内文件名不变、键 = openid | **恒隔离**（owner 硬要求，fail-closed 白名单是第一道闸） |
| 会话 | (userId, sessionId) | busy 锁、队列 lane、僵尸收割作用范围、入队锚定与出站推送门 | 内存 lane 键，不落盘 | **`QQ_LANE_SCOPE` 可配**（见下） |

**会话隔离两档语义（`QQ_LANE_SCOPE`，行内通用 lock-scope 枚举风格，细→粗；命名依据：peer=QQ 平台官方术语「单关系/concurrencyGuard 按 peer 串行」，session=引擎会话）**：

- `per-session-peer`（缺省，owner 2026-11-14 裁定）：每 (对端,会话) 一条 lane 串行；同用户多会话可并行（引擎本就按会话实例路由、桌面端本就允许多会话并行）；僵尸/长回合只堵所在 lane；入队锚定 sessionId 快照、出站推送门按锚定判定。
- `per-peer`（官方 SDK concurrencyGuard 同构）：每对端（C2C=用户）全局串行——busy 锁/draining/队列 lane 键全部退化为 per-peer；同用户第二个会话的消息排在第一会话回合之后；推送门语义不变（仍锚定=绑定）。供保守部署/对照实验用，不是缺省。

**档位切换影响面清单**（实现 `QQ_LANE_SCOPE` 时逐点核对）：`laneKeyOf/userIdOfLane/sessionIdOfLane`（message-queue）、`busyUsers`/`draining` 键、MessageQueue lane 键与重启重建分 lane、zombie-reaper 的 lane 匹配、queue-view 展示与 `/queue clear|drop` 语义。配置只改 lane **粒度**，不引入也不消除任何跨用户并行。

**不变量（任何档位、任何角色数都成立）**：

1. 用户 A 永不可见/不可操作用户 B 的任何数据（台账/审批/会话/配额/文件）——用户级以下不设任何共享捷径；
2. 角色间数据物理分离——同机单进程亦不共享一个数据文件（`roles/<appId>/` 分桶）；
3. 出站推送门恒按「锚定会话 = 当前绑定」判定，与会话隔离档位无关；
4. lane 串行是 lane **内**保证；档位从 `per-session-peer` 收到 `per-peer` 是收紧并行度，不是放松隔离。

**已知失效模式（设计层承认并观测）**：

- 单进程多角色共享一个事件循环：一角色重度阻塞会拖慢全角色（已有 loop-lag 遥测直出证据）；仅在此物证出现时才有理由拆进程回退为「一进程一角色」。
- 单进程 = 角色同生共死：一个角色未捕获异常带倒全部角色——装配循环按角色隔离 try/catch，单角色启动失败不拖垮其余角色（降级=该角色不在线，日志明示）。
- `QQ_BOTS` 与 legacy 单角色键（`QQ_APP_ID` 等）并存时 `QQ_BOTS` 优先；legacy 键仅作未配 `QQ_BOTS` 的兜底，混用不会产生双角色。
- `/sessions` 列出的是引擎全量会话（共享引擎单用户账号的固有结果）：任一角色可见其他角色/桌面端会话标题并可序号切入——已知风险，owner 2026-11-17 裁定保持现状不加过滤。
- 运维面（watchdog/CLI 探活）按首角色口径实现（readAppId 含 `QQ_BOTS` 首角色回退），全角色逐个探活未实现（§5.1）。

## 3. 功能模块

### 3.1 QQ 接入层（`src/qq/`）

| 模块 | 职责 | 关键机制 |
|---|---|---|
| `gateway.ts` | WebSocket 状态机：IDENTIFY→心跳→事件分发→断线 RESUME | 会话/seq 持久化（gateway-state），重启优先 RESUME、seq 回补观测；单活跃连接（QQ 协议约束）；4008 平台限流 60s 官方退避、4914/4915 FATAL 不重连、握手双超时防卡死、命令门表情规范化（faceType 实体 + emoji 字符剥离） |
| `api.ts` | REST 封装：Token 管理、消息发送 | Token singleflight + 后台刷新；401 清缓存重试一次；密钥脱敏日志；429 尊重 Retry-After 退避；`QQ_SANDBOX` 沙箱域切换；C2C typing 输入状态提示 |
| `sender.ts` | 发送管线：Markdown 化、长文分割、被动窗口 | 分条/节流/被动回复窗口（msgId 引用） |
| `media.ts` | 附件下载与注入 | 超时/大小白名单/临时目录清场；语音消息 QQ 内置 ASR 零下载直通转写；≤2MB 图片转 data: URL 供桌面预览；通用 file 附件按文本/PDF/Office 分流——文本与 Office 提取文本以 `file://` 注入，PDF 原样注入并提示模型能力，legacy OLE Office 明确拒识 |
| `types.ts` | 协议类型 | — |

### 3.2 OpenCode 对接层（`src/opencode/`）

| 模块 | 职责 | 关键机制 |
|---|---|---|
| `client.ts` | REST 客户端 | V2 API 封装（Basic Auth）：steer prompt、会话 get/move、权限 reply、表单端点、interrupt |
| `runner`（回合运行器） | 回合执行与流式聚合 | `delivery:"steer"` prompt 下发（声明前台在场 → 引擎审批门闭合）→ REST 消息轮询聚合（≈1s 档；SSE 仅承担 permission.asked/mirror/bgWait 通知）→ promptId 锚定回合边界（turnStateOf）→ 同会话串行性由每 lane 串行队列承担（lane 粒度见 §2.3，同 lane 同时仅一个在途回合；他端并发由引擎 -32603 兜底拦截）→ 同会话新输入接管检测（SupersededError：被打断终态结算 + 完成抢救补投）→ 30min 只通知/24h 硬上限；会话加载携带自身 location.directory（缓存缺失经 REST 解析回填） |
| `sessions.ts` | 用户↔会话映射 | 持久化 `~/.openqq/sessions.json`；目录继承链；/new 一次性继承模型/Agent，切换不继承并回读服务端设置 |
| `eventstream.ts` | 全局 SSE 订阅 | 单连接、按 sessionID 分流；`permission.asked` 即时推送（裁决前送达）；坏帧容错、退避重连、200KB 缓冲上限 |
| `history.ts` | 历史渲染/脱敏 | 回复文本收集、redactSecrets |
| `mirror.ts` | 镜像摘要投影 | 绑定订阅对账、摘要来源身份、QQ `ref_idx` 回复锚点（机制契约见 §3.8） |

### 3.3 桥接层（`src/bridge.ts`，系统中枢）

一条 QQ 消息的主链路：

```
gateway 事件 → inbound-dedupe（K1/K2 幂等）→ 命令分流（commands.ts）
  → 摘要锚点门（仅摘要引用，先于 steer/入队）→ 队列（message-queue）→ 在途台账落账（inflight-journal）
  → steer prompt（REST，串行链）→ SSE 流式聚合 → 回合边界判定（promptId 锚定，turnStateOf）
  → 投递（delivery：分割/去重/节流/渲染）→ 台账销账
  → 超时/重启时：对账补投 或 重挂后台等待
```

| 功能域 | 机制 |
|---|---|
| 调度 | 每 lane 串行（lane 粒度可配，见 §2.3；DEF-qqbot-20261112-01 修法=官方 per-peer 的会话级细腻化）；`pendingSelections`（/sessions /model 序号选择，TTL 60s）；首条消息问候；队列完成回执开关制（`QQ_QUEUE_RECEIPTS`，默认关） |
| 回合边界 | prompt API 受理返回 promptId 精确锚定；前台直答/后台等待/补投共用 `turnStateOf` 判定，不依赖"下一条 user 消息"启发式 |
| 后台等待 | `bgWait`：回合转后台后继续等结果（SSE + 1min 轮询兜底，P0-1 收紧自 5min）；停滞提醒（30min 节奏，stallSnapshot 纯函数先取快照再重置，闲置分钟/执行时长跨重启不丢）；后台 15min 进度心跳（BG_HEARTBEAT）；missingIdleDone 完成兜底判定；finalAnswerText 工作稿防误投；**流活性监督（2026-11-19 owner 裁定层）：锚定 assistant 最后活动超 `QQ_BG_STREAM_DEAD_MS`（默认 15min）判死回合（running 工具在 `QQ_BG_TOOL_GRACE_MS` 豁免窗内保活、窗外照样判死；死回合与长跑任务在「无进展」信号上同形，BG101A 实证：流停 3s 后 90 分钟假活），判死先 abort 后断点继续；**自动续作（同 owner 裁定：判死后同会话注入新回合重发原 prompt 由模型读历史续作，单任务上限 `QQ_BG_RESUME_MAX`=3 次，次数落盘 resumeCount 重启不洗白，超限 expired 放弃+放行队列）**；**死态二分与去重提示（2026-11-23 owner 裁定）：纯流式死（dead）与死在工具内（dead-tool）均自动续作，dead-tool 续作 prompt 携带 deadToolResumeHint——点名在飞工具并声明其结果未知，模型重做写操作前须先只读核查副作用（查 git log/文件内容）；missingIdleDone 兜底带工具在飞守卫：边界内有 running 工具时不得按「有正文无 idle」误判完成（防健康长工具被交付半截答案）**；**abort 确认硬化（2026-11-25 owner 令）：判死路径捕获 abortConfirmed（成功/失败/异常→失败）并三段留痕（判据/动作/后果，统一日志承载，不占 kills.log 进程专线）——通知随确认态分流（确认成功才说「已中止」，未确认明说「已请求中止（旧进程可能仍在运行）」），未确认时 deadToolResumeHint 追加「先核进程/副作用状态再决定重做写操作」强制条款** |
| 引用上下文 | context-buffer：引用解析 LRU 缓存（QQ 103 内嵌被引内容权威 + 本地缓存兜底）+ 出站回复登记（供"引用 AI 答案"命中）；摘要另以 `ref_idx` 持久化会话锚点，入站锚点门见 §3.8.3 |
| 错误救援 | error-rescue：provider 错误分类（402 余额/401 key 失效）+ 恢复路径话术（/model 切换/桌面更新 key），回合失败不甩原始错误 |
| 审批 | SSE `permission.asked` **即时推送**（裁决前到达）→ 四键卡片（card-approval）→ REST permission reply 结算引擎 deferred（**reject 即 DeclinedError 释放回合，无需额外 cancel**）；真闸来自 steer 前台在场语义；无匹配裁决 fail-closed；拒绝后冲突即告警 |
| 表单/提问 | REST form 端点 + SSE 事件（form-bridge 渲染/回执/台账；question-form 多题问答：跳过 vs 中止语义，30min TTL，旧挂起作废防串线） |
| 观察/镜像 | 开关唯一入口=/status 驾驶舱（`/status watch on|off` / `/status mirror on|off`，owner 2026-11-23 定案）：盯当前绑定会话的工具调用/完成摘要实时推送（≥2s 节流合并，主动消息日配额）；镜像订阅按当前绑定集合幂等对账，摘要带会话身份与回复锚点（§3.8）；/watch /mirror 独立命令已退役（仅留迁移提示），跨会话观察能力正式下线（owner 裁「不用」） |
| 媒体出站 | **主通道=`qq_send_file` 一等工具**（插件经官方 Tools API 注册，JSON Schema+精确错误）：插件宿主写 `~/.openqq/send-requests/` 请求文件，bot 消费器复用 sendLocalFile 全量安全链（白名单/拒识/20MB 上限）发送并回写结果；幂等 dedupeKey 跨重启不重复发；旧 `QQ_SEND_FILE:` 文本标记保留为降级通道（路径白名单同口径） |
| 服务健康 | SSE 断线退避重连 + `/status` 服务探活；单进程单连接，无子进程看护面 |

命令面（`commands.ts`）：/new /cancel（彻底复位：清队列+abort+杀后台等待+结清+drain）/status（驾驶舱：服务器/会话/模型/Agent/观察/镜像/队列/日志；观察与镜像开关唯一入口 `/status watch|mirror on|off`）/queue（支持 `all` 与裸页码；`/queue <文本>`=steer 默认下的显性入队动词，见 §3.4）/ledger（子命令 orphan/rejected/inflight/settled + 尾号详情 + check + settle confirm，支持页码）/progress /sessions（带目录切换）/models /agents（官方复数命名：列表或切换）/rename /history /send /goal（官方目标模式引擎直通 v2.2.1+：设定/查状态/pause/resume/clear；goal-watch 状态变化通知 + kickoff 🎯 归属标记随桥接层推送）/compact /redo /btw（官方引擎命令直通：压缩会话/恢复撤销/侧问）/undo（对齐官方：撤销上一回合并恢复文件，QQ 侧一次性 stage→commit 无暂存窗）/amend（忙时插话并入当前任务，官方 steer 语义）/help。命令门前置表情规范化（faceType 实体 + emoji 字符剥离，剥后形似命令以命令受理）。

### 3.4 消息管道与队列

**受理幂等（inbound-dedupe）**——消息进入系统即建立防线：

| 防线 | 键 | 语义 |
|---|---|---|
| K1 | msgId 原子认领（跨进程文件锁） | 同一 msgId 重复受理 → 静默拒（QQ 重推/重放不产生二次执行） |
| K2 | 内容指纹（稳定尾段随机段） | 窗口内同内容 → 短提示拒；窗口外重投按重发处理 |

**忙时语义（2026-11-23 owner 裁定）**：会话忙时新消息**默认 steer**——以官方 steer 语义并入当前在途回合（引擎注入，不打断执行），并回执「已并入当前任务」；`QQ_BUSY_DEFAULT=queue` 可切回客户端 FIFO 排队旧行为。steer 默认下的**显性入队动词**=`/queue <文本>`：把文本显式排进 FIFO，当前任务跑完后按队列语义执行。附件消息不走 steer（回落排队）。

**队列（message-queue）**：每 lane 一条 FIFO（lane 粒度 = `QQ_LANE_SCOPE`，见 §2.3；owner 2026-11-14 裁定缺省 `per-session-peer` = 官方 per-peer 串行的会话级细腻化），每 lane 上限 20；僵尸/长回合只堵所在 lane。**入队即锚定 sessionId 快照，drain 按锚定会话派发**——排队期间绑定切走，消息仍回锚定会话执行（跟原会话，不跟漂移的绑定）；无绑定消息落 null lane，派发时经 getOrCreate 解析并按解析结果补锁。两条独立语义同时呈现——

| 概念 | 语义 | 复用规则 |
|---|---|---|
| 票号 `#N` | 该用户进程内入队序号，只增不减 | 永不复用（drop/日志/台账关联） |
| 位置 `第M位` | 当前实际排队次序 | 出队/删除后前移 |

入队回执：`已排队 #N（第M位，前面还有 X 条）`；拒绝回执（队列满）固定文案并指向 /queue。

**出站推送门（persona 面单活绑定，owner 2026-11-14 裁定）**：QQ 窗只呈现用户**当前绑定会话**的对话流——一切出站（直答/队列回执/摘要镜像/milestone 观察/审批卡/保险网告警）在投递时校验「锚定会话 = 当前绑定」；绑定已切走 → 本条不推（`[push-gate]` 日志留痕），只能经历史对话/桌面端回读。锚定会话随消息/事件携带（`ctx.anchorSessionId`，入队/派发时快照），门在 deliver 单点实施；审批卡与 nudge 告警走同一门（切走后不推，回合由 30min TTL 自然收尾）。

**入站摘要锚点门（与出站推送门对称）**：已送达的旧摘要不会因切绑而消失，故引用回复必须先以 QQ `ref_msg_idx` 查明摘要来源；来源 ≠ 当前绑定或来源无法证明时 fail-closed 拒绝，禁止默认落到当前绑定，也禁止一次性写入旧会话。判定位置、持久化键与兼容边界见 §3.8.2 至 §3.8.3。

**派生视图（queue-view，`deriveQueueView` 纯函数）**——输入固定（台账条目 + 队列 job + 运行态 + now），输出可复算；不制造新事实，join 键优先级 `msgId > queueId > fingerprint`。

对外 9 个状态（文案唯一）：

| 状态 | 含义 | 判定 |
|---|---|---|
| claimed | 已受理，未入队/派发 | 台账 inflight；不在队列/运行；age ≤ 90s |
| queued | 排队中 | inflight + 在内存队列 |
| dispatched | 已派发，等 prompt 落库 | inflight + 有 sessionId 无 promptId |
| running | 执行中 | inflight + 有 promptId + 该条目会话的 busy lane 命中（每 lane 至多一条；用户多 lane 可并行） |
| background | 后台等待 | bgWaits 命中该 session |
| settled | 已答 | settled + reason=answered |
| rejected | 已拒/作废 | settled + reason ∈ {queue-full, duplicate-msgid, duplicate-intent, cancelled, dropped, expired, error, redispatch, manual, blocked, superseded} |
| orphan | 孤儿 | inflight；不在队列/运行/后台；**从未进过派发级**（claimed/queued；已派发级 stage≥dispatched 永不判孤儿，归 dispatched 并告警——2026-11-05 实证：drain 派发窗口会被误报孤儿刷屏）；age > 90s（`QQ_ORPHAN_MS` 可调） |
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
2. `stage=queued`（或无 sessionId/promptId 且 age 在窗口内）→ 按 (userId, 锚定 sessionId) 分 lane、lane 内按 enqueuedAt/at 升序重建内存队列；
3. 其余 inflight → `classifyInflight`（查会话历史）：answered→补投并结清；running→重挂后台等待；lost→窗口内重派 / 超窗仅通知；
4. 全部动作写日志 + updatedAt。

**孤儿处置**：孤儿巡检每 60s 扫描；仅新增孤儿且距上次提醒 >10min 发汇总（不刷屏）；修复路径 = /ledger check（自动分类）与 /ledger settle（人工，二次确认）；**禁止静默删除**，所有结清带 settleReason 并留日志。

**僵尸收割（zombie-reaper，DEF-qqbot-20261112-02 修法②，owner 2026-11-14 授权「修」）**：收割 busy lane 悬挂态——前台时限（30min 转后台）与 bgWait 自保（进度心跳/停滞提醒/24h giveup）双层都漏过的「lane 持有中、无 bgWait、无完成事件」（11-12 实证 busy 挂 27min）。独立 60s 巡检（`QQ_REAPER_SCAN_SECONDS`）；三级门全判别实验式、宁漏杀勿误杀：①**年龄门**——busy 持续 > `QQ_REAPER_MIN_AGE_MS`（缺省 40min=前台 30min+10min 宽限），台账 updatedAt 60s 内被碰过=有活人照看即跳过；②**引擎探针**——`turnStateOf` 核实（与 bgWait finish 同判据）：回合实已完成 → **L1 收割**：提取终稿补投（delivery 去重天然防双投）+ answered 结清（对齐 rescueThenSettle 语义；完成但无正文=被杀回合 → expired）；③**静默门**——回合未完且会话最后消息静默 > `QQ_REAPER_SILENCE_MS`（缺省 30min；真长任务消息持续落）→ **L2 收割**：单会话 `session.abort` + expired 结清。动作前重验 lane 仍忙+账仍 inflight+同 attemptId（防竞态杀新生回合）；单 tick 至多 1 收、per-lane 冷却 5min；结算幂等、释放 lane 并 drain、QQ 通知留痕。决策核 `core/zombie-reaper.ts` 纯函数可单测。账已不在但 lane 忙=纯悬挂标志（27min 实证形态），直接清锁放行。

**官方对齐口径（2026-11-12 P0 考据，基准=tencent-connect 双源 + @tencent-connect/qqbot-nodejs@1.0.5 SDK 源码）**：

- 官方事实标准 = SDK 洋葱中间件链：errorHandler → messageFilter（回声+去重）→ 访问控制（空名单 fail-closed）→ 历史/门控/清洗 → 三层限流 → 斜杠命令 → 待答截获 → **concurrencyGuard** → 引用/附件/信封。`concurrencyGuard` 官方注释明言"同 peer 并发调平台会 500"——同用户串行是官方硬性实践；dsh 选用 merge 策略（忙时缓冲、忙完批量合并为一个 survivor）+ maxQueue 20 + maxProcessingMs
- 同构/超集（审计结论：维持现状）：官方 concurrencyGuard 按 peer 串行（"同 peer 并发调平台会 500"）；bot 自 2026-11-14（owner 裁定，DEF-qqbot-20261112-01 修法）细化为按 **(用户,会话) lane** 串行——引擎本就按会话实例路由、桌面端本就允许多会话并行，此为官方模型的会话级细腻化，不归差异项；命令/裁决先于队列=官方 slash/questionAnswer 前置同构；K1/K2 去重=官方 messageFilter（进程内 5s/1000 条）的超集——bot 有重启重派/RESUME 回放长窗（DEF-20261110-2 实证），官方把回合生命周期交宿主 runtime 无此需求；QUEUE_MAX 满员 queue-full 用户可见结算，优于官方默认静默 onDrop；被动窗 5min 与官方群 TTL 一致
- 合理增强（纯中继架构必需，官方无对应层）：在途台账/30min 转后台/24h 兜底/supersede 接管/看门狗/启动对账
- 差异项（入学习 backlog，待 owner 裁定是否吸收）：① merge 批量合并（bot 逐条排队，消息洪流 N 连发——吸收会改变"一条消息一回合"的用户语义）；② 单条消息被动回复次数帽（官方 openclaw 取 4 次/1h，bot 仅控日配额+被动窗）；③ urgentPredicate 高优先级跳队（/cancel 语义不同，可借鉴）
- 举一反三盲区扫描结论（裸发 REST 按服务端路由方式分类）：会话域安全（message.ts 全局 Session.Service；session.ts `instances.provide(info)` 按会话实例路由）；表单域安全（引擎有 FormLocationMiddleware 专门按会话路由）；**权限域曾是唯一 ambient 盲区**（引擎未给权限端点对等 middleware）→ 已由 x-opencode-directory 全链携带修复（DEF-qqbot-20261112-1），并建议上游 issue 对齐 FormLocationMiddleware 模式

### 3.5 会话与台账（inflight-journal）

**台账条目定义**（InflightEntry，所有扩展字段可选、向后兼容旧文件）：

| 字段 | 取值/类型语义 | 用途 |
|---|---|---|
| msgId | 消息 ID | 主键；join 键最高优先级 |
| userId / text / at | QQ 用户 / 消息正文（截 300 字）/ 受理时刻 | 基本事实 |
| fingerprint | 内容指纹（稳定尾段随机段） | K2 去重；join 键次优先级 |
| attemptId | 本次受理尝试 ID | 跨进程认领/销账对齐 |
| sessionId / promptId | 进入的会话 / 锚定回合（入队即快照：排队期绑定切走仍回锚定会话——见 §3.4 队列锚定） | 派生 dispatched/running 判定 |
| state | `inflight`（在途）/ `settled`（已结清） | 主状态，旧代码兼容 |
| stage | `claimed` → `queued` → `dispatched` → `running` → `background` → `settled` | 生命周期阶段，派生视图输入 |
| queueId | 票号（对齐队列 #N，只增不复用） | drop/日志关联 |
| enqueuedAt / updatedAt | 入队时刻 / 最后状态变更时刻 | 重建 FIFO；重启恢复排序 |
| settleReason | 结清原因枚举 | 见下 |
| ownerPid | 受理进程 pid | 跨进程归属诊断（对账判断"原执行进程是否已死"） |
| lastError | 错误摘要（截 200 字） | /ledger 详情与对账 |

**结清原因（settleReason）枚举**：`answered`（已答）/ `queue-full`（排队已满拒入）/ `duplicate-msgid` / `duplicate-intent`（K2 幂等拦截）/ `cancelled`（/cancel 与 /queue clear）/ `dropped`（/queue drop）/ `expired`（超 24h 清账）/ `error`（派发/执行失败）/ `redispatch`（旧账结清、重派新账）/ `manual`（人工 /ledger settle）/ `blocked`（安全门拦截未派发：审批挂起早退 / 摘要锚点冲突或未知）/ `superseded`（同会话新输入接管旧回合）。

**台账操作**：落账（claim，含指纹与 attemptId）/ 阶段标记（markStage）/ 结清（settle：msgId + attemptId + 原因，文件锁原子读写）/ 视图导出（listView：派生视图输入）。

**保留策略**：inflight 全留；settled 保留 24h 且最新 20 条；新增字段不参与裁剪。

**结账纪律**：所有退出路径必须结账——/queue drop→dropped；/queue clear 与 /cancel→cancelled（逐条）；drain 失败→error；排队空账（无 sessionId）→清账不重派；禁止静默删除，结清必留日志。

**对账回复契约**（命令路径零模型调用，单条 ≤1800 字符，超出分页）：

- `/queue`：头两行固定三要素（`当前任务：…` / `队列：N/20 · 台账在途：M 条`）；队列逐条 `#票号 · 第M位 · age · 预览 · 状态`；异常区（孤儿/幽灵/最近拒绝）默认各 ≤8 条（`/queue all` 孤儿区放宽至页大小 20）；**空队列但有孤儿时禁止只回"队列：空"**。
- `/queue all`：全量按时间升序，附 msgId/attemptId 尾 6 位 + stage。
- `/ledger`：台账快照分页；子命令 orphan / rejected / `<尾号>` 详情（指纹+stage 时间线+lastError）/ check（逐条 classify 给修复建议）/ settle `<尾号>` confirm（人工结清）。
- `/status`：驾驶舱视图——服务器/会话/模型/Agent/观察/镜像/队列/日志分区；观察与镜像开关唯一入口 `/status watch|mirror on|off`（独立 /watch /mirror 命令已退役，仅留迁移提示）；日志路径 + 最后写入秒数（>5min 显示"日志停滞"）。
- 数字口径固定：`N/20`、`N 条`、`Nm 前`；本地时区；禁用 QQ 不支持的 markdown 表格（`·` 分隔）。

### 3.6 审批与交互

| 组件 | 设计 |
|---|---|
| 审批门 | 引擎侧请求-响应阻塞：工具停在裁决前（deferred）；steer 声明前台在场 → 门闭合；`permission.asked` 经 SSE 即时推送；REST reply 结算（once/always/reject）——**reject 即引擎以 DeclinedError 释放回合**（reply 本身就是释放，无需额外 cancel；同会话挂起请求整批一并 reject）；无匹配裁决 fail-closed（cancelled）；拒绝遇"他端已处理"冲突即告警（不静默）。**权限 REST 全链（list/reply/轮询/延迟闸反查）必须携带会话自身 location 上下文（`x-opencode-directory`），否则命中错误实例仓**（见下行） |
| 权限实例上下文（2026-11-12 引擎 v2.2.6 源码考据定案） | 引擎待审批是 **per-location 实例内存仓**（core/permission.ts pending Map 随 Location 节点实例化）；HTTP 请求 location 上下文解析三规则：`location[directory]` 查询参数 > `x-opencode-directory` 头 > 服务端进程 cwd（server/location.ts requestRef）；`GET /permission/request` 只列**上下文实例**的待审；`GET /session/:id/permission` 由服务端按会话自身实例解析（跨实例天然正确）；桌面端 auto-approve（客户端本地设置）= `permission.asked` 事件驱动毫秒级回 once + 每次连接按目录全仓 sweep 批陈案 | 决定 bot 反查/轮询/回复三调用全部带会话目录；桌面「静默放行」与延迟闸共存是官方既定行为（非缺陷）；SSE 事件全局可达（与 REST 实例化是两条通道，事件信、列表盲的错配即 DEF-qqbot-20261112-1 根因） |
| 审批卡片（card-approval） | 四键（允许一次/总是/拒绝/忽略）+ 文字裁决等价；intent 位 + 互动响应时限；过期按钮拒识；拒绝遇"他端已处理"冲突即告警（不静默）；发卡全链可取消——clearIfResolved/resolve/TTL 记 resolvedRecently，waitForDecision 与 pushExternal 发卡前后复查，sendApprovalCard 在 token 后、QQ API 前按 isCancelled 放弃，防“已处理通知先到、死卡后到” |
| 权限保险网（core/permission.ts） | 裁决等待的兜底：10min 无裁决告警、冲突裁决通知。**弹卡延迟闸 defer 判定反查必须带会话目录**（同实例仍悬置才推；弃推依据 = SSE `permission.replied` 事件 + 同实例反查双保险）；桌面开着时 auto-approve 秒回 → 反查已处置 → 不推卡（与桌面静默放行一致）；桌面关着时请求真悬置 → 反查命中 → QQ 卡接管审批。**死卡竞态防线**：replied/resolve/TTL 除清槽外还记 resolvedRecently，flushPermPush、waitForDecision、pushExternal、sendApprovalCard 全链复查，已在飞发送在 QQ API 前取消；平台无撤回 API，若仍迟到则日志归因且不补文字菜单。**交互监听兜底（12s）用按会话端点 `GET /session/:id/permission`**（引擎按会话实例路由，FormLocationMiddleware 同款；只扫绑定会话——未绑定会话的待审本不推 QQ，零 directory 簿记） |
| 表单桥（form-bridge） | REST 表单通道：渲染/回执/台账（form-journal）/孤儿表单作废 |
| 提问（question-form） | 纯函数题库：schema 归一（合并 `*_custom`）、字母/序号/原文/自定义/多选解析；未答语义——可选题跳过（accept 部分答案）、必填题中止（cancel）；30min TTL，旧挂起提问作废防串线 |

### 3.7 投递与渲染（delivery）

| 机制 | 设计 |
|---|---|
| 长文分割 | message-split 按长度切分多气泡；摘要续片在切分后补受控身份前缀 |
| 分片部分失败 | 已有分片成功后抛出 `PartialReplyError`，禁止骑被动/真主动全文降级；保留原 24h 去重占位防恢复重发，尽力发送「仅部分送达」告警，`deliver=false`；bridge 消费部分失败标记按 error 结清，不再冒称同文去重 |
| 出站去重 | delivery-dedupe：投递指纹防重发（补投/重挂路径必经） |
| 流式节流 | stream-stagger / reply-limiter（主动消息日配额） |
| 列表平面化 | 行首 `N.␣` → `N、`（仅点号后带空格的行首形态命中；被动通道 100% 保真；代码围栏不动、幂等）+ 纯文本回落 + **系统级通道指令**（`session.instructions.entry` 以 key=qq 注入渲染/发文件规则，`<context key=qq>` 块随会话生效、不入用户消息历史；旧引擎降级=context hook，再降级=prompt 正文注入 `QQ_LIST_FORMAT_HINT`）三层对策 |
| 受理回执 | 「已收到」开关制（`QQ_ACK_RECEIPT=1` 开启，默认关） |

### 3.8 镜像与通知

#### 3.8.1 镜像订阅：绑定集合的幂等对账

镜像只跟随**当前绑定**，不恢复跨会话旁听。每角色维护一份订阅表，但其期望状态不是历史会话的累加，而是从当前事实派生：

```
desired = mirrorEnabled ? distinct(sessions.all().sessionId) : ∅
actual  = mirrorUnsubs.keys()
对账 = 取消 actual - desired，补齐 desired - actual；已存在的订阅保持不变
```

- **物理去重**：一个用户至多一个绑定，但多个用户可绑定同一会话；物理监听按 sessionId 去重，投递时仍按 owners 逐用户判定。`/status` 正常仅显示「摘要镜像：开/关」，不展示内部计数；仅期望与实际订阅不一致时追加「订阅对账异常（期望 N / 实际 M）」，完整计数仍在 `[mirror-reconcile]` 日志。
- **触发点**：启动、每次绑定新增/替换/驱逐、镜像开关切换后立即对账；60s 周期对账只作遗漏兜底，不替代绑定变更的同步触发。关闭镜像时 `desired=∅`，必须释放全部监听，而不是直接返回。
- **并发与释放**：对账幂等，重复调用不得重复订阅；仅当某 sessionId 已无任何绑定用户时才取消该物理监听并释放其回调闭包。退订/重订不得立即清洗 `mirroredTurns`、`qqPromptIds` 等逻辑回合幂等与来源身份状态，否则会把已镜像或 QQ 已直答的回合再次推送；这些记录按独立 TTL/LRU 收口，而不是跟随订阅增删。角色停止时清对账定时器并退订全部监听。
- **分层防线**：订阅对账只决定「可能收到哪些事件」；`mirrorTurn` 仍按当前 `sessions.all()` 重算 owners，`deliver` 的推送门再核对「锚定会话 = 当前绑定」。即使取消订阅前已有回调排队，也不会向已切绑用户投递。

#### 3.8.2 摘要身份与回复锚点

摘要卡必须自报身份。首行在现有「桌面问答摘要 / 目标续跑摘要」类型标记后追加**会话标题 + sessionId 短码**，第二行说明「引用回复仅在该会话仍为当前绑定时受理」。标题取服务端会话事实，获取失败时显示「未命名会话」并保留 sessionId 短码，不得因标题失败放弃摘要；标题压成单行，按中文/全角/emoji 2 列、ASCII 1 列计算，最多保留 20 列（10 个中文等效宽度），超出部分以 `...` 收尾；标题与正文同口径脱敏，锚点只保存脱敏后的标题快照。长文拆成多个 QQ 气泡时，每个气泡都可独立作为回复锚点；投递层为续片预留 UTF-8 字节并在切分后添加 `📋 摘要续 · 会话短码` 受控前缀，首片则兼容系统「此前有未能送达的消息」前缀。任一片锚点缺失时都能据受控身份 fail-closed，不得把续片当作普通引用放行。

**锚点协议键必须使用 QQ 引用索引，不得误用消息 ID**：发送成功响应的 `id` 是消息 ID（可用于撤回），`ext_info.ref_idx` 才是机器人消息后续被引用时使用的索引；入站 103 引用事件在 `message_scene.ext` 中以 `ref_msg_idx` 带回。网关归一化层同时兼容官方 `ref_msg_idx` 与存量 `message_reference.message_id`，前者优先，统一写入 `ctx.referencedMsgId`；103 内嵌被引正文只用于 `quoteText`，锚点查询必须独立使用引用索引，不能被内嵌文本短路。锚点表以 `(role, userId, refIdx)` 为实际隔离与查找边界，条目保存：

| 字段 | 语义 |
|---|---|
| `refIdx` | 发送响应的 `ext_info.ref_idx`；入站 `ref_msg_idx` 的 lookup 主键 |
| `messageId` | 发送响应的 `id`；仅诊断/撤回关联，不参与引用 lookup |
| `userId / sessionId` | 摘要接收者 / 摘要来源会话；二者共同约束回复归属 |
| `title / sentAt` | 冲突提示所用的发送时标题快照 / 实际发送成功时刻 |

- **登记时机**：push gate 放行且 QQ 每个分片真实发送成功后，才登记该分片的锚点；发送失败、被去重抑制或被推送门拦截均不得产生锚点。发送管线通过可选 `onSent(receipt)` 回调把每个分片的 `id + ref_idx` 回传镜像层，保留 `deliver` 现有 boolean 受理语义，避免对象返回值被旧调用方误判为 true。
- **持久化**：角色数据目录下 `mirror-anchors.json`，原子写并串行化同角色更新；启动加载，保留 24h、每用户最多 500 条，读写与启动时清理过期/超量项。文件缺失按空表启动，损坏时保留原件供诊断并 fail-closed，不得自动把未知引用当成当前会话。
- **降级**：QQ 未返回 `ref_idx` 或锚点落盘失败时，不重发摘要、不伪报已可路由；记录显式告警。后续引用该摘要按「锚点未知」拒绝，避免无保护回落。

#### 3.8.3 入站锚点门：只允许当前绑定，禁止一次性跨会话写入

摘要引用锚点门位于**命令/待选择项分流之后，忙时 steer、显性 `/queue <文本>` 入队及普通 FIFO 入队之前**，确保任何执行路径都先过同一判定。摘要识别先查锚点；未命中时只检查 QQ 103 **内嵌被引正文**是否以受控摘要类型前缀开头，不能用用户本次新输入的文本来触发或绕过该判定。

| 入站形态 | 判定与动作 |
|---|---|
| 无引用 | 维持现状，以当前绑定建立 `ctx.anchorSessionId` 快照 |
| 引用命中本人有效摘要锚点，且锚定会话 = 当前绑定 | 接受，显式把锚定 sessionId 写入 ctx；后续队列仍按既有锚定快照语义执行 |
| 引用命中本人有效摘要锚点，但锚定会话 ≠ 当前绑定 | **拒绝**：不 steer、不入队、不下发 prompt；提示摘要来源与当前绑定，要求经 `/sessions` 切回后重发 |
| 引用可识别为摘要，但锚点缺失、过期、跨用户或存储不可读 | **fail-closed 拒绝**：提示无法确认来源；用户可去掉引用后明确发送到当前绑定 |
| 非摘要引用 | 保留现有「引用文本作为上下文、发送到当前绑定」语义，不借本功能扩张跨会话路由 |

这里的「当前绑定」专指**该消息入站开始时的 `anchorSid` 快照**，与队列跟随入队锚的既有语义一致；不得在排队后另读实时绑定覆盖此判定。无当前绑定的摘要引用同样拒绝。拒绝回执使用当前绑定锚或无会话锚的控制面上下文，严禁携带旧摘要锚，否则回执自身会被 push gate 拦截。

拒绝时若已建立在途账，以 `blocked` 结清并记录 `lastError=anchor-conflict|anchor-unknown`；K1/K2 幂等仍覆盖平台重推。全局查询/控制命令与序号选择不被旧摘要引用劫持；`/queue <文本>`、`/amend` 等会向会话注入用户输入的入口必须执行同一锚点门。锚点门必须先于 `mirror.beginTurn`、busy lane 占用及任何引擎调用，拒绝后不得遗留 busy/draining/activeIntent 状态。

**不做方案 A（一次性路由到旧摘要会话）**：它会绕过 persona 面单活绑定，且其结果仍会被出站推送门拦截，形成「旧会话已执行、QQ 看不到结果」的静默写操作。锚点门也不自动切换绑定、不引入 follow/旁听。普通消息、非摘要引用、队列锚定、忙时 steer 与出站推送门的既有语义不变。

观测固定前缀：`[mirror-reconcile]`（desired/added/removed/actual）、`[mirror-anchor]`（登记/裁剪/持久化降级）、`[anchor-gate]`（match/conflict/unknown 与脱敏后的双方 sessionId）；不得记录完整引用正文或完整 refIdx。

`linkwatch.ts`（链接/文件监视）、`notify-sink.ts` + `outbox.ts` 负责离线通知出队：TTL/日配额/幂等键，bot 不在时也能入队、恢复后送达。

### 3.9 运维监督

| 模块 | 设计 |
|---|---|
| instance-lock | 单实例锁：尝试模式 / 强制接管（心跳失踪判定）/ 锁 mtime 心跳 / 持锁 60s 自检自杀 |
| bot-control | 生命周期原语：等空闲、在途计数、拉起（杀/停不在此实现，见 §3.9.1） |
| bot-launcher | 运行时探测（bun/node）+ detached 拉起（windowsHide、环境剥离 QQ_*/OPENCODE_*/ALLOWED_USERS，**.env 单点**）；插件 dist 整目录部署 + 哈希对账（版本同一性）；进程内文件日志常开（core/file-log 双写 bot.out.log）；bot 入口解析按安装形态两套候选（插件形态 resolveBotEntry / CLI 形态 resolveInstalledBotEntry，含 dev 源码兜底） |
| discovery | OpenCode 端口自动发现（netstat/ss 三分支+降级，401 诊断"凭据不匹配"） |

#### 3.9.1 杀与重启（系统唯一权威）

**唯一权威 = `superviseOnce`（监督矩阵执行器）**。系统内一切"杀 bot / 拉 bot / 停 bot"只能经由它，不存在第二套杀逻辑。触发入口共五个，全部是它的调用方而非独立实现：

| 入口 | 形态 |
|---|---|
| 计划任务看门狗 | 每 10min `--once`（schtasks 注册，常驻兜底） |
| 插件引导器巡检 | OpenCode 宿主内每 5min（OpenCode 在线时的主通道） |
| `openqq restart [--force]` | 人工/脚本请求式重启，复用同一 grace-kill + spawn 原语与强度约束 |
| `openqq stop [--timeout-min N]` | 人工受控停止：默认等在途空闲，manual-stop 优雅杀后不拉起、不计重启强度账 |
| `openqq service uninstall --stop-bot` | 完整卸载组合：先注销自启，再按同一 manual-stop 停止 bot |

**生命周期语义（防误解）**：bot 独立存活是**故障隔离**能力——OpenCode 重启、插件重载、宿主短时离线不应打断 QQ 消息链路；它不是脱离 OpenCode/用户控制的“游离进程”。三层动作必须分清：插件卸载只移除宿主内引导与巡检，不停止已独立运行的 bot；`service uninstall` 只注销 OS 自启；`openqq stop` / `service uninstall --stop-bot` 才是 bot 的显式生命周期终点。manual-stop 与 manual-restart 一样跳过杀前复核（人工意图即权威），但不被重启强度/冷却拦截，也不把停止计入重启强度账。

**监督者租约（2026-11-25 定稿：channel 优先级 + 时间戳，pid 仅诊断）**：service（计划任务）与 plugin（宿主内巡检）双触发器的归一仲裁。租约文件 `~/.openqq/supervisor-lease.json` 记 `{channel, until, pid}`——pid 仅作诊断，**不参与选主判定**（旧版按 pid 判定致 `--once` 每轮新 pid 自相让贤、5min 任务变 10min 的实证缺陷已修）。

- **优先级恒定 `service > plugin`**：service 租约新鲜（`until > now`）时 plugin 整轮让贤（连 superviseOnce 都不进、零干扰）；service 停摆致租约过期后 plugin 自动接管；service 恢复即抢回（覆盖写租约，无「后占先」态）。
- **同 channel 分形态**：service（`--once` 短进程语义）每轮新 pid 照常续租（覆盖写、pid 仅刷新诊断），5min 节奏不被自身进程轮转稀释；plugin（多引擎并发加载）同 channel 不同 pid 且租约新鲜时让贤，防同通道双监督。
- **fail-open**：租约文件不可写/损坏时放行监督——监督缺失比双触发更糟。
- 与「监督者认领锁互斥（多入口不双开）」的关系：租约管「谁该当值」（去重），认领锁管「同时不双杀」（互斥）——两层互补，不互相替代。

**监督矩阵（观测 → 动作）**：

| 观测 | 动作 |
|---|---|
| 心跳新鲜 | 不动（绝大多数巡检走这里，零副作用） |
| 无锁 / 锁 pid 已死 | 清锁 → 拉起 |
| pid 活 + 心跳 >5min | 优雅杀：SIGTERM → 等 8s → SIGKILL → **确认死亡才拉** |
| 距上次重启 <2min | 冷却跳过（防多入口互踢、防误杀瞬时态） |
| 15min 内已重启 ≥3 次 | **give-up**：停止循环 + QQ 告警（30min 去抖）——同因反复死亡时上报人工，不当重启永动机 |

**不变约束**：绝不自杀（killPid=自身拒杀）；确认死亡才拉（严禁边杀边拉）；杀不掉（权限/系统级）→ 放弃本轮并留审计；监督者认领锁互斥（多入口不双开）。

**矩阵输入（判活判据）**：心跳文件 5min 未刷新 = 事件循环僵死（缺失≠陈旧：启动中心跳未落盘视为未恢复，不判死，语义等效原 60s 启动宽限）；loop-lag 漂移遥测（>5s 落日志告警）；锁 mtime 30s 心跳独立证锁活性。强度账落盘 `supervisor.json`（重启时间戳滑动窗口）；**诛杀决策专线 `kills.log`**（JSONL 机器可解析：判据快照/动作升级链/后果强度账三段——诛杀归因免在全域日志里捞沙，与统一日志同口径轮转）。遗留 `decideWatchdog`/`healOnce` 仅测试引用，生产唯一入口 superviseOnce。

### 3.10 入口、CLI 与插件引导器

- `index.ts`：抢锁→写心跳→401 快速失败（连续 3 次认证被拒即退出释放锁）→连接检查→bridge→gateway；优雅关闭清定时器。
- `openqq-main.ts` → `openqq-cli.js`：请求式重启/停止入口（杀/拉/停设计见 §3.9.1）；restart `--force` 跳过等空闲，stop 默认等空闲。
- `watchdog-main.ts` → `openqq-watchdog.js`：计划任务侧巡检入口（`--once` / `--loop`，设计见 §3.9.1）。
- `service-main.ts`：自启注册（win32=schtasks / linux=systemd user / darwin=launchd，三平台生成器纯函数可测）；经 `openqq-cli service` 子命令路由。
- `notify.ts` → `openqq notify`：通知出队，独立可用。
- `plugin-entry.ts`：宿主内巡检入口（5min 调 superviseOnce，设计见 §3.9.1）；缺凭据/运行时按状态变化告警；**unload 绝不碰 bot**（插件重载=免费看门狗）；内嵌 `QQ_EVENT_PROBE` 事件探针（.env 开关，订阅全量事件落 `~/.openqq/opencode-events.jsonl`，5MB 单代轮转，诊断用）。

## 4. 关键设计决策

| 决策 | 内容 | 理由 |
|---|---|---|
| 单实例 + 锁仲裁 | 锁文件 pid 是唯一真相；心跳独立证活；持锁自检自杀 | QQ 网关单活跃连接协议约束；防多实例互踢与"暗 believer" |
| 受理幂等 K1/K2 | msgId 跨进程原子认领 + 内容指纹窗口去重 | 网关 backlog 重放、消息重推、启动对账重派都必须收敛到"同内容不重复投递" |
| 网关状态持久化 | session/seq 落盘，重启优先 RESUME | 重启 IDENTIFY 失忆会引发 backlog 重放，与幂等/台账叠加成风暴 |
| 杀/重启归一 | 唯一权威与完整机制**只出在 §3.9.1**（superviseOnce：优雅杀+冷却+强度上限+give-up 告警） | kill+spawn 分散多处 = 互杀与边杀边拉的根源；所有重启必须受控 |
| 生命周期边界 | bot 独立存活=故障隔离，不是游离；插件卸载≠bot 停止，`openqq stop` / `service uninstall --stop-bot` 经同一 superviseOnce manual-stop 收尾 | 用户可预期的停止/卸载闭环；防止“插件已删但 bot 仍在跑”的误解 |
| 在途台账 | 一切"重启后要记住"的状态落盘；退出路径必须结账 | 内存态即缺陷候选；孤儿/幽灵必须可观测、可修复、禁静默删除 |
| 队列恢复语义 | 重启后 queued 条目重建队列"继续排队"，非重跑；重建按 (用户,锚定会话) lane 归组 | "重跑一条"会重复副作用；"继续排队"保持用户意图 |
| 会话隔离（DEF-qqbot-20261112-01 修法①） | 队列/忙锁按 (用户,会话) lane；入队锚定 sessionId 快照、drain 按锚定派发；出站推送门=锚定≠当前绑定不推 | 僵尸/长回合只堵所在会话；persona 面单活绑定的出站语义（owner 2026-11-14） |
| 镜像订阅对账 | 期望订阅集=镜像开启时当前绑定 sessionId 的去重集合，关闭时为空；绑定变化即时对账 + 周期兜底 + 投递时 owners/push gate 重核 | 订阅是绑定事实的投影，不是只增不删的历史积累；同会话多绑定用户共享物理监听但不共享投递语义 |
| 摘要回复 fail-closed | 摘要携带会话身份；以发送回执 `ref_idx` 持久化用户×会话锚点；引用回复仅允许锚点=当前绑定，冲突/未知拒绝且不执行 | 旧摘要送达后无法随切绑撤回；一次性跨会话写入会形成被执行但被 push gate 隐去的危险操作 |
| 僵尸收割（DEF-qqbot-20261112-02 修法②） | 引擎核实后的自动清障：已完回合补投+answered、静默回合单会话 abort+expired；动作前重验同 attemptId | 悬挂态无自然 TTL 可等；真人 /cancel 发现=无人值守失败（owner 2026-11-14） |
| 回合边界 | promptId 精确锚定（turnStateOf），不依赖消息启发式 | 共享会话里"下一条 user/assistant"启发式必然张冠李戴 |
| 超时语义 | 会话没有超时限，只有弹窗有 TTL：30min 只通知转后台，24h 硬上限兜底 | 长任务合法；误杀长回合会造成 -32603 级联 |
| 审批 fail-closed | 无匹配选项=cancelled；拒绝后显式 cancel；冲突即告警 | 安全底线 |
| 会话归属目录 | 会话 ⇔ location.directory 强绑定；**权限链 REST 兑现「load 携带会话自身目录」：`x-opencode-directory` 头贯穿 list/reply/轮询/延迟闸反查**（映射缓存 directory，缺省回退裸查=服务端 cwd 实例） | 对齐官方会话归属校验；切会话不建孤儿；2026-11-12 实证裸查致项目会话审批全链失明（DEF-qqbot-20261112-1） |
| 完成判定同口径 | turnStateOf 的 text 判据与 finalAnswerText 交付判据必须一致：无 idle 但正文所在消息未完成（`time.completed` 缺失，典型=权限挂起中工具阻塞）= 回合仍在途，不得视为「实质已完」早交 | 2026-11-12 实证：权限挂起回合被 SSE 完成事件误结，交付「无文本产出」假完成（DEF-qqbot-20261112-2）；引擎 step.ended/failed/interrupted 均落 completed，被杀回合不受影响 |
| 官方对齐基准 | 消息队列/入站管道对齐 P0 官方 SDK 中间件链（concurrencyGuard/messageFilter/accessPolicy/rateLimiter）；差异项（merge 合并/单条被动回复帽/urgentPredicate）入学习 backlog，owner 逐项裁定吸收 | 2026-11-12 P0 考据（openclaw-qqbot@8998881 / dsh-qqbot@0ddf232e / qqbot-nodejs@1.0.5 源码）；详见 §3.4「官方对齐口径」 |
| 传输 | **单一传输路径：纯 service 客户端**（与桌面同构）——REST `delivery:"steer"` prompt + SSE 事件订阅（含 permission.asked 即时推送）+ REST 裁决；无 ACP 子进程、无私有服务器 | 引擎审批门=在场语义（steer 前台 / queue 无人值守）；QQ 与桌面共享同一服务的单实例、单事件总线、单数据库，会话天然同步——传输路径多于一条即破坏该模型 |

## 5. 数据与配置

`~/.openqq/`（数据目录，禁止放代码）：`.env`（密钥单点）、`sessions.json`（用户↔会话+目录映射）、
`inflight.json`（在途台账）、`forms.json`、`gateway-state.json`、`mirror-anchors.json`（摘要回复锚点，24h + 每用户 500 条，见 §3.8.2）、`supervisor.json`（重启强度账）、`supervisor-lease.json`（监督者租约，见 §3.9.1）、`qq-system-instructions.json`（系统级指令模式状态，见 §3.7）、
`heartbeat`、`*.lock`、`watchdog.log`、`kills.log`（诛杀决策专线，见 §3.9.1）、`bot.out.log`（+ 进程内双写；detached 拉起默认 `~/.openqq/openqq.log`，`QQ_LOG_FILE` 可覆盖）、`outbox.json`、`send-requests/`（AI 出站发送请求队列目录，见 §3.3 媒体出站）、`last-discovered.json`。

### 5.1 多角色（单进程多 QQ bot 身份，2026-11-17 owner 裁定）

参考 openclaw-qqbot 具名账号表：`QQ_BOTS`（JSON 数组）配置多个角色，单进程同时挂全部
appId——每角色独立 token 刷新/会话映射/bridge/网关连接/白名单，互不互踢（连接按 appId
独立）。角色运行时数据物理隔离在 `~/.openqq/roles/<appId>/`（台账/审批/表单/配额/
观察/问候/sessions/gateway-state/mirror-anchors），进程级文件（heartbeat/日志/supervisor）保持全局一份。
单实例锁本就按 appId 分文件（`openqq-<appId>.lock`），多角色各持各锁。未配置 `QQ_BOTS`
= legacy 单角色，全部路径与行为零变化。**三级隔离模型与失效模式见 §2.3（隔离权威口径）**。

- 形态：`QQ_BOTS=[{"appId":"…","secret":"…","sandbox":false,"name":"开发角色","allowedUsers":["openid…"]}]`
- 实现要点：token 缓存/API 底座按 appId 分槽（token→appId 反查免全链穿参）；在途台账
  工厂化 `createInflightJournal(file)` 按角色绑定；显式传参替代 AsyncLocalStorage
  （ALS 丢上下文 = 静默写错角色文件，失效模式不可接受）。

`.env` 主要键（等号后=缺省口径；完整调优表见 README「环境变量（可选调优）」）：

- 凭据/接入：`QQ_APP_ID` / `QQ_APP_SECRET`、`OPENCODE_BASE_URL`（缺省自动发现）/ `OPENCODE_PASSWORD`、`ALLOWED_USERS`、`QQ_SANDBOX=false`；多角色时以 `QQ_BOTS`（见 §5.1）为准，上述单角色键仅作 legacy 兜底；`QQ_LANE_SCOPE=per-session-peer|per-peer`（会话隔离粒度，见 §2.3，缺省 `per-session-peer`）
- 工作区：`QQBOT_DEFAULT_CWD`（缺省=bot 进程 cwd）
- 可调阈值：`QQ_WATCHDOG_INTERVAL_MS=300000`、`QQ_ORPHAN_MS=90000`（合法 5s 至 60min）、`QQ_REDISPATCH_MAX_AGE_MS=7200000`（0=关）、`OPENCODE_TURN_TIMEOUT_MINUTES=30`、`QQ_PERM_DEFER_MS=500`（0 至 10s）、`QQ_ACTIVE_DAILY_LIMIT=1000`（默认对齐 QQ 官方单关系日上限 1000 条/天，耗尽拒发并告警一次；测试造小配额用显式小值）、`QQ_ACTIVE_MINUTE_LIMIT=20`（官方分钟限速，滚动窗口等待式节流——超限睡到窗口滑动再发，不触发官方 40034100）、`QQ_PASSIVE_RIDE_WINDOW_MS=300000`、`QQ_STREAM_STAGGER_MS=300`（拼写容错见上行）、`QQ_BG_STREAM_DEAD_MS=900000`（后台流活性监督阈值：锚定 assistant 最后活动超 15min 判死回合——running 工具在豁免窗内保活；判死先 abort 后自动续作（上限 `QQ_BG_RESUME_MAX`，超限才 expired 结清+放行队列）；合法域 1min 至 60min）、`QQ_BG_TOOL_GRACE_MS=3600000`（工具豁免窗：工具执行中 streamed 冻结属健康形态故豁免，但卡死工具 part 也恒 running（BG101A 实证），豁免只保活 60min、窗外照样判死；合法域 5min 至 4h）、`QQ_BG_RESUME_MAX=3`（死回合自动续作次数上限：判死后同会话注入新回合重发原 prompt 由模型读历史续作，重启后按台账 resumeCount 续算不洗白；0=关闭，合法域 0 至 5）、`QQ_REAPER_SCAN_SECONDS=60`、`QQ_REAPER_MIN_AGE_MS=2400000`（僵尸收割年龄门）、`QQ_REAPER_SILENCE_MS=1800000`（僵尸收割静默门）
- 开关/路径：`QQ_BUSY_DEFAULT=steer|queue`（忙时语义，见 §3.4，缺省 steer）、`QQ_ACK_RECEIPT`（默认关）、`QQ_QUEUE_RECEIPTS`（默认关）、`QQ_EVENT_PROBE`（默认关）、`QQ_LOG_FILE`（默认 openqq.log）、`QQ_INSTANCE_LOCK`（默认开）

## 6. 部署与验证

- **双通道同源**：`bun run deploy:plugin`（构建→本地 pack→解包进 `~/.config/opencode/plugins/opencode-qqbot/`）；
  npm registry 通道产物逐字节一致。安装态兼容层：OpenCode 2.2.1 全局插件目录扫描器只认根级 exports 目标，
  故解包后覆盖最小 package.json（exports→./index.js）并生成根 index.js shim 转发 dist bundle（deploy 脚本内
  哈希对账跳过这两件）；经 npm plugins 数组安装的用户不受影响。
- **镜像与锚点回归**：组件测试覆盖期望集增删/幂等、多用户共绑、开关清空、绑定驱逐、标题降级、每分片 `ref_idx` 登记、TTL/LRU、跨用户/跨角色拒识、重启恢复；路由测试必须证明冲突、未知首片及未知续片在普通、忙时 steer、显式入队三条路径均为零引擎调用且台账结清；多分片故障注入必须证明中段失败后无全文重发、已发片锚点保留且同一全文被防重拦截。真实链路至少完成「切绑后桌面回合有摘要」「引用当前摘要可回复」「引用旧摘要不执行且提示可见」「重启后旧锚仍可判定」四例，并以 QQ UI、引擎会话历史、三类新日志和台账互证。
- **验证门禁**：`bun run verify`（tsc + 全套件）全绿才可提交部署；部署后必复验日志/心跳/台账。
- **日志规范**：结构化 `k=v` 行；队列/台账关键动作固定前缀（`[queue]`/`[journal]`）；文件日志常开 + 轮转。

