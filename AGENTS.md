# opencode-qq-bot 项目总则（AGENTS.md）

> 本文件对**所有在本仓库工作的开发者**（含多个 AI 会话并行作业）与**通过 npm/插件安装的应用者**同效。
> 红线违反即返工；发版类操作必须 owner **当轮明示同意**，无历史豁免。

---

## 0. 角色总览

| 角色 | 是谁 | 能做什么 | 不能做什么 |
|---|---|---|---|
| **owner**（仓库所有者） | linjz | 一切；发版闸门的唯一授权人 | — |
| **开发者** | 本仓库的提交者（人类或 AI 会话，可能多会话并行） | 改码 / 测试 / 部署到**本机**插件目录 / commit+push | 未经当轮同意：publish / 发版动作 / 改 version（push 为自主收尾，见 §1） |
| **应用者** | npm 包或 opencode 插件的使用者 | 安装 / 配置 / 日常使用 / 升级 | 改码（出问题走 issue，不 fork 运行时代码） |

开发者与应用者的分界线 = **本仓库**。应用者只消费发布物（npm tarball / 插件市场版本），
 never 接触 src；开发者对 src 的每一次改动都受本文件全部红线约束。

---

## 1. 发版授权闸（push 自主，发版逐次同意）

| 动作 | 授权 |
|---|---|
| **`git push`（提交同步到 GitHub main）** | **自主**——常规工作收尾的自动动作，无需逐次请示 |
| **GitHub 打包/发版**：`git tag`/GitHub Release/发版产物构建与上传 | owner **当轮明示同意**，无历史豁免 |
| **`npm publish`**（任何标签/版本） | owner **当轮明示同意** |
| **版本号变更**（`package.json` version / npm version 系列） | owner **当轮明示同意**（属发版动作） |

owner 当轮的开发/测试/部署指令 = 该轮内**本地 commit** 的授权；push 为自主收尾；
任何「打包/发版/publish/升版」性质的动作永不默许。
建议的发版顺序（获同意后执行）：改 version → `bun run verify` 全绿 → 全量构建 →
`npm publish` → `git push` → `git tag v<x.y.z>` 并推 tag。

---

## 2. 架构红线（不可协商，违反即返工）

> 运行时代码全部随包分发、运维工具 TS/JS 跨平台可迁移——不得以「临时脚本」「本机能跑」为例外。

### 2.1 运行时代码只存在于插件安装目录
- 所有可执行代码——bot 本体、插件引导器、看门狗、重启/诊断 CLI、自启安装器——必须随 npm 包
  分发，运行位置 = 插件安装目录 `<plugins>/opencode-qqbot/`（`dist/` 为运行产物，`src/` 为 TS 源）。
- 禁止在以下位置放运行时代码：`~/.openqq/`（只允许运行时数据：`.env`、`*.json` 台账、
  `*.log`、`heartbeat`）、仓库 `scripts/`、`deploy/`、系统临时目录。
- 需要按人/机器定制的只有**数据**（`.env`、配置），不是脚本。

### 2.2 看门狗与运维工具一律 TS/JS，跨平台
- 源码 `src/**/*.ts`，产物 `dist/*.js`，运行时只依赖 bun 或 node，不依赖 PowerShell/VBS/Bash。
- 进程存活判定优先 Node 原生 API（`process.kill(pid, 0)`、锁文件 pid）；确需 OS 命令时必须有
  跨平台分支与降级（参照 `src/core/discovery.ts`）。
- **平台差异只允许出现在「自启注册」这一处**：win32 → schtasks（TS 生成）；linux → systemd
  user unit；darwin → launchd plist。由 TS 安装器生成/删除，不得引入 `.ps1`/`.vbs`/`.bat`
  作为运行时代码。
- 统一入口（全部落在 `dist/`）：`openqq watchdog --once|--loop`、`openqq restart [--force]`、
  `openqq service install|uninstall|status`。
- 既有跨平台例外（保留，不得扩大）：`discovery.ts` 的 `netstat`/`ss` 端口枚举
  （Windows/Linux/macOS 三分支 + 失败降级）。新增 OS 依赖必须按同一标准给出分支与降级。

---

## 3. 开发者：安装与部署

### 3.1 环境
- bun ≥ 1.4（主运行时）；node ≥ 20 仅作应用者侧兜底。
- 克隆后：`bun install`，然后 `bun run verify` 必须全绿才开始改码。

### 3.2 日常开发闭环
1. **verify 门禁**：`bun run verify`（tsc + 53 套件测试链）全绿才可提交/部署；红期间只诊断不改码。
2. **每修必带测试**：新行为进 `test/<域>-cases.ts`（check/PASS 风格）并挂入 package.json 测试链；
   `test/` 目录 gitignored 不入库，但测试链引用必须与 suite 文件同步维护。
3. **提交纪律**：精确路径 `git add`（禁 `git add -A`）；不碰其他会话的在途文件；
   commit message 写根因+证据，不写「修复一些小问题」。规则文件（AGENTS.md/规约文档）变更的
   owner 授权依据一并写入 commit message——变更史以 git log 为单源，文件内不留修订表。
   **诊断衍生的规程/产物入仓交付须 owner 当轮明确授权——先例不构成授权**
   （先问容器属于哪层，再问是否有先例）。
4. **多会话并行**：两个 opencode 会话同仓作业是常态。动手前 `git status` + 查在途 +
   看 `~/.openqq/openqq.log` 尾部三件套（统一日志，看门狗审计与 bot 输出同文件）；bundle 部署从主工作树构建（worktree 路线已弃用——
   现役 bundle 可能含未提交改动，异源构建会回退线上功能）。

### 3.3 部署纪律
0. **更新代码后禁止马上重启 BOT**：本地部署=拷贝 bundle 即完成，
   新代码在下次进程自然启动时才加载；**部署动作本身绝不伴随重启**。想激活？按下述
   攒批与等空闲规矩来，不紧急就等自然重启（看门狗拉活/下次维护窗）。
1. **部署 ≠ 激活**：bundle 拷贝随时可做（零影响）；**激活重启要攒批**——一轮工作至多一次；
   多个修复合并部署、一次激活。
2. **默认等空闲重启**：激活用 `openqq restart`（非 force，等空闲自动停拉）；执行前查在途台账
   （`~/.openqq/inflight.json` 或 `/queue`），有在途回合宁可等它完成。
3. **`--force` 仅限安全类紧急修复**，且必须在 commit message 或当轮记录里注明理由。
   教训：频繁 force 激活小修复会打断在途回合，制造僵尸等待与工作稿误投。

### 3.4 遗留闸门（已登记，修时必须回归）
- **DEF-20261110-2**：同一 msgId 重复派发（QQ RESUME 重放疑绕过在途去重）——dispatch→prompt
  边界的强制单飞闸未装；现有 missingIdleDone 兜底止血。

---

## 4. 应用者：安装与部署（不改码，只消费发布物）

包名 `@linjz/opencode-qqbot`（ scoped ），两种形态：

### 4.1 形态 A：opencode 插件（推荐）
```bash
opencode plugin add @linjz/opencode-qqbot        # 或在 opencode.json(c) 的 plugins 数组加包名
npx -p @linjz/opencode-qqbot openqq-setup        # 手机 QQ 扫码绑定，自动写 ~/.openqq/.env
openqq service install                           # 自启注册（win=计划任务 / linux=systemd / mac=launchd）
```
- 常驻：插件引导器在 OpenCode 在线时自动拉起 bot 并巡检（看门狗内嵌）；serve 重启自动恢复。
- 升级：`opencode plugin add @linjz/opencode-qqbot@latest`（重装同目录即更新），
  然后 `openqq restart`（等空闲）激活新代码。

### 4.2 形态 B：独立部署（无 opencode 桌面环境的机器）
```bash
npm i -g @linjz/opencode-qqbot
openqq-setup                                  # 扫码配置（同 setup）
openqq                    # 前台运行 bot
openqq watchdog --loop --interval-min 10      # 或注册自启：openqq service install
```
- node ≥ 20 即可（跑内置运行包，无需 bun）。

### 4.3 配置与数据（两形态相同）
- 唯一配置面：`~/.openqq/.env`（QQ appId/appSecret、OPENCODE_PASSWORD、白名单、可选开关）。
  **secrets 纪律：任何工具/会话不得读取外泄、不得改写 `.env`**（排障只验证存在性与字段名）。
- 运行时数据（台账/日志/锁/心跳）全部在 `~/.openqq/`，可整目录备份/迁移，跨机复制即迁移。

### 4.4 应用者排障入口
`/status`（服务器/鉴权/会话/队列/日志新鲜度）→ `/queue` `/ledger` → 日志
统一日志 `~/.openqq/openqq.log`（bot 输出与看门狗审计同文件：`主动杀`/`验尸拉新`/`装配`/`Gateway 就绪` 一条时间线归因；滚动 20MB×4 代、总预算 100MB）。

---

## 5. 进程处置红线（违反即事故复盘）

背景：bot「无声死亡」的首要实锤原因是外部裸杀（自监控全部排除）；操作侧红线如下：

1. **禁止裸杀**：不得 `taskkill`/`Stop-Process`/任务管理器结束 bot。Windows 下进程被杀无
   退出日志、在途审批/回合中断、事后无法归因。
2. **重启唯一入口**：`node <plugin>/dist/openqq-cli.js restart [--force]`（走锁交接）。
   执行前查在途；有 inflight 回合先告知用户或等待完成。
3. **部署窗口纪律**：即 §3.3——禁止在长回合（>5min）中反复 restart（心跳陈旧会触发看门狗
   优雅杀，与人工重启叠加成连环死亡）。
4. **归因义务**：任何死亡后先查 `~/.openqq/openqq.log`（统一日志）尾部——`主动杀`=看门狗合法动刀（附原因）；
   `验尸拉新`=外部/系统级死因，结合死亡时刻操作记录归因，不得一句「又掉线了」了事。
5. **多会话协同**：见 §3.2 第 4 条三件套。

---

## 6. 测试与验收资产

- 组件层：`bun run verify`（tsc + 53 套件测试链；另有 `test:e2e` 5 套件按需）为每日门禁；每修必带测试。
- 验收层：`tests/reports/` 各轮历史 + `TEST-STATUS-OVERALL.md` 总索引，单轮细节在同目录各轮文件夹；
  执行纪律以 simulated-user-acceptance 技能（UI 主证/未触归因/台账尾部重读闸）为准；
  **台账锚定编辑前必须重读文件物理尾部**——mtime 可能滞后于内容（并行会话活跃写入期），
  以章节内容定权威位，插入式登记视为违规。
  命名口径：任务书 `tests/plans/<topic>-uat-<date>.md`；报告树 `tests/reports/<YYYY-MM-DD>-<domain>/`
  （证据 `AC-<域>-<序号>_<步骤>_<yyyyMMddTHHmm>.<ext>`）——只留当前轮，历史轮归档即清。
- 缺陷编号：`DEF-qqbot-YYYYMMDD-<序号>`；待定性 `-P<序号>`；跨轮台账可达性开工必核。

---

## 7. 指挥家工作法（QQ 实操验证与中断续跑）

> 背景：本仓库的 AI 会话（任意客户端载体——QQ 中继/桌面/TUI 均可）即「远程指挥台」，
> 指挥 135 机器（192.168.20.135）的 PC QQ 真实客户端完成实操验证。细则按层归两份文档：
> 端点层（135 驱动链/WinRM 失效模式/唤窗规程）见 `docs/human-execution-endpoint.md`；
> 编排层（双会话架构/判定口径/重启续跑/深挖纪律）见 `docs/commander-executor-architecture.md`。
> 本节只留红线，与 §3.3 部署纪律、§5 进程红线协同。

### 7.1 驱动与发送红线

- 驱动链路=项目侧资产（exec135.ps1→uat-driver.ps1，随验收轮存 `tests/reports/<轮次>/tooling/`，仅放本轮实例脚本与驱动器快照）；
  **跨轮复用的操作规程/SOP=常驻文档层 `docs/playbooks/`**（入仓须 owner 当轮授权，见 §3.2）；
  凭据 `%TEMP%\opencode\cred-135.xml` 只读使用、不得回显外带。
- **WinRM 红线**：对 135 的一切输入与 GUI 拉起必须经 /it 计划任务链——WinRM 直发落非交互
  会话，进程无窗、输入被静默吞掉。机理与唤窗规程见 AEE 文档 win-native 档案。
- **发送前三件套**：经 135 向 bot 发任何测试消息前——①probe 确认 QQ 窗口 ②截图确认当前
  绑定会话=专用测试会话 ③核 `~/.openqq/inflight.json` 在途。**缺一不发**；有在途宁可等待
  或 /new 换会话，不注入、不即兴 /cancel（机理见指挥官文档异常分支）。

### 7.2 判定与深挖

- UI 主证=135 截图（判定当时回读）；辅证=引擎 REST 读服务端事实逐格对照；事件无
  actor/原因字段不下行为归属结论（先判别实验再定性）。
- 深挖：最小场景+判别实验（一次一变）；临时桩标「临时」定位即除；不可达如实记
  UNREACHABLE，不为测试强造场景。
