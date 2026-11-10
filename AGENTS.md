# opencode-qq-bot 项目总则（AGENTS.md）

> 本文件对**所有在本仓库工作的开发者**（含多个 AI 会话并行作业）与**通过 npm/插件安装的应用者**同效。
> 红线违反即返工；发版类操作必须 owner **当轮明示同意**，无任何历史豁免。
> 最近大修订：2026-11-10（角色分层 + 发版授权闸 + 部署纪律三章，owner 当轮指令）。

---

## 0. 角色总览

| 角色 | 是谁 | 能做什么 | 不能做什么 |
|---|---|---|---|
| **owner**（仓库所有者） | linjz | 一切；发版闸门的唯一授权人 | — |
| **开发者** | 本仓库的提交者（人类或 AI 会话，可能多会话并行） | 改码 / 测试 / 部署到**本机**插件目录 / 本地 commit | 未经当轮同意：push / publish / 改 version |
| **应用者** | npm 包或 opencode 插件的使用者 | 安装 / 配置 / 日常使用 / 升级 | 改码（出问题走 issue，不 fork 运行时代码） |

开发者与应用者的分界线 = **本仓库**。应用者只消费发布物（npm tarball / 插件市场版本），
 never 接触 src；开发者对 src 的每一次改动都受本文件全部红线约束。

---

## 1. 发版授权闸（owner 口径精调 2026-11-10：push 自主，发版逐次同意）

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

> 来源：2026-11-09 owner 当轮强调（「所有代码都在插件安装目录里面；看门狗用 TS/JS，
> 具备跨平台可迁移特征」）。不得以「临时脚本」「本机能跑」为例外。

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

### 2.3 迁移清单（2026-11-09 已完成，保留备查）
watchdog/restart/autostart 已全部收编为包内 TS（`core/watchdog.ts` + 监督矩阵、
`core/bot-control.ts`、`cli/service-main.ts`、插件引导器内联巡检）；旧 PS1/VBS/计划任务
`OpenQQ-Bot*` 已下线删除。细节见 git 历史 `8793c18`/`e035501`。

---

## 3. 开发者：安装与部署

### 3.1 环境
- bun ≥ 1.4（主运行时）；node ≥ 20 仅作应用者侧兜底。
- 克隆后：`bun install`，然后 `bun run verify` 必须全绿才开始改码。

### 3.2 日常开发闭环
1. **verify 门禁**：`bun run verify`（tsc + 50 套件测试链）全绿才可提交/部署；红期间只诊断不改码。
2. **每修必带测试**：新行为进 `test/<域>-cases.ts`（check/PASS 风格）并挂入 package.json 测试链；
   `test/` 目录 gitignored 不入库，但测试链引用必须与 suite 文件同步维护。
3. **提交纪律**：精确路径 `git add`（禁 `git add -A`）；不碰其他会话的在途文件；
   commit message 写根因+证据，不写「修复一些小问题」。
4. **多会话并行**：两个 opencode 会话同仓作业是常态。动手前 `git status` + 查在途 +
   看 `~/.openqq/watchdog.log` 尾部三件套；bundle 部署从主工作树构建（worktree 路线已弃用——
   现役 bundle 可能含未提交改动，异源构建会回退线上功能）。

### 3.3 部署纪律（2026-11-10 四条，上午事故忏悔录立法）
0. **更新代码后禁止马上重启 BOT**（owner 当轮硬口径）：本地部署=拷贝 bundle 即完成，
   新代码在下次进程自然启动时才加载；**部署动作本身绝不伴随重启**。想激活？按下述
   攒批与等空闲规矩来，不紧急就等自然重启（看门狗拉活/下次维护窗）。
1. **部署 ≠ 激活**：bundle 拷贝随时可做（零影响）；**激活重启要攒批**——一轮工作至多一次；
   多个修复合并部署、一次激活。
2. **默认等空闲重启**：激活用 `openqq restart`（非 force，等空闲自动停拉）；执行前查在途台账
   （`~/.openqq/inflight.json` 或 `/queue`），有在途回合宁可等它完成。
3. **`--force` 仅限安全类紧急修复**，且必须在 commit message 或当轮记录里注明理由。
   教训：2026-11-10 上午连续 4 次 force 重启激活小修复，每次都打断在途回合，
   直接制造 39 分钟僵尸等待 + 工作稿误投两起事故（DEF-20261110-1/2 家族）。

### 3.4 遗留闸门（已登记，修时必须回归）
- **DEF-20261110-2**：同一 msgId 重复派发（QQ RESUME 重放疑绕过在途去重）——dispatch→prompt
  边界的强制单飞闸未装；现有 missingIdleDone 兜底止血。
- 测试资产：`test/reports/TEST-STATUS-OVERALL.md` 是全轮索引，单轮细节在同目录各轮文件夹。

---

## 4. 应用者：安装与部署（不改码，只消费发布物）

包名 `@linjz/opencode-qqbot`（ scoped ），两种形态：

### 4.1 形态 A：opencode 插件（推荐）
```bash
opencode plugin add @linjz/opencode-qqbot     # 或在 opencode.json(c) 的 plugins 数组加包名
npx @linjz/opencode-qqbot setup               # 手机 QQ 扫码绑定，自动写 ~/.openqq/.env
openqq service install                        # 自启注册（win=计划任务 / linux=systemd / mac=launchd）
```
- 常驻：插件引导器在 OpenCode 在线时自动拉起 bot 并巡检（看门狗内嵌）；serve 重启自动恢复。
- 升级：`opencode plugin update @linjz/opencode-qqbot` 后 `openqq restart`（等空闲）激活。

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
`~/.openqq/bot.out.log` 与 `watchdog.log`（看门狗审计分家：`主动杀`/`验尸拉新` 一眼归因）。

---

## 5. 进程处置红线（2026-11-09 加固，违反即事故复盘）

背景：2026-11-09 一日 ≥6 次「无声死亡」全部实锤为**外部裸杀**（自监控全部排除，凶手为
另一会话的 kill/restart 习惯）。自监控侧已加固（杀前复核 + 审计分家），操作侧红线如下：

1. **禁止裸杀**：不得 `taskkill`/`Stop-Process`/任务管理器结束 bot。Windows 下进程被杀无
   退出日志、在途审批/回合中断、事后无法归因。
2. **重启唯一入口**：`node <plugin>/dist/openqq-cli.js restart [--force]`（走锁交接）。
   执行前查在途；有 inflight 回合先告知用户或等待完成。
3. **部署窗口纪律**：即 §3.3——禁止在长回合（>5min）中反复 restart（心跳陈旧会触发看门狗
   优雅杀，与人工重启叠加成连环死亡）。
4. **归因义务**：任何死亡后先查 `~/.openqq/watchdog.log`——`主动杀`=看门狗合法动刀（附原因）；
   `验尸拉新`=外部/系统级死因，结合死亡时刻操作记录归因，不得一句「又掉线了」了事。
5. **多会话协同**：见 §3.2 第 4 条三件套。

---

## 6. 测试与验收资产

- 组件层：`bun run verify`（50 套件）为每日门禁；每修必带测试。
- 验收层：`test/reports/` 四轮历史（1103/1105/1106/1109-P0P2）+ `TEST-STATUS-OVERALL.md`
  总索引；执行纪律以 simulated-user-acceptance 技能（UI 主证/未触归因/台账尾部重读闸）为准。
- 缺陷编号：`DEF-qqbot-YYYYMMDD-<序号>`；待定性 `-P<序号>`；跨轮台账可达性开工必核。

---

## 修订留痕

| 日期 | 内容 | 授权 |
|---|---|---|
| 2026-11-09 | 架构红线 §2（插件目录/TS 跨平台/迁移清单） | owner 当轮 |
| 2026-11-09 | 进程处置红线 §5（禁裸杀等五条） | owner「加强审计，加固红线」 |
| 2026-11-10 | 发版授权闸 §1（push/publish/version 逐次同意） | owner 当轮 |
| 2026-11-10 | §1 精调：push 自主；GitHub 打包发版/npm publish/升版维持逐次同意 | owner 当轮 |
| 2026-11-10 | §3.3 增补第 0 条硬禁令：更新代码后禁止马上重启 BOT（部署不伴随重启） | owner 当轮 |
| 2026-11-10 | 部署纪律 §3.3（部署≠激活/等空闲/force 收紧） | owner 当轮（上午事故忏悔录） |
| 2026-11-10 | 角色分层 §0 + 应用者章节 §4 | owner 当轮 |
