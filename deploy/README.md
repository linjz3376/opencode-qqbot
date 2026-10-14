# deploy/ — 服务化运维脚本（真相源）

运行时位置在 `~/.openqq/`（计划任务动作引用该路径）。本目录是**入库副本**：

| 文件 | 运行时路径 | 作用 |
|---|---|---|
| `start-openqq.ps1` | `~/.openqq/start-openqq.ps1` | 启动器：单实例锁、`.env` 缺失快速失败、日志编号轮转、退出码传播 |
| `launch-hidden.vbs` | `~/.openqq/launch-hidden.vbs` | 无窗口动作宿主（wscript GUI 宿主 + 隐藏 powershell），**透传子进程退出码** |
| `watchdog.ps1` | `~/.openqq/watchdog.ps1` | 10 分钟看门狗：进程缺失 / 心跳 >5min 陈旧 → 杀残留 + Start-ScheduledTask |

## 修改流程
1. 在本目录改（git 提交），再复制到 `~/.openqq/` 生效；或
2. 在 `~/.openqq/` 应急改完后**立即复制回本目录提交**——两处不一致 = 下次部署回滚。

## 教训记录（2026-10-14）
- E7b 把任务动作换成 `sh.Run(..., 0, False)`（不等待）→ 任务恒判成功，"失败 1 分钟重启×3"失效
  约 1 天才被评审翻出。现为 `(..., 0, True)` + `WScript.Quit exitCode`。
- VBScript 方法**作为表达式取返回值时参数必须整体加括号**：`x = sh.Run "cmd", 0, True`
  是编译错误（弹错误框、脚本不执行）；必须 `x = sh.Run("cmd", 0, True)`。

## 绝不入库
- `~/.openqq/.env`（明文密钥，ACL 已 icacls 收紧为仅当前用户）。
- `~/.openqq/sessions.json` / `settings.json` / `greeted.json`（运行时状态）。
