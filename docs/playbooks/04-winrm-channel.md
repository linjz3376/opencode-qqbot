# Playbook：WinRM 通道配置（Windows 远程管理通用手册）

> 引入与单源声明：原样引入自 pcqq-venv/docs（2026-11，owner 裁定本项目为单源，源项目原件冻结不再修订）；后续修订以本仓库 git log 为准。
> 本项目适配：跨机拟人驱动的规约层红线见 `../human-execution-endpoint.md`（win-native 档：WinRM→/it 计划任务链）；与 QuickDesk 跨机路线（`03-remote-quickdesk.md`）互为替代，先判别实验再考虑替换。驱动链资产随验收轮存 `tests/reports/<轮次>/tooling/`。

> 定位：**可迁移的通用学习资料**——任何「控制端 → Windows 目标机」的远程管理与远程桌面自动化场景适用。
> 正文一律用占位符（`<目标机IP>`、`<管理员账户>`、`<变量前缀>`）；「135/140」仅作为贯穿全文的
> **实战用例**（控制端 140 / 执行端 135），不是正文口径。

---

## 0. 心智模型（先建对，后面全顺）

| 认知 | 内容 |
|---|---|
| WinRM 是什么 | WS-Man over HTTP(S)，端口 **5985/5986**，命令通道 |
| WinRM 不是什么 | **不能点按钮、截不到用户桌面**——会话跑在 Session 0，与交互桌面隔离 |
| WMI/RPC 是另一条路 | 走 135 + 动态端口，**防火墙默认拦**，远端机基本不可选（0x800706BA） |
| Test-WSMan ≠ 能连 | 它只往**远端**发探测包，**不需要本机 WinRM 服务**，谁都通；真会话要过三关：本机服务 + TrustedHosts + 凭据 |
| TrustedHosts 是 Windows 客户端的锁 | 工作组 + IP + NTLM 必查此名单；**pywinrm 等非 Windows 客户端没有这个概念**——pywinrm 拿凭据就能连，Invoke-Command 不行 |
| 看桌面/点按钮的唯一路径 | 把执行体（计划任务 `/IT`）放进**目标机的交互会话**，WinRM 只当控制面：投递指令、拉回结果 |

**拓扑（通用）**：控制端（发起方，可能锁屏/无图形会话，不影响）→ WinRM → 执行端（Windows 机，console 会话渲染自己的桌面）。

---

## 1. 控制端一次性配置

全部要**管理员**身份（非管理员会话改不了 TrustedHosts）。占位符替换为目标机实况：

```bat
:: ① 启动 WinRM 服务（Windows 客户端默认「手动/停止」）
net start WinRM
:: 可选：开机自启
sc config WinRM start= auto

:: ② 信任目标机（工作组 NTLM 必做；必须用 winrm set，见排错表）
winrm set winrm/config/client @{TrustedHosts="<目标机IP>"}

:: ③ 验证（应显示 TrustedHosts = <目标机IP>）
winrm get winrm/config/client
```

**用例（140 → 135）**：`net start WinRM` 后 `winrm set winrm/config/client @{TrustedHosts="192.168.20.135"}`。

三个版本陷阱：
- 在 **cmd** 里跑 `Set-Item WSMan:...` → `'Set-Item' is not recognized`（那是 PowerShell 命令）；
- 在 **PowerShell 7** 里找 `WSMan:` 盘 → 不存在（PS7 无此 provider，用 `winrm` 命令或 5.1）；
- 用 `reg add` 直接写注册表 TrustedHosts → 值在注册表里但服务不认（新版 Windows 必须通过 WSMan API 落配置，`winrm set` 才生效）。

> 不要顺手跑 `winrm quickconfig`：它会额外开放本机入站防火墙 + 注册 HTTP 监听（把本机变成可被远程管理的目标）。只当客户端用时 `net start` 就够。

### 1.1 Shell 使用纪律

1. **复杂命令写 `.ps1` 用 `-File` 跑，别拼 `-Command`**：嵌套引号经 PowerShell→powershell.exe 逐层解析必炸（`ScriptBlock should only be specified...`）。多语句/含引号的逻辑一律落盘成脚本，`powershell.exe -NoProfile -ExecutionPolicy Bypass -File xxx.ps1`。
2. **同族 cmdlet 两条传输层，报错完全不同**：PS7 `Get-CimInstance -ComputerName` 走 **WSMan**（吃 TrustedHosts）；5.1 `Get-WmiObject -ComputerName` 走 **DCOM/RPC**（吃防火墙，报 0x800706BA/拒绝访问）。选 cmdlet 前先知道它走哪条传输层。
3. **「命令不存在」先怀疑环境、再怀疑命令**：受限 shell 里 `quser.exe`/`schtasks.exe` 可能不可见，cmdlet 与远端会话正常。优先 cmdlet 等价物；`.exe` 只在远端正常 shell 里依赖。
4. **setx 注入的值，新进程 `$env:` 可能读不到**（父进程环境快照不刷新）：脚本从注册表读 `[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('<名>')` 最稳。
5. **多段机验输出禁用 `Format-Table`**：缓冲会把多段结果交错打乱；机验输出一律 `Write-Host` 字符串或 `| Out-String` 逐段定型。

### 1.2 生成侧 PowerShell 防错纪律（AI 生成代码专用）

> 根因：一条命令穿过 6 层解析器（输出→JSON 转义→进程启动器→外层 shell→`-Command`→PS 解析器→目标程序），每层重解释引号/`$`/反引号；实测主流模型生成 PowerShell 逾半数不合规，引号嵌套是头号失败源。以下为写作纪律 + 执行前三道闸。

**写作纪律（7 条）**：

1. 多语句一律 `.ps1` + `-File`，永不拼内联 `-Command`（外层会提前展开内层 `$变量`）。
2. 默认单引号字面串；需插值才双引号并写 `${var}` 划界；嵌套引号超两层 → here-string `@'...'@`（结束符顶格行首）。
3. 原生 exe 用参数数组 `& $exe @argList`（splatting）；禁字符串拼接命令、禁 `Invoke-Expression`；空串参数不得丢。
4. 禁反引号续行（行尾空格静默断续，微软专设 `PSMisleadingBacktick` 规则）；管道/逗号/运算符后自然断行。
5. **脚本正文全 ASCII**：中文/全角标点只进运行时数据；必须写中文的 .ps1 存 **UTF-8 with BOM**——5.1 对无 BOM 文件按系统 ANSI(GBK) 解码，全角标点字节会吃掉闭合引号报 `TerminatorExpectedAtEndOfString`。
6. 禁智能引号 `'' ""` 与全角标点（）：；混入代码——PS 把智能引号当正常引号**静默解析**。
7. `"$var:"` 是作用域语法必炸 → `"${var}:"`；表达式参数加括号：`-Index (100..120)`。

**执行前三道闸**：

```powershell
# 闸1 解析闸：不执行只解析，未闭合字符串/括号在此拦截
$errs = $null; $toks = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$toks, [ref]$errs)
if ($errs.Count) { $errs | ForEach-Object Message; exit 1 }
# 闸2 PSScriptAnalyzer（有则跑）：Invoke-ScriptAnalyzer -Path $path
# 闸3 版本对表：5.1 Get-WmiObject(DCOM) vs 7.x Get-CimInstance(WSMan)；7.3+ $PSNativeCommandArgumentPassing 对 bat/cmd 自动 Legacy
```

**口诀**：引号嵌套超两层必重构；命令串出现第 2 个 `$` 必落盘成文件；正文出现非 ASCII 必查 BOM。

---

## 2. 被控端（目标机）要求

| # | 条件 | 验证 |
|---|---|---|
| 1 | WinRM 服务运行 + 5985 防火墙放行 | 任意机器 `Test-WSMan <目标机IP>` 有回显 |
| 2 | 有**本地管理员**账户可用（Invoke-Command 的 `-Credential` 用它） | 连接后 `whoami` / `quser` 正常回显 |
| 3 | 有活动控制台会话且**不锁屏**（拟人操作前置） | `quser` 看 console 会话 Active；无 logonui 进程 |

**用例（135）**：`Test-WSMan 192.168.20.135` 直通；console 会话 `linjz` Active 未锁屏；QQ 已登录。

---

## 3. 凭据注入与生命周期（纪律：不回显、不记录、用完即焚）

```bat
:: 注入（持久到 HKCU\Environment；当前用户任意新进程可读，其他 Windows 用户读不到）
setx <变量前缀>_USER "<目标机管理员账户>"
setx <变量前缀>_PASS "<密码>"
```

- **读取**：脚本从注册表读，转 SecureString → PSCredential，全程不回显。
- **不要用** `set`（只活当前窗口）或贴进命令行参数（进进程列表与日志）。
- **用完清除**：`[Environment]::SetEnvironmentVariable('<名>',$null,'User')`。cmd 里 setx 的历史随窗口关闭消失；PowerShell 里跑过则检查 PSReadLine 历史文件。

**用例**：变量名 `OPENCODE_L135_USER/PASS`（命名规范：`<前缀>_<目标别名>_<USER|PASS>`），用后已删。

---

## 4. 最小探测链（通没通，四拍定音）

```powershell
# 拍1：远端服务在不在（不需要本机服务/凭据/TrustedHosts）
Test-WSMan <目标机IP>
# 拍2：本机服务在不在（winrm set 依赖它；0x80338012=没跑 → net start WinRM）
winrm get winrm/config/client        # 确认 TrustedHosts 已含目标
# 拍3：真会话（此处才需要 凭据+TrustedHosts）
$sec = ConvertTo-SecureString $env:<前缀>_PASS -AsPlainText -Force
$cred = New-Object PSCredential($env:<前缀>_USER, $sec)
Invoke-Command -ComputerName <目标机IP> -Credential $cred -ScriptBlock { hostname; quser }
# 拍4：桌面状态（quser 会话 Active / logonui 在不在 / 交互用户是谁 / 分辨率）
```

---

## 5. 看桌面 / 投动作的交互会话通道（Session 0 破壁）

WinRM 会话里 `CopyFromScreen` 截到的是 Session 0 黑屏；**截图与点击必须发生在目标机的交互会话内**：

```powershell
# 投递截图脚本（CopyFromScreen 抓虚拟屏全帧）
Copy-Item .\snap.ps1 -Destination '<目标机临时目录>' -ToSession $s
# 注册并触发「只在用户登录时运行」的任务 → 跑在 console 会话
Invoke-Command -Session $s -ScriptBlock {
    schtasks /Create /F /IT /TN "<任务名>" /SC ONCE /ST 23:59 /TR "powershell -NoProfile -ExecutionPolicy Bypass -File <目标机脚本路径>"
    schtasks /Run /TN "<任务名>"
}
# 拉回判读（agent 读图下语义判断）
Copy-Item '<目标机截图路径>' -Destination . -FromSession $s
Invoke-Command -Session $s -ScriptBlock { schtasks /Delete /F /TN "<任务名>" }   # 用完即删
```

要点：
- `/IT`（interactive）**必须**——Session 0 起的 GUI 进程看不到桌面；任务**不要提权**（提权起的 Electron 类进程会挂死）。
- 反向投动作同理：把 pyautogui 动作脚本按同一通道投递执行；图片回传可换 `Copy-Item -FromSession`，不必走 HTTP 接收端。

**用例（135）**：截图落 `C:\Users\linjz\AppData\Local\Temp\oc135-desktop.png`，拉回后判读出桌面 1920×1080、QQ 已登录、前台有遮挡终端——全链路可行。虚拟显示器（如 Sharing Monitor）的 WMI 分辨率可能空值/漂移，**以截图实测为准**。

---

## 6. 排错速查表（症状 → 根因 → 处置）

| 症状 | 根因 | 处置 |
|---|---|---|
| `Test-WSMan` 通，`Invoke-Command` 报「必须 TrustedHosts 或 HTTPS」 | 工作组+IP+NTLM 的客户端锁未开 | §1 步骤②（winrm set，不是 reg add） |
| `winrm set` 报 0x80338012「无法连接到请求中指定的目标」 | **本机** WinRM 服务没跑 | `net start WinRM` 后重跑 |
| `'Set-Item' is not recognized` | 在 cmd 里跑了 PowerShell 命令 | 切 PowerShell，或全程用 `winrm` 命令 |
| PS7 里 `WSMan:` 盘不存在 | PS7 无 WSMan provider | 用 `winrm get/set`（或 powershell.exe 5.1） |
| reg add 写了注册表但 `winrm get` 显示空、客户端不认 | 新版 Windows 服务不吃裸注册表写入 | 必须用 `winrm set` 经 WSMan API 落配置 |
| `Get-WmiObject ... 0x800706BA` | 目标机防火墙拦 RPC/DCOM | **放弃 WMI 通道**，全程走 WinRM；不要为此去开 RPC 端口 |
| 无凭据 WMI/连接「拒绝访问」 | 当前账户无目标机远程管理权 | 注入目标机本地管理员凭据（§3） |
| 截图全黑 / 截不到目标窗口 | 截图代码跑在 Session 0 | 执行体必须经 schtasks `/IT` 进交互会话（§5） |
| `ScriptBlock should only be specified...` | `-Command` 嵌套引号被逐层解析 | 逻辑落盘 `.ps1`，用 `-File` 执行（§1.1-1） |
| PS7 的 CIM 报 TrustedHosts / 5.1 的 WMI 报 RPC 错 | 同族 cmdlet 传输层不同（WSMan vs DCOM） | 先确认 cmdlet 走哪条通道再排错（§1.1-2） |
| 本地 `xxx.exe 不是命令` | 受限 shell 环境缺 exe，非命令错误 | 换 cmdlet 等价物；exe 留给远端正常 shell（§1.1-3） |
| Invoke-Command 慢/超时 | 网络或防火墙 | WinRM 通道本身秒级；超 10s 先查防火墙与 IP |

---

## 7. 安全收尾清单（每次任务结束）

- [ ] `<前缀>_PASS`/`USER` 已删（`SetEnvironmentVariable(...,$null,'User')`）
- [ ] 临时计划任务已删（`schtasks /Delete /F /TN <名>`）
- [ ] 远端临时脚本/截图已清（`Remove-Item` 经 Session）
- [ ] TrustedHosts 与 WinRM 服务**默认保留**（下次免重配）；要收紧：`winrm set winrm/config/client @{TrustedHosts=""}` + `net stop WinRM`

---

## 附：实战用例（控制端 140 → 执行端 135）

把上文占位符落到一台真实机器的完整顺序，供对照：

1. `Test-WSMan 192.168.20.135` 通 → 误判「可用」，实际只证明远端服务活着；
2. `Invoke-Command` 被 TrustedHosts 拦 → 非管理员会话改不了配置，转 WMI 绕行；
3. WMI 吃 `0x800706BA` → 135 防火墙拦 RPC，**此路不通**（协议选错）；
4. 管理员 cmd 跑 `Set-Item` → 命令不存在（cmd ≠ PowerShell）；
5. `winrm set` 报 0x80338012 → 本机 WinRM 服务从没启动过；
6. `net start WinRM` 后再 `winrm set` → 仍不认此前 `reg add` 的值 → **裸写注册表无效**，winrm set 一次成功；
7. 凭据 setx 注入 → 四拍全过 → `schtasks /IT` + `CopyFromScreen` + `Copy-Item -FromSession` → **无 RDP 看见 135 桌面**。

**教训**：通道排查顺序 = 「协议选对（WinRM 不选 WMI）→ 本机服务 → 本机信任名单（winrm set）→ 凭据 → 交互会话执行面」，每步有独立验证命令，不要跳步试。
