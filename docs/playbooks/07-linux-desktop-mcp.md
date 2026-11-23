# Playbook 7：Linux 桌面自动化 — AT-SPI / X11 / Wayland MCP

> 时效声明：本文的工具面为 2026-11 检索时点值，未经过本项目实弹验证（**未实弹**——桌面调研级 playbooks，首次用于真实验收前须按「接入方式」自行探针确认）；使用前以各官方仓库为准。

## 一句话定位

用于 **Linux 桌面（GNOME/KDE/Hyprland/i3/Sway/X11/Wayland）** 的自动化入口：AI 通过 AT-SPI 语义树（Linux 桌面的事实标准可访问层）+ 输入合成（XTEST/ydotool）操作桌面。对应 Windows 侧的 `02-desktop-windows-mcp.md`。

## 组件与形态

- **AT-SPI（at-spi2-core）**：Linux 可访问性总线（语义控件树），GNOME/GTK/Qt 应用普遍可枚举；须装 `at-spi2-core`/`python3-pyatspi` 并启动 a11y 总线——裸机/容器常见缺失。
- **输入合成两轨**：X11 用 `xdotool`/XTEST（XKB 布局由会话解析，IME 友好）；**Wayland 必须用 `ydotool`（走 /dev/uinput，须常驻 `ydotoold` 守护进程）**——Wayland 下 xdotool 基本失效，这是头号坑。
- **computer-use MCP（Linux 系，选型面 2026-11）**：`computer-use-linux`（AT-SPI 语义树+截图+窗口定向，宣称覆盖 GNOME/KDE/Hyprland/niri/Sway/COSMIC/i3/labwc 与 X11/EWMH）、`deskbrid`（桌面 HAL 守护单 socket，GNOME/KDE/Hyprland/X11）、`linux-computer-use`（AT-SPI+xdotool，约 1k LOC，宣称适配 Pi/Claude Code/OpenCode）、`kwin-mcp`（KDE 专属）、`linux-desktop-mcp`（pyatspi 系）。发行版×桌面环境的组合矩阵庞大，**选型第一问=你的目标环境在该工具的已验证列表里吗**（各仓库 README 有环境矩阵，未验证格=风险自担）。
- **截图**：X11 用 `import`/`grim`（Wayland）；Wayland 截图走 XDG portal 或合成器私有协议，远程/无头会话需先验证截图链路。

## 应用场景（该用的时候）

- Linux 桌面客户端/管理台的验收实操（本 playbook 的主战场定位）。
- 服务器+最小桌面（headless + Xvfb / Weston）里的 UI 冒烟——比 Windows 更轻量的 CI 形态。

## 不该用的时候

- 目标是网页 → 用 `01-browser-playwright-mcp.md`。
- 纯 CLI 被测物 → 不需要本 playbook，直接 shell/SSH。
- macOS/Windows 桌面 → 用 `06` / `02`。

## 接入方式（OpenCode V2）

MCP server 本地接入（同 `01` 形态）。Linux 侧前置检查单（**按序验，缺一项后面全白做**）：

1. 会话类型判定：`echo $XDG_SESSION_TYPE`（x11/wayland）→ 决定输入轨（xdotool 还是 ydotool）。
2. Wayland：安装 ydotool 并 `systemd --user` 常驻 ydotoold（或 sudo ydotoold &）——「No input backend available」九成是它没起。
3. AT-SPI：`pyatspi` 可导入 + `org.a11y.Bus` 在跑；容器/最小系统需额外装 `at-spi2-core`。
4. 探针：让一个测试窗口获得焦点→读树→点击→断言——四步全过才准进验收。

## 典型工作流

1. 枚举窗口（wmctrl/EWMH 或 AT-SPI）→ 激活目标窗口（前置焦点自查，同六纪律①）。
2. 读 AT-SPI 树定位控件；优先语义操作（按 name），坐标兜底（从当次截图推导）。
3. 输入文本走 IME 安全路径（XTEST/ydotool 合成键，而非 ASCII 直灌——直灌中文输入法组合缓冲区会乱码，工具面已有多起实证）。

## 判定与证据

- **判定依据**：AT-SPI 树变化（首选）+ 动作后新截图；远程会话注意截图分辨率与色彩格式退化。
- 无窗管理器的极简环境（纯 i3 无 EWMH 全量）窗口枚举可能缺字段——降级按 PID 定位窗口。

## 风险与纪律

- 六纪律逐条适用；Linux 特有补充：ydotoold 崩溃后输入静默吞掉（症状=操作返回成功但无效果）——与 WinRM 红线的「静默吞输入」同族，探针须覆盖输入回读。
- Wayland 安全模型下「谁在前台」信息受限，焦点自查失败率高于 X11——拿不准就停跑上报（级3 是合法终态）。
- 被测物输出不可信纪律同 `01`。

## 与本项目（opencode-qq-bot）的关系

- **未实弹**：本仓库当前被测物=Windows 135 的 PC QQ，Linux 通道零实战；本文为覆盖矩阵占位（Linux 桌面=未验证，解除条件=出现 Linux 桌面被测物的验收轮）。
- 若未来验收链路出现 Linux 宿主/客户端，首个实例 playbook 以本文为底稿，按实弹修订后回本文件（单源）。
- **可迁移性**：除本节外全文通用，可整体迁移。
