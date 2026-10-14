# OpenQQ Bot 启动器（Phase 2 服务化 E5；2026-10-14 单点化改造）
# - 密钥/配置单点：~/.openqq/.env（由 src/config.ts ensureConfig 载入），本文件不再内联任何密钥
# - 源码真相源：C:\Users\linjz\dev\opencode-qq-bot（git 仓库），不再运行 node_modules 副本
# - 单实例锁 + 日志编号轮转（保留最近 10 份）+ 退出码传播（任务调度器失败重启依据）
$ErrorActionPreference = "Continue"
$logDir = "C:\Users\linjz\AppData\Local\Temp\opencode"
$repo = "C:\Users\linjz\dev\opencode-qq-bot"
$bun = "C:\Users\linjz\AppData\Roaming\npm\node_modules\bun\bin\bun.exe"

# --- 单实例锁：匹配 CommandLine 含 opencode-qq-bot 的 bun（新仓路径与旧 npm 路径均命中）---
$existing = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -match 'opencode-qq-bot' }
if ($existing) {
  Write-Output "[launcher] 已有实例 pid=$($existing.ProcessId)，退出（单实例锁）"
  exit 0
}

# --- 首启保护：.env 缺失时 ensureConfig 会走交互式问询（隐藏控制台无人应答 → 挂死）---
if (-not (Test-Path "C:\Users\linjz\.openqq\.env")) {
  Write-Output "[launcher] FATAL: 缺少 C:\Users\linjz\.openqq\.env（单点配置），拒绝启动"
  exit 1
}

# --- 日志编号轮转：取最大号 +1；清理 10 份以前的旧日志 ---
$nums = @()
Get-ChildItem "$logDir\openqq*.log" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -match '^openqq(\d+)\.log$') { $nums += [int]$Matches[1] }
}
$next = if ($nums.Count -gt 0) { ($nums | Measure-Object -Maximum).Maximum + 1 } else { 2 }
$outLog = Join-Path $logDir "openqq$next.log"
$errLog = Join-Path $logDir "openqq$next.err.log"
$cutoff = $next - 10
Get-ChildItem "$logDir\openqq*.log" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -match '^openqq(\d+)(\.err)?\.log$') {
    if ([int]$Matches[1] -le $cutoff) { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
  }
}

Write-Output "[launcher] 启动 OpenQQ Bot（仓库源码）→ $outLog（编号轮转，保留最近 10 份）"
$proc = Start-Process -FilePath $bun -ArgumentList (Join-Path $repo "bin\openqq.js") `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -NoNewWindow -Wait

# --- bun 退出 = 异常（正常应长驻）：非零退出触发任务调度器失败重启；零退出也强制按失败处理 ---
if ($proc.ExitCode -ne 0) { exit $proc.ExitCode }
exit 1
