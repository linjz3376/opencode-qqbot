# Playbook 3：跨机桌面控制 — QuickDesk（client + mcp 桥接 / host）

> 时效声明：本文的 stars、commits、工具数等均为 2026-11 检索时点值，随版本漂移；使用前以各官方仓库为准。

## 一句话定位

用于 **A 电脑驱动 B 电脑**的桌面实操：QuickDesk 把远程桌面（Chromium Remoting / WebRTC）与内置 MCP Server 打包，AI 以工具调用方式看屏、点击、验证。是三者中唯一原生解决"跨机"的一档。

## 组件与形态

- **B（被控端 / host）**：安装 QuickDesk 应用，以 host 模式运行，提供设备 ID + 访问码；捕获 B 屏幕、注入键鼠。必须处于已登录、解锁的交互会话。
- **A（主控端 / client + MCP）**：安装 QuickDesk 应用（client 模式）连接 B；同时运行 `quickdesk-mcp` 桥接，OpenCode 通过它操作远端。
- **MCP 双传输**：
  - stdio（默认）：AI 客户端拉起 `quickdesk-mcp`，经 WebSocket 连本机 QuickDesk GUI（`ws://127.0.0.1:9600`），再经 WebRTC 到 B。同机最简。
  - HTTP/SSE：A 上的 QuickDesk 把 `quickdesk-mcp` 暴露到 `0.0.0.0:18080`（端点 `/mcp`），供远程或多个 AI 客户端连接。
- 40+ MCP 工具，核心是 OCR 判断环：`get_ui_state`（一次拿分辨率 + OCR 文本块带坐标 + 活动窗口标题）、`find_element` / `click_text`（按可见文字找并点击）、`wait_for_text`、`verify_action_result`、`assert_screen_state`、`screen_diff_summary`、事件驱动 `wait_for_*`。
- 治理：full/readonly token、设备白名单、速率限制、会话超时、审计日志、危险操作拦截；`connect_device(show_window=false)` 可在 A 端无头运行；支持 privacy screen / 虚拟显示器；可自托管信令与 TURN。
- 成熟度：约 580 stars / 445 commits，MIT，协议底座为 Chromium Remoting（与 Chrome 远程桌面同源）。

## 应用场景（该用的时候）

- AI 在 A 上操作 B 的桌面应用（含 QQ 客户端），B 与 A 不同机。
- 需要 AI"看屏判断"：错会话/错布局识别、动态 UI、登录/验证码、探索性验证。
- 多设备编排、批量远程操作、需要审计与异常处理闭环的场景。
- 替代或补充跨机 WinRM 链（当脚本驱动不够、需要 AI 自主判断时）。

## 不该用的时候

- 本机操作 → 用 `02-desktop-windows-mcp.md`（桌面；QuickDesk 跨机优势在本机无增量，还多装两端应用）。
- 任务全在网页 → 用 `01-browser-playwright-mcp.md`（浏览器；DOM 快照比 OCR 稳）。
- B 端无法保持交互会话/解锁 → 先解决会话问题，否则帧捕获黑屏。
- 无公网 IP 且需跨网络 → 需自托管信令/TURN 或隧道，评估成本后再决定。

## 接入方式（OpenCode V2）

A 端 QuickDesk 切 HTTP/SSE 模式并开启 MCP HTTP 服务后，OpenCode 作为远程 MCP 客户端连接：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "quickdesk": {
        "type": "remote",
        "url": "http://<A的IP>:18080/mcp",
        "oauth": false,
        "headers": { "QUICKDESK_TOKEN": "{env:QUICKDESK_TOKEN}" },
      },
    },
  },
}
```

或 CLI：`opencode mcp add quickdesk --url http://<A的IP>:18080/mcp --header 'QUICKDESK_TOKEN={env:QUICKDESK_TOKEN}'`。

注意：MCP 桥接在 **A（主控端）**，不在 B；OpenCode 与 QuickDesk 同机时可直接用 stdio 模式。令牌放环境变量，不写明文进配置。远程访问需 `--host 0.0.0.0` 与 token/白名单，不建议裸奔。

## 典型工作流

1. B 端启动 host，记下设备 ID + 访问码，保持登录解锁。
2. A 端 `get_host_info` → `connect_device(device_id=B, access_code=..., show_window=false 可选)`。
3. `screenshot` / `get_ui_state` 观察 B 桌面 → `find_element` / `click_text` 定位并操作。
4. `verify_action_result`（期望文本/窗口标题）验证；`screen_diff_summary` 看变化；异常即上报。
5. `disconnect_device` 清理连接。

## 判定与证据

- **主证**：B 端新鲜截帧 + OCR 文本块（带时间戳），用户可见行为判定。
- **辅证**：`get_ui_state` 的活动窗口标题、事件流、审计日志。
- `max_width` 缩放截图后，坐标须按 `get_screen_size` 换算回物理分辨率。

## 风险与纪律

- full token 泄露等于 B 桌面全权失守；用 readonly token 做只读侦察，写操作临时提权。
- 危险操作拦截不等于沙箱；敏感操作保留人工确认。
- **opencode-qq-bot 项目专属**：套用其 AGENTS.md §7 发送前三件套；§5 进程红线（禁止裸杀、重启唯一入口）；UI 主证=截图回读，机器读数仅辅证。
- QuickDesk 的 AI 自主点击天然可能绕开在途检查，首次验证务必在专用测试会话、空闲窗口进行。
- 引入第三方 C++/Rust 组件与信令依赖，评估供应链与网络暴露面。

## 与本项目（opencode-qq-bot）的关系

- 对应 AGENTS.md §7 指挥家工作法：A（AI 会话）经局域网驱动目标机 PC QQ 客户端做实操验证（具体机器与网段属环境数据，见项目侧文档，不入本文）。
- 现役 WinRM `/it` 计划任务链（`exec135.ps1` → `uat-driver.ps1`）是脚本驱动；QuickDesk 是 AI 看屏驱动的增量选项，二者可并存、先判别实验再考虑替换。
- 现役链的完整操作手册见 `04-winrm-channel.md`（通道配置）与 `05-no-rdp-humanops.md`（无 RDP 拟人操作）。
- 保留现役链路做兜底，不一次性切换。
- **可迁移性**：除本节与「项目专属」标注条目外，本文为通用内容，可整体迁移到其他项目使用。
