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

## 3. 功能模块

### 3.1 QQ 接入层（`src/qq/`）

| 模块 | 职责 | 关键机制 |
|---|---|---|
| `gateway.ts` | WebSocket 状态机：IDENTIFY→心跳→事件分发→断线 RESUME | 会话/seq 持久化（gateway-state），重启优先 RESUME、seq 回补观测；单活跃连接（QQ 协议约束）；4008 平台限流 60s 官方退避、4914/4915 FATAL 不重连、握手双超时防卡死、命令门表情规范化（faceType 实体 + emoji 字符剥离） |
| `api.ts` | REST 封装：Token 管理、消息发送 | Token singleflight + 后台刷新；401 清缓存重试一次；密钥脱敏日志；429 尊重 Retry-After 退避；`QQ_SANDBOX` 沙箱域切换；C2C typing 输入状态提示 |
| `sender.ts` | 发送管线：Markdown 化、长文分割、被动窗口 | 分条/节流/被动回复窗口（msgId 引用） |
| `media.ts` | 附件下载与注入 | 超时/大小白名单/临时目录清场；语音消息 QQ 内置 ASR 零下载直通转写；≤2MB 图片转 data: URL 供桌面预览 |
| `types.ts` | 协议类型 | — |

### 3.2 OpenCode 对接层（`src/opencode/`）

| 模块 | 职责 | 关键机制 |
|---|---|---|
| `client.ts` | REST 客户端 | V2 API 封装（Basic Auth）：steer prompt、会话 get/move、权限 reply、表单端点、interrupt |
| `runner`（回合运行器） | 回合执行与流式聚合 | `delivery:"steer"` prompt 下发（声明前台在场 → 引擎审批门闭合）→ REST 消息轮询聚合（≈1s 档；SSE 仅承担 permission.asked/mirror/bgWait 通知）→ promptId 锚定回合边界（turnStateOf）→ 同会话串行性由每用户串行队列承担（每用户同时仅一个在途回合；他端并发由引擎 -32603 兜底拦截）→ 同会话新输入接管检测（SupersededError：被打断终态结算 + 完成抢救补投）→ 30min 只通知/24h 硬上限；会话加载携带自身 location.directory（缓存缺失经 REST 解析回填） |
| `sessions.ts` | 用户↔会话映射 | 持久化 `~/.openqq/sessions.json`；目录继承链；/new 一次性继承模型/Agent，切换不继承并回读服务端设置 |
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
| 调度 | 每用户串行；`pendingSelections`（/sessions /model 序号选择，TTL 60s）；首条消息问候；队列完成回执开关制（`QQ_QUEUE_RECEIPTS`，默认关） |
| 回合边界 | prompt API 受理返回 promptId 精确锚定；前台直答/后台等待/补投共用 `turnStateOf` 判定，不依赖"下一条 user 消息"启发式 |
| 后台等待 | `bgWait`：回合转后台后继续等结果（SSE + 1min 轮询兜底，P0-1 收紧自 5min）；停滞提醒（30min 节奏，stallSnapshot 纯函数先取快照再重置，闲置分钟/执行时长跨重启不丢）；后台 15min 进度心跳（BG_HEARTBEAT）；missingIdleDone 完成兜底判定；finalAnswerText 工作稿防误投 |
| 引用上下文 | context-buffer：引用解析 LRU 缓存（QQ 103 内嵌被引内容权威 + 本地缓存兜底）+ 出站回复登记（供"引用 AI 答案"命中） |
| 错误救援 | error-rescue：provider 错误分类（402 余额/401 key 失效）+ 恢复路径话术（/model 切换/桌面更新 key），回合失败不甩原始错误 |
| 审批 | SSE `permission.asked` **即时推送**（裁决前到达）→ 四键卡片（card-approval）→ REST permission reply 结算引擎 deferred（**reject 即 DeclinedError 释放回合，无需额外 cancel**）；真闸来自 steer 前台在场语义；无匹配裁决 fail-closed；拒绝后冲突即告警 |
| 表单/提问 | REST form 端点 + SSE 事件（form-bridge 渲染/回执/台账；question-form 多题问答：跳过 vs 中止语义，30min TTL，旧挂起作废防串线） |
| 镜像 watch | /watch 订阅会话：工具调用/完成摘要实时推送（≥2s 节流合并，主动消息日配额） |
| 媒体出站 | send-media：本地文件按标记发送（路径白名单） |
| 服务健康 | SSE 断线退避重连 + `/status` 服务探活；单进程单连接，无子进程看护面 |

命令面（`commands.ts`）：/new /stop|/cancel（彻底复位：清队列+abort+杀后台等待+结清+drain）/queue（支持 `all` 与裸页码）/ledger（子命令 orphan/rejected/inflight/settled + 尾号详情 + check + settle confirm，支持页码）/progress /status /sessions（带目录切换）/model /agent /rename /history /watch /send /mirror /help。命令门前置表情规范化（faceType 实体 + emoji 字符剥离，剥后形似命令以命令受理）。

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
2. `stage=queued`（或无 sessionId/promptId 且 age 在窗口内）→ 按 enqueuedAt/at 升序重建内存队列；
3. 其余 inflight → `classifyInflight`（查会话历史）：answered→补投并结清；running→重挂后台等待；lost→窗口内重派 / 超窗仅通知；
4. 全部动作写日志 + updatedAt。

**孤儿处置**：孤儿巡检每 60s 扫描；仅新增孤儿且距上次提醒 >10min 发汇总（不刷屏）；修复路径 = /ledger check（自动分类）与 /ledger settle（人工，二次确认）；**禁止静默删除**，所有结清带 settleReason 并留日志。

**官方对齐口径（2026-11-12 P0 考据，基准=tencent-connect 双源 + @tencent-connect/qqbot-nodejs@1.0.5 SDK 源码）**：

- 官方事实标准 = SDK 洋葱中间件链：errorHandler → messageFilter（回声+去重）→ 访问控制（空名单 fail-closed）→ 历史/门控/清洗 → 三层限流 → 斜杠命令 → 待答截获 → **concurrencyGuard** → 引用/附件/信封。`concurrencyGuard` 官方注释明言"同 peer 并发调平台会 500"——同用户串行是官方硬性实践；dsh 选用 merge 策略（忙时缓冲、忙完批量合并为一个 survivor）+ maxQueue 20 + maxProcessingMs
- 同构/超集（审计结论：维持现状）：每用户串行单飞=concurrencyGuard 同构；命令/裁决先于队列=官方 slash/questionAnswer 前置同构；K1/K2 去重=官方 messageFilter（进程内 5s/1000 条）的超集——bot 有重启重派/RESUME 回放长窗（DEF-20261110-2 实证），官方把回合生命周期交宿主 runtime 无此需求；QUEUE_MAX 满员 queue-full 用户可见结算，优于官方默认静默 onDrop；被动窗 5min 与官方群 TTL 一致
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
| sessionId / promptId | 进入的会话 / 锚定回合 | 派生 dispatched/running 判定 |
| state | `inflight`（在途）/ `settled`（已结清） | 主状态，旧代码兼容 |
| stage | `claimed` → `queued` → `dispatched` → `running` → `background` → `settled` | 生命周期阶段，派生视图输入 |
| queueId | 票号（对齐队列 #N，只增不复用） | drop/日志关联 |
| enqueuedAt / updatedAt | 入队时刻 / 最后状态变更时刻 | 重建 FIFO；重启恢复排序 |
| settleReason | 结清原因枚举 | 见下 |
| ownerPid | 受理进程 pid | 跨进程归属诊断（对账判断"原执行进程是否已死"） |
| lastError | 错误摘要（截 200 字） | /ledger 详情与对账 |

**结清原因（settleReason）枚举**：`answered`（已答）/ `queue-full`（排队已满拒入）/ `duplicate-msgid` / `duplicate-intent`（K2 幂等拦截）/ `cancelled`（/cancel 与 /queue clear）/ `dropped`（/queue drop）/ `expired`（超 24h 清账）/ `error`（派发/执行失败）/ `redispatch`（旧账结清、重派新账）/ `manual`（人工 /ledger settle）/ `blocked`（审批挂起未派发早退）/ `superseded`（同会话新输入接管旧回合）。

**台账操作**：落账（claim，含指纹与 attemptId）/ 阶段标记（markStage）/ 结清（settle：msgId + attemptId + 原因，文件锁原子读写）/ 视图导出（listView：派生视图输入）。

**保留策略**：inflight 全留；settled 保留 24h 且最新 20 条；新增字段不参与裁剪。

**结账纪律**：所有退出路径必须结账——/queue drop→dropped；/queue clear 与 /cancel→cancelled（逐条）；drain 失败→error；排队空账（无 sessionId）→清账不重派；禁止静默删除，结清必留日志。

**对账回复契约**（命令路径零模型调用，单条 ≤1800 字符，超出分页）：

- `/queue`：头两行固定三要素（`当前任务：…` / `队列：N/20 · 台账在途：M 条`）；队列逐条 `#票号 · 第M位 · age · 预览 · 状态`；异常区（孤儿/幽灵/最近拒绝）默认各 ≤8 条（`/queue all` 孤儿区放宽至页大小 20）；**空队列但有孤儿时禁止只回"队列：空"**。
- `/queue all`：全量按时间升序，附 msgId/attemptId 尾 6 位 + stage。
- `/ledger`：台账快照分页；子命令 orphan / rejected / `<尾号>` 详情（指纹+stage 时间线+lastError）/ check（逐条 classify 给修复建议）/ settle `<尾号>` confirm（人工结清）。
- `/status`：五行现状 + 一行队列/台账摘要；日志路径 + 最后写入秒数（>5min 显示"日志停滞"）。
- 数字口径固定：`N/20`、`N 条`、`Nm 前`；本地时区；禁用 QQ 不支持的 markdown 表格（`·` 分隔）。

### 3.6 审批与交互

| 组件 | 设计 |
|---|---|
| 审批门 | 引擎侧请求-响应阻塞：工具停在裁决前（deferred）；steer 声明前台在场 → 门闭合；`permission.asked` 经 SSE 即时推送；REST reply 结算（once/always/reject）——**reject 即引擎以 DeclinedError 释放回合**（reply 本身就是释放，无需额外 cancel；同会话挂起请求整批一并 reject）；无匹配裁决 fail-closed（cancelled）；拒绝遇"他端已处理"冲突即告警（不静默）。**权限 REST 全链（list/reply/轮询/延迟闸反查）必须携带会话自身 location 上下文（`x-opencode-directory`），否则命中错误实例仓**（见下行） |
| 权限实例上下文（2026-11-12 引擎 v2.2.6 源码考据定案） | 引擎待审批是 **per-location 实例内存仓**（core/permission.ts pending Map 随 Location 节点实例化）；HTTP 请求 location 上下文解析三规则：`location[directory]` 查询参数 > `x-opencode-directory` 头 > 服务端进程 cwd（server/location.ts requestRef）；`GET /permission/request` 只列**上下文实例**的待审；`GET /session/:id/permission` 由服务端按会话自身实例解析（跨实例天然正确）；桌面端 auto-approve（客户端本地设置）= `permission.asked` 事件驱动毫秒级回 once + 每次连接按目录全仓 sweep 批陈案 | 决定 bot 反查/轮询/回复三调用全部带会话目录；桌面「静默放行」与延迟闸共存是官方既定行为（非缺陷）；SSE 事件全局可达（与 REST 实例化是两条通道，事件信、列表盲的错配即 DEF-qqbot-20261112-1 根因） |
| 审批卡片（card-approval） | 四键（允许一次/总是/拒绝/忽略）+ 文字裁决等价；intent 位 + 互动响应时限；过期按钮拒识；拒绝遇"他端已处理"冲突即告警（不静默） |
| 权限保险网（core/permission.ts） | 裁决等待的兜底：10min 无裁决告警、冲突裁决通知。**弹卡延迟闸 defer 判定反查必须带会话目录**（同实例仍悬置才推；弃推依据 = SSE `permission.replied` 事件 + 同实例反查双保险）；桌面开着时 auto-approve 秒回 → 反查已处置 → 不推卡（与桌面静默放行一致）；桌面关着时请求真悬置 → 反查命中 → QQ 卡接管审批 |
| 表单桥（form-bridge） | REST 表单通道：渲染/回执/台账（form-journal）/孤儿表单作废 |
| 提问（question-form） | 纯函数题库：schema 归一（合并 `*_custom`）、字母/序号/原文/自定义/多选解析；未答语义——可选题跳过（accept 部分答案）、必填题中止（cancel）；30min TTL，旧挂起提问作废防串线 |

### 3.7 投递与渲染（delivery）

| 机制 | 设计 |
|---|---|
| 长文分割 | message-split 按长度切分多气泡 |
| 出站去重 | delivery-dedupe：投递指纹防重发（补投/重挂路径必经） |
| 流式节流 | stream-stagger / reply-limiter（主动消息日配额） |
| 列表平面化 | 行首 `N.␣` → `N、`（仅点号后带空格的行首形态命中；被动通道 100% 保真；代码围栏不动、幂等）+ 纯文本回落 + 提示词约束（QQ_LIST_FORMAT_HINT 随 prompt 注入）三层对策 |
| 受理回执 | 「已收到」开关制（`QQ_ACK_RECEIPT=1` 开启，默认关） |

### 3.8 镜像与通知

`mirror.ts`（摘要镜像订阅）、`linkwatch.ts`（链接/文件监视）、`notify-sink.ts` + `outbox.ts`
（离线通知出队：TTL/日配额/幂等键，bot 不在时也能入队、恢复后送达）。

### 3.9 运维监督

| 模块 | 设计 |
|---|---|
| instance-lock | 单实例锁：尝试模式 / 强制接管（心跳失踪判定）/ 锁 mtime 心跳 / 持锁 60s 自检自杀 |
| bot-control | 生命周期原语：等空闲、在途计数、拉起（杀/停不在此实现，见 §3.9.1） |
| bot-launcher | 运行时探测（bun/node）+ detached 拉起（windowsHide、环境剥离 QQ_*/OPENCODE_*/ALLOWED_USERS，**.env 单点**）；插件 dist 整目录部署 + 哈希对账（版本同一性）；进程内文件日志常开（core/file-log 双写 bot.out.log）；bot 入口解析按安装形态两套候选（插件形态 resolveBotEntry / CLI 形态 resolveInstalledBotEntry，含 dev 源码兜底） |
| discovery | OpenCode 端口自动发现（netstat/ss 三分支+降级，401 诊断"凭据不匹配"） |

#### 3.9.1 杀与重启（系统唯一权威）

**唯一权威 = `superviseOnce`（监督矩阵执行器）**。系统内一切"杀 bot / 拉 bot"只能经由它，不存在第二套杀逻辑。触发入口共三个，全部是它的调用方而非独立实现：

| 入口 | 形态 |
|---|---|
| 计划任务看门狗 | 每 10min `--once`（schtasks 注册，常驻兜底） |
| 插件引导器巡检 | OpenCode 宿主内每 5min（OpenCode 在线时的主通道） |
| `openqq restart [--force]` | 人工/脚本请求式入口，复用同一 grace-kill + spawn 原语与强度约束 |

**监督矩阵（观测 → 动作）**：

| 观测 | 动作 |
|---|---|
| 心跳新鲜 | 不动（绝大多数巡检走这里，零副作用） |
| 无锁 / 锁 pid 已死 | 清锁 → 拉起 |
| pid 活 + 心跳 >5min | 优雅杀：SIGTERM → 等 8s → SIGKILL → **确认死亡才拉** |
| 距上次重启 <2min | 冷却跳过（防多入口互踢、防误杀瞬时态） |
| 15min 内已重启 ≥3 次 | **give-up**：停止循环 + QQ 告警（30min 去抖）——同因反复死亡时上报人工，不当重启永动机 |

**不变约束**：绝不自杀（killPid=自身拒杀）；确认死亡才拉（严禁边杀边拉）；杀不掉（权限/系统级）→ 放弃本轮并留审计；监督者认领锁互斥（多入口不双开）。

**矩阵输入（判活判据）**：心跳文件 5min 未刷新 = 事件循环僵死（缺失≠陈旧：启动中心跳未落盘视为未恢复，不判死，语义等效原 60s 启动宽限）；loop-lag 漂移遥测（>5s 落日志告警）；锁 mtime 30s 心跳独立证锁活性。强度账落盘 `supervisor.json`（重启时间戳滑动窗口）。遗留 `decideWatchdog`/`healOnce` 仅测试引用，生产唯一入口 superviseOnce。

### 3.10 入口、CLI 与插件引导器

- `index.ts`：抢锁→写心跳→401 快速失败（连续 3 次认证被拒即退出释放锁）→连接检查→bridge→gateway；优雅关闭清定时器。
- `openqq-main.ts` → `openqq-cli.js`：请求式重启入口（杀/拉设计见 §3.9.1）；`--force` 跳过等空闲。
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
| 在途台账 | 一切"重启后要记住"的状态落盘；退出路径必须结账 | 内存态即缺陷候选；孤儿/幽灵必须可观测、可修复、禁静默删除 |
| 队列恢复语义 | 重启后 queued 条目重建队列"继续排队"，非重跑 | "重跑一条"会重复副作用；"继续排队"保持用户意图 |
| 回合边界 | promptId 精确锚定（turnStateOf），不依赖消息启发式 | 共享会话里"下一条 user/assistant"启发式必然张冠李戴 |
| 超时语义 | 会话没有超时限，只有弹窗有 TTL：30min 只通知转后台，24h 硬上限兜底 | 长任务合法；误杀长回合会造成 -32603 级联 |
| 审批 fail-closed | 无匹配选项=cancelled；拒绝后显式 cancel；冲突即告警 | 安全底线 |
| 会话归属目录 | 会话 ⇔ location.directory 强绑定；**权限链 REST 兑现「load 携带会话自身目录」：`x-opencode-directory` 头贯穿 list/reply/轮询/延迟闸反查**（映射缓存 directory，缺省回退裸查=服务端 cwd 实例） | 对齐官方会话归属校验；切会话不建孤儿；2026-11-12 实证裸查致项目会话审批全链失明（DEF-qqbot-20261112-1） |
| 完成判定同口径 | turnStateOf 的 text 判据与 finalAnswerText 交付判据必须一致：无 idle 但正文所在消息未完成（`time.completed` 缺失，典型=权限挂起中工具阻塞）= 回合仍在途，不得视为「实质已完」早交 | 2026-11-12 实证：权限挂起回合被 SSE 完成事件误结，交付「无文本产出」假完成（DEF-qqbot-20261112-2）；引擎 step.ended/failed/interrupted 均落 completed，被杀回合不受影响 |
| 官方对齐基准 | 消息队列/入站管道对齐 P0 官方 SDK 中间件链（concurrencyGuard/messageFilter/accessPolicy/rateLimiter）；差异项（merge 合并/单条被动回复帽/urgentPredicate）入学习 backlog，owner 逐项裁定吸收 | 2026-11-12 P0 考据（openclaw-qqbot@8998881 / dsh-qqbot@0ddf232e / qqbot-nodejs@1.0.5 源码）；详见 §3.4「官方对齐口径」 |
| 传输 | **单一传输路径：纯 service 客户端**（与桌面同构）——REST `delivery:"steer"` prompt + SSE 事件订阅（含 permission.asked 即时推送）+ REST 裁决；无 ACP 子进程、无私有服务器 | 引擎审批门=在场语义（steer 前台 / queue 无人值守）；QQ 与桌面共享同一服务的单实例、单事件总线、单数据库，会话天然同步——传输路径多于一条即破坏该模型 |

## 5. 数据与配置

`~/.openqq/`（数据目录，禁止放代码）：`.env`（密钥单点）、`sessions.json`（用户↔会话+目录映射）、
`inflight.json`（在途台账）、`forms.json`、`gateway-state.json`、`supervisor.json`（重启强度账）、
`heartbeat`、`*.lock`、`watchdog.log`、`bot.out.log`（+ 进程内双写；detached 拉起默认 `~/.openqq/openqq.log`，`QQ_LOG_FILE` 可覆盖）、`outbox.json`、`last-discovered.json`。

`.env` 主要键（等号后=缺省口径；完整调优表见 README「环境变量（可选调优）」）：

- 凭据/接入：`QQ_APP_ID` / `QQ_APP_SECRET`、`OPENCODE_BASE_URL`（缺省自动发现）/ `OPENCODE_PASSWORD`、`ALLOWED_USERS`、`QQ_SANDBOX=false`
- 工作区：`QQBOT_DEFAULT_CWD`（缺省=bot 进程 cwd）
- 可调阈值：`QQ_WATCHDOG_INTERVAL_MS=300000`、`QQ_ORPHAN_MS=90000`（合法 5s 至 60min）、`QQ_REDISPATCH_MAX_AGE_MS=7200000`（0=关）、`OPENCODE_TURN_TIMEOUT_MINUTES=30`、`QQ_PERM_DEFER_MS=500`（0 至 10s）、`QQ_ACTIVE_DAILY_LIMIT=100`、`QQ_PASSIVE_RIDE_WINDOW_MS=300000`、`QQ_STREAM_STAGGER_MS=300`
- 开关/路径：`QQ_ACK_RECEIPT`（默认关）、`QQ_QUEUE_RECEIPTS`（默认关）、`QQ_EVENT_PROBE`（默认关）、`QQ_LOG_FILE`（默认 openqq.log）、`QQ_INSTANCE_LOCK`（默认开）

## 6. 部署与验证

- **双通道同源**：`bun run deploy:plugin`（构建→本地 pack→解包进 `~/.config/opencode/plugins/opencode-qqbot/`）；
  npm registry 通道产物逐字节一致。安装态兼容层：OpenCode 2.2.1 全局插件目录扫描器只认根级 exports 目标，
  故解包后覆盖最小 package.json（exports→./index.js）并生成根 index.js shim 转发 dist bundle（deploy 脚本内
  哈希对账跳过这两件）；经 npm plugins 数组安装的用户不受影响。
- **验证门禁**：`bun run verify`（tsc + 全套件）全绿才可提交部署；部署后必复验日志/心跳/台账。
- **日志规范**：结构化 `k=v` 行；队列/台账关键动作固定前缀（`[queue]`/`[journal]`）；文件日志常开 + 轮转。

## 修订记录

| 日期 | 章节 | 内容 | 依据 |
|---|---|---|---|
| 2026-11-12 | §3.4 / §4 | 新增「官方对齐口径」：P0 SDK 中间件链对照（concurrencyGuard 串行/messageFilter 去重/有界队列/被动窗），同构·超集·增强·差异四级分类，差异项入学习 backlog；新增「官方对齐基准」决策行 | openclaw-qqbot@8998881 / dsh-qqbot@0ddf232e / @tencent-connect/qqbot-nodejs@1.0.5 源码考据（快照 %TEMP%\opencode\qqbot-sync\20261112-104047） |
| 2026-11-12 | §3.6 / §4 | 新增「权限实例上下文」考据行（per-location 待审仓 + location 解析三规则 + 桌面 auto-approve 机制）；权限 REST 全链携带 `x-opencode-directory`；延迟闸反查同实例化；新增「完成判定同口径」决策（textCompleted） | DEF-qqbot-20261112-1/2；opencode v2.2.6 源码考据（sst/opencode tag dc2ffcf：core/permission.ts、server/handlers/permission.ts、server/location.ts、app/session/requests/auto-approve.ts、core/session/message-updater.ts） |
