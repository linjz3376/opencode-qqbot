' OpenQQ hidden launcher: start a PowerShell script with NO visible window.
' wscript.exe is a GUI-subsystem host (no console of its own); Run style 0
' creates the child console hidden (no Windows Terminal delegation window).
' 2026-10-14 修复①：bWait=True 并透传子进程退出码——否则任务恒判成功，
'   OpenQQ-Bot 的"失败 1 分钟重启×3"永不触发（E7b 隐性回归）。
' 2026-10-14 修复②：VBScript 方法作为表达式取返回值时参数必须整体加括号，
'   `exitCode = sh.Run ...` 是编译错误（会弹错误框且脚本不执行）。
' Usage: wscript.exe launch-hidden.vbs "C:\path\to\script.ps1"
Dim sh, ps1, exitCode
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 1 Then WScript.Quit 1
ps1 = WScript.Arguments(0)
exitCode = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, True)
WScript.Quit exitCode
