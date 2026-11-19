# Playbook 2：本机桌面自动化 — Windows-MCP / computer use

> 时效声明：本文的 stars、commits、工具数等均为 2026-11 检索时点值，随版本漂移；使用前以各官方仓库为准。

## 一句话定位

用于**本机 Windows 桌面应用**（含 QQ 客户端）的结构化自动化：AI 通过 Windows UI Automation（UIA）读控件树，按元素标签点击，不靠截图猜坐标。是"QQ 客户端版 Playwright MCP"的最接近形态。

## 组件与形态

- **Windows-MCP**（CursorTouch）：约 11.9k stars / 893 commits，MIT，Python 3.14+。约 20 个工具：`Snapshot`（UIA 树 + 交互元素 + 坐标）、`Click`（按标签或坐标）、`Type`、`Screenshot`（`use_vision=True`）、`App`、`PowerShell`、`FileSystem`、`Clipboard`、`Process`、`Registry`、`MultiSelect`/`MultiEdit`、`WaitFor`、`ControlStatus` 等。动作间隔约 0.2 至 0.5 秒；有桌面控制权交接（relaxed/balanced/strict 策略、接管热键）、auth key/IP 白名单/TLS/OAuth、工具白名单。
- **computer use（视觉型）**：截图 + 视觉模型猜坐标。能操作任意 GUI，但换 DPI/窗口移动即失效、中文靠 OCR 会误读、每步付截图 token。作为 UIA 不可用时的降级，不作首选。
- 相关同类（按需要选用）：`FlaUI-MCP`（snapshot+ref 的极简 API，115 stars，Electron 支持 partial）、`desk-mcp`（46 工具、UIA→MSAA→OCR 回退、差分快照，10 stars）、`oswright`（增量感知、token 成本约为 Windows-MCP 的 1/16.9，但可靠性 19/20 略低，4 stars）。

## 应用场景（该用的时候）

- 本机 Windows 原生应用 / WPF / Win32 应用的结构化操作。
- 本机 QQ 客户端的消息读取、会话切换、发送（需满足下方硬条件）。
- 需要与本地文件系统、剪贴板、PowerShell、进程交互的桌面流程。
- 需要"结构化快照 + 语义点击"而非像素操作的场景。

## 不该用的时候

- 目标是网页 → 用 `01-browser-playwright-mcp.md`（浏览器，更稳）。
- 需要控制另一台电脑 → 用 `03-remote-quickdesk.md`（跨机）。
- QQ 处于后台、无 GPU 且未开启 accessibility、或 UIA 树不完整 → 先满足硬条件，否则降级 computer use 或阻塞上报。

## 接入方式（OpenCode V2）

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "windows-mcp": {
        "type": "local",
        "command": ["uvx", "windows-mcp", "serve"],
        "environment": { "ANONYMIZED_TELEMETRY": "false" },
      },
    },
  },
}
```

或 `opencode mcp add windows-mcp -- uvx windows-mcp serve`。工具名规范化为 `windows_mcp_snapshot`、`windows_mcp_click` 等。默认 Code Mode；配置自动热加载。

## QQ 客户端的硬条件（来自社区实证；QQ 版本更新后须逐条复核）

1. **QQ NT 仅对前台窗口构建完整 UIA 树**，后台时树约 9 个节点、找不到搜索框。任何 UIA 操作前须把 QQ 面板恢复并置前，等待树重建。
2. **无 GPU 设备**需以 `QQ.exe --force-renderer-accessibility` 启动，否则无法枚举控件（只能选到整个窗口）。
3. QQ 专用类名可提升稳定性：输入框 `qq-msg-editor`、会话头 `chat-header__contact-name`、发送按钮 `发送`。社区项目 `treers2/qq-operations`（UIA 类名法）与 `QQSafeChat`（157 stars）已验证此路径，可作驱动层参考。
4. 消息列表仅暴露视口内内容，读历史需滚动重读；效率模式下读回可能重复，按内容去重。
5. 中文输入走剪贴板（`Set-Clipboard` + `Ctrl+V`），不用 SendKeys。
6. 收件人安全阀：发送前比对会话头联系人名，不符即中止；发送后读回验证。

## 典型工作流

1. 环境闸：确认 QQ 前台、窗口可见、UIA 树完整（先 `Snapshot` 看节点数）。
2. `Snapshot` 读控件树，定位会话/输入框/发送按钮的标签或类名。
3. `Click`/`Type` 操作 → 再次 `Snapshot` 或 `Screenshot` 断言变化。
4. 发送类操作前执行本项目"发送前三件套"（见下），发送后读回确认。

## 判定与证据

- **主证**：操作后的新 `Snapshot`（UIA 状态）或 `Screenshot`（用户可见画面）。
- **辅证**：REST/台账/日志等机器读数，与 UI 展示逐格对照。
- 无可见变化 = 该操作不算完成，重试一次仍无变化则记「操作无响应」转缺陷候选。

## 风险与纪律

- 桌面自动化默认 `relaxed` 策略即可直接改真实数据；保留人工确认，先读 SAFETY/SECURITY 文档。
- 必须在已登录、解锁的交互式桌面会话运行；服务/锁屏会话会吞输入。
- **opencode-qq-bot 项目专属**：遵守其 AGENTS.md §5 进程红线（禁止裸杀、重启唯一入口）；§7 发送前三件套（probe 窗口 / 截图确认当前绑定会话 / 核 `~/.openqq/inflight.json` 在途）；有在途宁等或换会话，不注入、不即兴中断。
- QQ 客户端若就是 bot 的 persona 面，AI 点击等于对外发消息，必须套用双会话架构纪律。

## 与本项目（opencode-qq-bot）的关系

- 本机 QQ 实操的首选 playbook；与现役 `uat-driver.ps1`（Win32 坐标法）互补：UIA 类名法抗 DPI/窗口漂移，坐标法抗 UIA 缺失。
- 跨机驱动时用 `03-remote-quickdesk.md` 或现役 WinRM 链；本机时本 playbook。
- **可迁移性**：除本节与「项目专属」标注条目外，本文为通用内容，可整体迁移到其他项目使用。
