# 复盘：QQ 端重复回复根治与投递链路硬化（2026-11-02 → 11-03）

> 历史事故复盘档（防重蹈覆辙）；现行系统结构见 `docs/design.md`，当时的队列可观测性设计见 `docs/design-queue-observability.md`。
> 项目侧复盘档（qqbot-upgrade-sync 步骤 6 纪律）；对账清单另见 `D:\OpenCode\new-snmp\.tmp\plan-qqbot-duplicate-replies.md` 与 `.tmp/plan-qqbot-acceptance.md`。主体产物=本仓 6 个 commit（`02d5ff8`→`ed76844`），已推送 origin/master，未发版。

## 1. 病历（36 小时时间线摘要）

- **主诉**：QQ 一条消息 → 4~5 条重复回复；期间出现「没有任何回复」的静默观感与幽灵执行（429-A）。
- **主链**：多 believer 并存、同 msgId 并发受理（4 连发 409/prompt 签名、bot 全灭仍 3 POST；桌面会话历史一侧 5 条 user 13ms 内落库）。
- **放大器A**：gateway session/seq 仅内存 → 重启走 IDENTIFY 失忆 → backlog 重放 + 启动对账重派（openqq423/429 ghost 铁证）。
- **放大器B**：排队消息空 sessionId 入账 → 崩溃后对数次 400 永挂（openqq422 五连铁证）。
- **误伤**：lost 重派前不查目标会话已答 → 已答回合被重跑。
- **暗 believer 实锤**：opencode serve 经插件 cmd 拉起的旧 dist 常驻实例（pid 34828，bot.out.log 0 字节=不可观测）。
- **429-A 幽灵真相**：旧账在新进程内重派执行到一半，assistant 对「A」发起了 question 孤儿表单，无人作答 → 回合永不收尾 → form 409 风暴的另一半真身。
- **P2 观感层（共享会话）**：QQ 映射落在桌面工作会话上，直答取「受理后第一条 assistant」→ 等 21 分钟拿到排障报告；受理无回执 → 「没有任何回复」体感。
- **msgId 语义定案**：入站群@头段为会话级常量，「稳定头+稳定尾=同一条消息」旧判据作废；唯一化在尾部随机段。

## 2. 修复与防线（commit `02d5ff8` 为主体）

| 层 | 缓解手段 | 落点 |
|---|---|---|
| 受理幂等 K1/K2 | 跨进程原子认领（同 msgId 拒=静默；同内容指纹拒=短提示），窗口=并发在途，重投按重发（用户拍板） | `core/inbound-dedupe.ts` + `inflight-journal.claimInflightDetailed` |
| 重启失忆 | session/seq 落盘 `gateway-state.json`，重启优先 RESUME，op9 回退 IDENTIFY；seq 回补观测日志 | `core/gateway-state.ts` + `qq/gateway.ts` |
| 账本卫生 | 空 sessionId 排队账清账不重派；lost 判定加时间锚找回原回合 | `core/inflight-journal.ts` |
| 双 believer | 持锁实例 60s 自检（pid 易主/锁消失→自杀），抢锁 try 即退 | `core/instance-lock.ts` |
| 版本同一性 | 插件 dist 重建+整目录部署，哈希对账；bot 内建文件日志常开（暗 believer 可观测） | `core/bot-launcher.ts`（既有）+ 部署流程 |
| 直答归属（P2） | promptId 精确锚定回合边界（prompt API 受理返回值），前台直答/后台等待/补投共用 turnStateOf | `opencode/client.ts` + bridge |
| 受理回执（P2） | 「已收到」（后改开关制默认关，`QQ_ACK_RECEIPT=1` 召回） | bridge（`cb67f5d`） |
| 停滞提醒升级 | 状态（已停滞/状态不明/已终结未回传）+最近动作+无进展分钟数 | bridge（`26b56ba`） |
| 出站渲染保真 | 列表标记 `1.` → `1、`（用户截图实测：`1、`/`一、` 在被动通道 100% 保真，`1.` 被整条续编），代码围栏不动、幂等 | `core/delivery.qqListNormalize`（`6ff9697`/`dd52fba`） |
| 幽灵清结 | 幽灵账置 settled、孤儿 question 表单作废（运维动作，均留证） | journal + form API |

## 3. 实测验收账（UI 主证=QQ 端可见结果）

| 项 | 结果 | 证据 |
|---|---|---|
| T1 单发直答（1 受理/1 记录/1 气泡） | ✅ | admission=1（msg_19f95993）、用户「气泡没毛病」 |
| T2 同文连发 K2 拦截 | ✅ | `[admit-dedupe]` 命中、无 journal 行、无 LLM 执行 |
| T3 机器对账（受理/出站/台账/进程/心跳） | ✅ | openqq432/433 四线、进程恒 2 |
| T4 整点 RESUMED 窗零重放 | ✅ | 13:35 RESUMED 后无幽灵入站 |
| T5 跨重启 RESUME | ✅ | 12:36 生产首验（86s 恢复 seq=11/28→12） |
| 幽灵账+孤儿表单清结 | ✅ | journal settled、form 作废、停滞提醒不再触发 |
| AC0 已收到默认关闭 | ✅ | openqq434 出站实际回执字符串=0 |
| S3 列表顿号渲染（新代码真投递） | 待用户截图 | 矩阵实测已证 `N、` 保真（旧通道） |
| S5 命令面 /help（用户操作） | 未触-OMITTED→待 1 条实测 | — |
| S8 停滞提醒新文案（30min 真实停滞） | DEFERRED（风险接受） | 旧代码上已人工全链验证过一次 |
| 多用户隔离类 | ⏭️ N/A | 白名单=1 人 |

## 4. 残余风险

- R1 `QQ_INSTANCE_LOCK=false` 显式关锁：仅人工可触发；后果=网关互踢，K1/K2 仍保证无重复气泡。**接受**。
- R2 毫秒级抢锁竞态：wx 原子性保证胜者唯一，窗口 <1s。**接受**。
- R3 427/428/429 短命崩溃原因未定案（无 stderr）：内建文件日志已使其可观测，复发可取证。**观察位**。
- R4 `QQ_ACK_RECEIPT=1` 召回路径仅代码审查，未行为实测（需一次重启），风险=开关翻转的一行 iff。

## 5. 复盘教训

1. **暗进程=观测性缺失的最坏形态**：`bot.out.log 0 字节` 让双 believer 存在 12h+ 无感；文件日志常开后来三小时抓到真身。
2. **调试插桩要挑平台语义成立的通道**：asyncHooks 在 Bun 服务端不生效（prompt-trace 0 采样），TCP 连接采样才是对的抓手。
3. **配置文件 BOM 会让重启变风暴**：3 字节 BOM 让 opencode 每次重载拒绝配置 → 插件重载风暴，放大一切竞态。
4. **「桌面历史视图」不是真相源**：compaction 会改写文本，「逐字对账」永远以投递层快照/QQ 端为准。
5. **验收判据要明确定义**：「1 个气泡」最终收敛为「同内容不重复投递」，长文分段/回执开关是 UX 变量，与投递幂等解耦。
6. **渲染限制要有对策分层**：官方无规范、生态全规避（proactive-all），自建「顿号平面化 + 纯文本回落 + 提示词约束」三层即可闭环，不必等平台。

## 6. 官方吸收候选（learning-backlog 精选，均 P0 生态内）

1. **stateful markdown chunker**（openclaw PR#92428）：表格/围栏跨消息保持完整性——吸收价值高（本项目 message-split 目前按长度切）。
2. **c2cMarkdownDeliveryMode=proactive-all 思想**：md 富结构回复走主动通道规避被动渲染受限——本项目已有主动降级，可考虑「富结构检测→优先主动」配置项。
3. **tencent-connect 侧 hook 语义**：卡片 intent 位/响应时限纪律已对齐，无移植项。

## 7. 未决事务

- docs 回顾入库后 push（git 通则自动收尾）
- S5/S3 的用户 eyeball 件：一条 `/help` + 一次批二列表截图（可选）
- 结案清理：prompt-trace 插件与诊断行、.tmp/opencode-backup.db（3.6GB）、desktop-asar 提取物、opencode.jsonc 去 BOM
