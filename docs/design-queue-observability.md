# 队列与台账可观测性设计（reply-first）

- 状态：**已实现**（P0+P1 交付于 commit `e2a8854`；本文档保留为设计依据）
- 现行结构总览见 `docs/design.md` §3.3/§3.4；个别实现细节以现行代码为准（日志落点已演进为 `bot.out.log` + 进程内文件日志双写；P2 指标导出未实施）
- 日期：2026-11-05
- 范围：`C:\Users\linjz\dev\opencode-qq-bot`
- 关联实证：队列测试1–20（2026-11-05 19:37–19:44）

## 0. 一句话结论

现在缺的不是"再加一行 /queue 文案"，而是**一套可复算的派生状态 + 一个能对账的台账 + 每条异常一个修复命令**。设计目标：任意时刻发一条消息，回复就能回答四个问题——**谁在跑、谁在等、谁没答、哪里坏了**。

---

## 1. 本次实证：为什么现有回复读不懂

### 1.1 四方对账（已取证）

| 事实源 | 观测结果 |
|---|---|
| `~/.openqq/inflight.json` | 42 条：20 settled / 22 inflight。队列测试1–19 于 19:37:06–19:37:09 受理，`state=inflight`，`sessionId=""`、`promptId=""`，至今未结 |
| 内存队列（`MessageQueue`） | 无外部可读接口；`/queue` 是唯一出口，且只读内存 |
| OpenCode 会话历史（`session_message`, `ses_e54897614ffelRcuPzhBA9iyvm`） | 只有 `队列测试20`（19:44:03）与 `状态检查-20261105-1955`（20:06:05）；**队列测试1–19 从未到达** |
| 运行态 | 19:44:10 该回合已 `idle`；`bun` PID 30696 自 17:57:52 未重启 |

### 1.2 由此确定的三件事

1. `队列测试20` 首投（19:37:12）settled 且无 `promptId` → 命中 `QUEUE_MAX=20` 的"排队已满"拒绝路径（bridge.ts:705–709）。
2. `队列测试1–19` 属于**孤儿在途**：台账认领了，但既不在内存队列、也不在运行、也没进会话。19:44:10 回合结束后 drain 没有把它们捞起来。
3. 现有 `/queue` 在这种状态下会回"当前任务：空闲 / 队列：空"，与台账 19 条在途完全矛盾——**用户从回复里读不到真相**。

### 1.3 根因的首要假设（待验证，不写死）

`delivery-dedupe.json` 在 19:42:23 有一条出站投递记录，与 `/cancel`（`handleStop`：清内存队列 + abort 会话）的时间高度吻合；`/cancel` 的 `queue.clear()` **不会结清台账**。若成立，链路是：

```
19:37  19 条入队（台账 inflight）
19:42  /cancel → 内存队列清空，台账 19 条仍 inflight
19:44  队列测试20 作为新消息直接执行（队列已空）
19:44:10 回合 idle → drain 无对象可捞
20:06  状态检查 → /queue 只会回"队列：空"
```

待验证项：19:42:23 投递内容、`/cancel` 是否有独立日志。无论成立与否，本设计保证：**这类状态以后一定能从一条回复里看出来，并且能一条命令修掉**。

---

## 2. 设计目标与非目标

### 目标

| 编号 | 目标 | 判据 |
|---|---|---|
| G1 | 一条回复回答四问 | `/queue` 同时给出：运行中 / 排队 / 在途 / 孤儿 / 最近拒绝 |
| G2 | 可复算 | 派生状态由纯函数计算，输入固定，结果可单测 |
| G3 | 跨重启可解释 | 重启后能说明"哪些消息没答、会怎么处理" |
| G4 | 异常可修复 | 每个异常至少一个可执行命令 |
| G5 | 零模型调用、回复有界 | 命令路径不调 LLM；单条 ≤ 1800 字符，超长分页 |

### 非目标

- 不做分布式队列/多主调度；不改变"同用户串行"语义。
- 不把消息正文全量落盘（台账维持 300 字截断）。
- 不引入新依赖；不改 QQ 协议层。

---

## 3. 事实源与权威边界

| 事实源 | 位置 | 生命周期 | 只回答一个问题 |
|---|---|---|---|
| 内存队列 `MessageQueue` | 进程内 | 重启即失 | **谁在等**（FIFO、#id） |
| 在途台账 `inflight.json` | 磁盘、文件锁原子读写 | 跨进程/跨重启 | **谁没答**（受理→结清） |
| 运行态 `busyUsers` / `draining` / `bgWaits` | 进程内 | 重启即失 | **谁在跑** |
| 会话映射 `sessions.json` | 磁盘 | 持久 | 消息进哪个会话 |
| 网关 `gateway-state.json` / `heartbeat` | 磁盘 | 持久 | 通道是否活 |
| 结构化日志 | 文件 | 轮转 | 时序与原因 |

**原则**：派生视图不制造新事实；join 键优先级 `msgId > queueId > fingerprint`。回复中每个数字必须标注来源（内存 / 台账 / 运行态），禁止混算。

---

## 4. 生命周期与状态机

### 4.1 对外固定 9 个状态（文案唯一）

| 状态 | 含义 | 判定（派生，不新增事实） |
|---|---|---|
| `claimed` | 已受理，尚未入队/派发 | 台账 inflight；不在队列；不在运行；`age ≤ 90s` |
| `queued` | 排队中 | 台账 inflight + 在内存队列 |
| `dispatched` | 已派发，等 prompt 落库 | 台账 inflight + 有 `sessionId` 无 `promptId` |
| `running` | 执行中 | 台账 inflight + 有 `promptId` + `busyUsers` 命中 |
| `background` | 后台等待 | `bgWaits` 命中该 session |
| `settled` | 已答 | 台账 settled + `settleReason=answered` |
| `rejected` | 已拒/已作废 | 台账 settled + reason ∈ {queue-full, duplicate-*, cancelled, dropped, expired, error} |
| `orphan` | 孤儿 | 台账 inflight；不在队列；不在运行/后台；`age > 90s` |
| `ghost` | 幽灵 | 在队列；台账无 inflight 记录（理论不应出现） |

### 4.2 转换图

```
received
   │ claimInflight
   ▼
claimed ──push──▶ queued ──drain──▶ dispatched ──promptId──▶ running
   │                 │                    │                      │
   │                 │ drop/clear         │ 失败                  ├─ idle ─▶ settled(answered)
   │                 ▼                    ▼                      └─ 超时 ─▶ background ─▶ settled(answered)
   │            rejected(dropped/     rejected(error)
   │             cancelled)
   │ age>90s 且无人认领
   ▼
orphan ──/ledger settle──▶ rejected(manual)
```

**规则**：每一次转换必须同时做三件事——写台账 `stage`/`settleReason`、打一条结构化日志、给用户一条可读回执（回执可配置开关）。

### 4.3 台账 schema 演进（加法，向后兼容）

在 `InflightEntry` 上新增可选字段，旧文件直接可读：

```ts
interface InflightEntry {
  // ...现有字段不变
  stage?: "claimed" | "queued" | "dispatched" | "running" | "background" | "settled"
  queueId?: number          // 与内存队列 #id 对齐
  enqueuedAt?: number       // 入队时刻（重建 FIFO 用）
  updatedAt?: number        // 最后状态变更
  settleReason?: SettleReason
  ownerPid?: number         // 跨进程归属（诊断）
  lastError?: string        // 截 200 字
}
```

- `state`（inflight/settled）保留不动，兼容旧代码与旧台账。
- 新增 API：`markInflightStage()`、`settleInflight(msgId, attemptId?, reason?)`、`listInflightView()`。
- 保留策略不变：inflight 全留；settled 24h 且最新 20 条。新增字段不参与裁剪。

---

## 5. 派生视图算法（核心，纯函数）

新增 `src/core/queue-view.ts`：

```ts
deriveQueueView(input: {
  entries: InflightEntry[]
  jobs: QueuedJob[]
  runtime: { busy: boolean; draining: boolean; bgSessions: Set<string>; sessionId?: string }
  now: number
  orphanMs: number   // 默认 90_000，env QQ_ORPHAN_MS
}): QueueView
```

### 5.1 计算顺序

1. 建索引：`byMsgId`（台账）、`jobByMsgId`（队列）。
2. 队列逐条：台账有 inflight → `queued`；没有 → `ghost`。
3. 台账 inflight 逐条（不在队列的）：
   - `busy && entry.sessionId === runtime.sessionId && (entry.promptId || stage ≥ dispatched)` → `running`
   - `bgSessions.has(entry.sessionId)` → `background`
   - `now - entry.at > orphanMs` → `orphan`
   - 否则 → `claimed`（短暂窗口，文案"派发中"）
4. 最近拒绝：settled 且 `settleReason != answered` 且 30 分钟内。
5. 不变量检查，产出 `warnings[]`。

### 5.2 不变量（每次计算都校验并展示违例数）

| 编号 | 不变量 |
|---|---|
| I1 | 队列中每条 job 都能在台账找到 inflight（否则 ghost） |
| I2 | 每条台账 inflight 必属于 queued / running / background / claimed / orphan 之一 |
| I3 | settled 条目不得出现在队列 |
| I4 | 队列长度 ≤ 上限；同一用户 `#id` 单调唯一 |
| I5 | 队列顺序 = 入队顺序 |
| I6 | 台账 inflight 的 `at` 不得晚于 `now`，`updatedAt` 不得早于 `at` |

---

## 6. 回复契约（用户看到的全部）

### 6.1 `/queue`（默认，用户面）

用本次真实数据渲染（假设 19 条孤儿仍在）：

```
当前任务：空闲
队列：0/20 · 台账在途：19 条
⚠️ 孤儿 19 条（已受理，未入队/未派发，超 90s）
  · 队列测试1 · 38m 前 · msg …pYgaf · att …u14b
  · 队列测试2 · 38m 前 · msg …nE! · att …h060
  · …（最多 8 条，发 /queue all 看全部）
最近拒绝 1 条
  · 队列测试20 · 排队已满（20 条）· 19:37
发 /ledger 看台账明细；/queue clear 清空；/queue drop <#id> 删单条
```

规则：

- 头行固定三要素：**当前任务 / 队列占用 / 台账在途**。
- 队列非空时逐条：`#票号 · 第N位 · age · preview · [排队中|派发中|执行中]`。
- 异常区：孤儿 / 幽灵 / 最近拒绝，各最多 8 条，超出给余量提示。
- **空队列但台账有孤儿时，禁止只回"队列：空"**。
- 单条 ≤ 1800 字符；超出分页 `/queue 2`。

### 6.2 `/queue all`

全量队列 + 台账在途，按 `enqueuedAt/at` 升序；每条附 `msgId` 尾 6 位、`attemptId` 尾 6 位、`stage`。

### 6.3 `/ledger`（新增，诊断面）

```
台账快照 · 2026-11-05 20:20:31
在途 19 · 已结 20（保留 24h / 最新 20）

在途（按受理时间）
 1. 队列测试1 · 19:37:06 · 38m · claimed · att …u14b · sid - · pid 30696
 2. 队列测试2 · 19:37:08 · 38m · claimed · att …h060 · sid - · pid 30696
 ...
已结（最近）
 · 队列测试20 · 19:44:03 · answered · att …0imil
 · 队列测试20 · 19:37:12 · queue-full · att …u14b
```

子命令：

| 命令 | 作用 |
|---|---|
| `/ledger [页码]` | 快照分页 |
| `/ledger orphan` | 只看孤儿 |
| `/ledger rejected` | 只看拒绝/作废 |
| `/ledger <msgId尾号>` | 单条详情：指纹、attemptId、stage 时间线、lastError |
| `/ledger check` | 对每条在途跑 `classifyInflight`（查会话历史）→ answered/running/lost，并给修复建议 |
| `/ledger settle <尾号>` | 人工结清，需二次确认 `confirm`，`settleReason=manual` |

### 6.4 `/status` 扩展

保留现有 5 行，追加一行摘要：

```
队列/台账：排队 0 · 在途 19 · 执行中 0 · 孤儿 19 · 最近拒绝 1
```

`/status full` = `/queue` 摘要 + `/ledger` 摘要（最多 2 条消息）。

### 6.5 自动状态回执（让对话记录本身可审计）

| 时机 | 文案（固定前缀） |
|---|---|
| 入队 | `已排队 #3（前面 2 条），当前任务结束后自动执行` |
| 开跑 | `开始执行队列 #3（剩余 2 条）` |
| 结清 | `队列 #3 完成（剩余 2 条）` / `队列 #3 失败：<原因>（剩余 2 条）` |
| 拒绝 | `排队已满（20 条），本条未入队；发 /queue 查看或 /cancel 清空` |
| 孤儿巡检 | 每 60s 扫一次；**仅新增孤儿且距上次提醒 >10min** 发一条汇总，不刷屏 |

### 6.6 文案约束

- 禁用 QQ 不支持的 markdown 表格；统一用 `·` 分隔。
- 单条 ≤ 1800 字符，超出分页，单次最多 3 条。
- 数字口径固定：`N/20`、`N 条`、`Nm 前`；本地时区。
- 空态固定：`队列：空（0/20）`。

### 6.7 票号与排队位置（2026-11-05 用户追问定稿）

**问题**：5 条排队时完成第 1 条，再入队一条，它显示 `#6`——这算"第 6 条"吗？

**结论**：`#6` 是**票号（ticket）**，不是位置；"第 5 位"才是位置。两者必须同时展示。

| 概念 | 语义 | 是否复用 | 用途 |
|---|---|---|---|
| 票号 `#N` | 该用户在本进程内的入队序号，只增不减 | 永不复用 | `/queue drop N`、台账 `queueId`、日志关联 |
| 位置 `第M位` | 当前队列中的实际排队次序（1-based） | 每次出队/删除后前移 | 用户体感"我还要等几条" |

规则：

1. 票号按用户独立计数（uA 的 #1 与 uB 的 #1 互不影响）。
2. 出队/完成/删除**不重排票号**，只重排位置；用户看到的 `#2` 永远是同一条消息。
3. 入队回执：`已排队 #6（第 5 位，前面还有 4 条）`。
4. `/queue` 列表：`#6 · 第5位 · 12s 前 · 文本… · 排队中`。
5. 执行中只显示票号（此时位置恒为 1）：`执行中：#6 · …`。
6. 重启恢复保留 `queueId`（票号）与 `enqueuedAt`（顺序），位置重新计算。
7. 反例（禁止）：只显示 `#6` 而队列只有 5 条——用户会误以为队列有 6 条或编号错乱。

---

## 7. 一致性修复与重启语义

### 7.1 现有缺口（必须在实现时修）

| 缺口 | 现状 | 修复 |
|---|---|---|
| `/queue drop` 不结账 | 只删内存 job，台账 inflight 残留 → 重启被重派 | `settleInflight(msgId, reason="dropped")` |
| `/queue clear` 不结账 | 同上，且是本次 19 条孤儿的头号嫌疑 | 逐条 `settle(..., "cancelled")` |
| `/cancel` 清队不结账 | `handleStop` 只 `queue.clear` | 清队 + 结账 + abort |
| 重启恢复把 queued 当 lost | `recoverInflightRounds` 只看会话历史 | 先按 `stage=queued` 重建队列，再对剩余条目走 classify |
| 日志断点 | `bot.out.log` 17:17 后无写入 | 启动时统一重定向到 `~/.openqq/openqq-<pid>.log`，`/status` 展示日志新鲜度 |

### 7.2 重启恢复顺序（新）

```
1. 读台账 → 取 inflight
2. stage=queued 或 (无 sessionId/promptId 且 age 在窗口内) → 按 enqueuedAt/at 升序重建内存队列（回执"重启恢复 N 条排队"）
3. 其余 inflight → classifyInflight：
   answered → 补投答案并 settle(answered)
   running  → 重挂后台等待
   lost     → 窗口内重派 / 超窗仅通知
4. 全部动作写 [journal] 日志 + updatedAt
```

**关键点**：队列条目重启后回到队列，而不是被当成"丢失消息"重派——语义从"重跑一条"变成"继续排队"。

### 7.3 孤儿修复路径

- 自动：`/ledger check` 或重启对账 → answered/running/lost 分类。
- 人工：`/ledger settle <尾号>`（二次确认）。
- 禁止静默删除：所有结清都带 `settleReason` 并留日志。

---

## 8. 日志与诊断

统一结构化行，字段 `k=v`：

```
[queue] enqueue user=... qid=3 msg=...abc att=...xyz ahead=2 size=3/20
[queue] drain-start user=... qid=3 size=2
[queue] drain-done user=... qid=3 ok=true remain=1
[queue] reject user=... msg=...abc reason=full size=20/20
[queue] orphan-scan count=19 new=19 threshold=90s
[journal] claim msg=...abc att=...xyz stage=claimed
[journal] stage msg=...abc stage=queued qid=3
[journal] settle msg=...abc att=...xyz reason=answered
```

- 日志落点：`~/.openqq/openqq-<pid>.log`，启动时轮转（保留 7 个）。
- `/status` 增加：`日志：<路径> · 最后写入 Ns 前`；>5min 无写入显示 `⚠️ 日志停滞`。
- `/ledger check` 结论同步写日志，便于事后取证。

---

## 9. 测试设计

### 9.1 单元（纯函数）

| 用例 | 断言 |
|---|---|
| `deriveQueueView` 空输入 | 全零、无 warning |
| 仅队列 / 仅台账 / 两者一致 | 状态与计数正确 |
| 孤儿（台账有、队列无、超阈值） | 归入 orphan，不归 queued |
| 幽灵（队列有、台账无） | 归入 ghost，I1 违例 |
| 执行中 / 后台等待 | running / background 优先于 orphan |
| 阈值边界 89s / 90s / 91s | 89→claimed，91→orphan |
| 拒绝条目 | 只在"最近拒绝"，不进队列 |
| 文案快照 | 长度、分页、空态、异常区 8 条上限 |
| 台账兼容 | 无 stage 老文件、settled 重投、attemptId 迟到 settle |

### 9.2 集成（真实链路，必须）

| 编号 | 场景 | 通过判据 |
|---|---|---|
| T1 | 单条正常 | 入队回执 → 开跑 → 完成回执 → 台账 settled(answered) |
| T2 | 21 连发 | 20 排队 + 1 拒绝；`/queue` 显示 20/20 与拒绝 1 |
| T3 | `/cancel` 清队 | 队列空 + 台账全部 settled(cancelled)；重启不重派 |
| T4 | 队列执行中重启 | stage=queued 的按原顺序恢复入队；running 的不重复执行 |
| T5 | 孤儿制造与修复 | 清内存不结账 → `/queue` 报孤儿 → `/ledger settle` 修复 |
| T6 | 本次事故回归 | 19 claimed + 1 queue-full，`/queue`、`/ledger` 文案与计数与本文示例一致 |

验收：`npm run verify` 全绿 + T1–T6 实测证据（日志、台账前后对比、回复截图）。

---

## 10. 实施映射

| 文件 | 改动 | 预估 |
|---|---|---|
| `src/core/inflight-journal.ts` | 新字段 + `markInflightStage` + `settleInflight(reason)` + `listInflightView` | ~120 行 |
| `src/core/queue-view.ts`（新） | `deriveQueueView` + 不变量 + 文案格式化 | ~250 行 |
| `src/core/message-queue.ts` | `find/peek/snapshot/restore` | ~40 行 |
| `src/bridge.ts` | queueApi 改用视图；drop/clear/cancel 结账；drain 回执带剩余；孤儿巡检；恢复按 stage | ~100 行改动 |
| `src/commands.ts` | `/ledger` 路由与子命令；`/status` 摘要；`/queue all`/页码 | ~120 行 |
| 启动/日志 | stdout 重定向 + 轮转 + `/status` 新鲜度 | ~50 行 |
| `test/` | queue-view 单测 + 可观测性集成测试 + 既有 queue 测试扩展 | ~300 行 |

**风险**：低。除"drop/clear/cancel 结账"属于行为修复外，其余为观测增强；无新依赖；串行、去重、台账、重启恢复等既有红线能力不变。

---

## 11. 分期

| 期 | 内容 | 交付 |
|---|---|---|
| P0 | 状态机 + 台账字段 + 派生视图 + `/queue` 增强 + `/ledger` 只读 + 结构化日志 + 单测 | 能看懂、能对账 |
| P1 | 完成/剩余自动回执 + 孤儿巡检 + `/ledger check\|settle` + 重启按 stage 恢复 | 能修复、能续跑 |
| P2 | 日志轮转 + 长队列分页体验 + 指标导出（可选） | 长期可运维 |

建议本轮做 P0+P1（事故已发生，修复路径不能等）。

---

## 12. 验收标准

1. 任一时刻发 `/queue`，回复同时给出：运行中 / 排队 / 在途 / 孤儿 / 最近拒绝 五类计数。
2. 每条台账 inflight 必属于 queued / running / background / claimed / orphan 之一（不变量 100%，违例必须显示）。
3. `/queue drop`、`/queue clear`、`/cancel` 之后台账无残留 inflight；重启不重派。
4. 本次 19 条孤儿场景可被 `/queue` 一眼识别，并被 `/ledger settle` 修复。
5. `npm run verify` 全绿；T1–T6 真实链路通过并留证。

---

## 13. 需用户拍板

1. 孤儿阈值默认 90s 是否合适（可 `QQ_ORPHAN_MS` 调）。
2. 孤儿是否允许自动修复（`/ledger check` 定时跑）还是只手动。
3. `/ledger` 是否仅限白名单用户（当前命令面本就受 `ALLOWED_USERS` 限制，建议沿用）。
4. 是否本轮直接实施 P0+P1（需明确授权改码；发版/升版另行授权）。
