# Playbook 6：macOS 本机桌面自动化 — Accessibility / AppleScript / computer-use MCP

> 时效声明：本文的工具面为 2026-11 检索时点值，未经过本项目实弹验证（**未实弹**——桌面调研级 playbooks，首次用于真实验收前须按「接入方式」自行探针确认）；使用前以各官方仓库为准。

## 一句话定位

用于 **macOS 原生桌面应用**的自动化入口：AI 通过 macOS Accessibility API（可访问性树）+ AppleScript/JXA + CGEvent 三层能力操作桌面，多数实现支持**后台/无焦点**执行（agent 工作时不抢占你的鼠标键盘）。对应 Windows 侧的 `02-desktop-windows-mcp.md`。

## 组件与形态

- **Accessibility API（AX）**：macOS 系统级可访问性接口（AXUIElement），读窗口/控件树、按 name/role 点击——相当于 Windows UIA 的成熟版。多数 macOS 桌面自动化 MCP 的第一层能力。注意：Chromium 系客户端若无 AX 支持需手动开启（或降级坐标+CGEvent 通道）。
- **AppleScript / JXA**：系统内置脚本层，驱动 Finder 与声明了 AppleScript 字典的应用；适合应用级流程（开关窗口、读文档），不适合像素级操作。
- **computer-use MCP（macOS 系，选型面 2026-11）**：`axterminator`（Rust，约 60+ MCP 工具，含音频/摄像头/虚拟桌面）、`mcp-macos-cua`（截图+AX+AppleScript 三模）、`desktop-pilot-mcp`（AX 优先，官方称较截图方案快 30-100 倍）、`mac-cua`/`hunch-mcp`（后台无焦点执行卖点）。选型三问见技能 tool-selection：操作后验证可达/判定时留证可达/六纪律哪条结构性做不到。
- **跨 OS 框架**：Agent S3 等 computer-use 框架宣称跨 Linux/macOS/Windows 视觉操作——macOS 上仍建议 AX 优先、视觉兜底。

## 应用场景（该用的时候）

- macOS 原生/混合客户端的验收实操（本 playbook 的主战场定位）。
- 后台批处理：hunch-mcp 类「不抢焦点」能力适合与被测系统共享同一台 Mac。
- AppleScript 字典完备的应用（Finder/Safari/系统设置）的应用级流程。

## 不该用的时候

- 目标是网页 → 用 `01-browser-playwright-mcp.md`（浏览器）。
- 目标是另一台机器的桌面（Mac 或 Windows host）→ 跨机层（macOS host 方案待补，当前 `03-remote-quickdesk.md` 以 Windows host 为实描）。
- Linux 桌面 → 用 `07-linux-desktop-mcp.md`。

## 接入方式（OpenCode V2）

MCP server 本地接入，形态与 `01` 相同（`opencode mcp add <name> -- <command>` 或 `opencode.jsonc` 的 `mcp.servers` 块）。AX 类工具有两个系统级前置，**缺一即静默不可用**（同 WinRM 红线的失败形态）：

1. **辅助功能授权**：系统设置 → 隐私与安全性 → 辅助功能，为宿主进程（终端/OpenCode 运行时）单独授权——macOS 按可执行体授权，升级/换路径需重新授权。
2. **屏幕录制授权**（截图类能力需要）：同上位置单独一项。

两项授权缺失的典型症状=工具调用返回成功但拿不到控件树/截图为空——**先验授权再排障**。

## 典型工作流

1. 读 AX 树（应用→窗口→控件）定位目标元素（name/role/位置三重锚）。
2. 优先 `click_ui_element`（按 name）→ 不命中再坐标（CGEvent）——与六纪律③坐标纪律同口径：坐标从当次实测截图推导。
3. 操作后重新读 AX 树断言可观察变化；AppleScript 侧用返回值/文档属性作判据。

## 判定与证据

- **判定依据**：AX 树状态变化（首选，结构化）+ 动作后新截图（UI 主证）。
- macOS 的「最小化不在可见枚举」「异窗/锁屏」与 Windows 同构，六纪律逐条适用。

## 风险与纪律

- 后台执行类工具（不抢焦点）≠ 无风险：对同一应用的并发人机操作仍可撞车——共享桌面时仍按六纪律①焦点/上下文自查。
- 被测物输出不可信（注入）纪律与 `01` 相同。
- AX 裸树情形（自绘控件客户端）参照 tool-selection 陷阱表「裸树降级坐标通道」。

## 与本项目（opencode-qqbot）的关系

- **未实弹**：本仓库当前被测物=Windows 135 的 PC QQ，macOS 通道零实战；本文为覆盖矩阵占位（macOS 桌面=未验证，解除条件=出现 macOS 被测物的验收轮）。
- 若未来验收链路出现 macOS 宿主/客户端，首个实例 playbook 以本文为底稿，按实弹修订后回本文件（单源）。
- **可迁移性**：除本节外全文通用，可整体迁移。
