# OpenQQ 看门狗（Phase 2 服务化 E6，2026-10-13）
# 每 10 分钟由计划任务 OpenQQ-Bot-Watchdog 调起：
#   进程缺失，或 心跳文件陈旧(>5 分钟)/缺失(进程>2 分钟) → 杀残留并拉起 OpenQQ-Bot。
# 心跳由 bot 每 60s 写入 ~/.openqq/heartbeat（事件循环存活证明）——
# 覆盖"进程在但僵死"的静默僵尸（2-day silent zombie 教训），纯进程检查盖不住这类。
$logDir = "C:\Users\linjz\AppData\Local\Temp\opencode"
$hb = "C:\Users\linjz\.openqq\heartbeat"
$watchdogLog = Join-Path $logDir "watchdog.log"

function Log([string]$msg) {
  Add-Content -Path $watchdogLog -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg)
}

# 匹配 dev 仓路径与 npm 缓存路径（opencode-qqbot 无连字符）两种形态；bun/node 双运行时。
# 多匹配时（活跃+待命并存）取任一判活性、清理时全杀。
$bots = @(Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'opencode-qq-?bot' })
$bot = $bots[0]

$reason = $null
if (-not $bot) {
  $reason = "进程缺失"
}
elseif (Test-Path $hb) {
  $ageMin = ((Get-Date) - (Get-Item $hb).LastWriteTime).TotalMinutes
  if ($ageMin -gt 5) {
    $reason = "心跳陈旧 $([int]$ageMin) 分钟（进程疑似僵死）"
    $bots | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }
}
else {
  # 心跳文件不存在：给刚启动的实例（首次心跳在启动即写）留 2 分钟余量
  $procAgeMin = ((Get-Date) - $bot.CreationDate).TotalMinutes
  if ($procAgeMin -gt 2) {
    $reason = "心跳文件缺失（进程 pid=$($bot.ProcessId) 已运行 $([int]$procAgeMin) 分钟）"
    $bots | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }
}

if ($reason) {
  Log "触发重启：$reason"
  Start-ScheduledTask -TaskName "OpenQQ-Bot"
  Log "已发送 Start-ScheduledTask OpenQQ-Bot"
}
# 健康时静默（每 10 分钟一行会膨胀日志；需要审计时放开下行）
# else { Log "健康检查通过" }
