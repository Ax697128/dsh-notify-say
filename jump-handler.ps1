<#
.SYNOPSIS
  DSH 通知插件 —— 自定义协议处理器（Toast 精准跳转）。

.DESCRIPTION
  当用户点击 Toast 时，Windows 会调起本脚本并传入完整 URL：

      dshnotify://jump?session=session-abc12345

  本脚本做两件事：
    1. 把 sessionId 写到插件的 /pending-jump 端点（前端据此精确跳转）
    2. 调 dsh://open 把 DSH 窗口拉到前台（复用官方唤窗，不自己操作窗口）

  为什么需要它：点 Toast 走 dsh://open 时 DSH 本体是精确匹配（只认
  "dsh://open" 和 "dsh://open/"），无法携带参数；自有协议才能精确知道
  「用户点的是哪个会话」。多会话同时有通知时，这点是决定性的。

  安全：只接受 dshnotify://jump?session=<id> 形态，session 必须匹配
  字母数字/下划线/连字符（4-128 位）；不合法就静默退出，不执行其它内容。

  注意：本文件必须带 UTF-8 BOM —— 否则 PowerShell 5.1 会把中文读成
  乱码然后语法报错（实测踩到）。
#>
param(
  [Parameter(Mandatory = $false)]
  [string]$Url = ''
)

$ErrorActionPreference = 'SilentlyContinue'

# ── 1. 解析并校验 URL ─────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($Url)) { exit 0 }

$m = [regex]::Match($Url, '^dshnotify://jump/?(?:\?(.*))?$', 'IgnoreCase')
if (-not $m.Success) { exit 0 }

$query = $m.Groups[1].Value
$sid = ''
$sm = [regex]::Match($query, '(?:^|&)session=([^&]+)')
if ($sm.Success) {
  $sid = [System.Uri]::UnescapeDataString($sm.Groups[1].Value)
}

# 会话 id 白名单：DSH 的是 session-<uuid>；也容许纯 uuid / 字母数字
if ($sid -and ($sid -notmatch '^[A-Za-z0-9_-]{4,128}$')) { $sid = '' }

# ── 2. 找插件端口 ─────────────────────────────────────────────────────────
# 优先级：环境变量 > %LOCALAPPDATA% 下的 port.txt > 逐个探测常见端口
$port = 0
if ($env:DSH_NOTIFY_PORT -match '^\d+$') { $port = [int]$env:DSH_NOTIFY_PORT }

if ($port -le 0) {
  $cfgPath = Join-Path $env:LOCALAPPDATA 'dsh-notify-say\port.txt'
  if (Test-Path -LiteralPath $cfgPath) {
    $t = (Get-Content -LiteralPath $cfgPath -Raw).Trim()
    if ($t -match '^\d+$') { $port = [int]$t }
  }
}

# ── 3. 写 pending-jump（精确的会话 id）───────────────────────────────────
if ($sid) {
  $bodyObj = @{
    sessionId = $sid
    at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Compress

  # 候选端口来源（按可靠性排序）：
  #   ① port.txt —— 插件在注册路由时写入，**唯一可靠来源**
  #   ② 扫描本机正在监听的端口，挑能响应我们路由的那个
  #   ③ 几个历史见过的端口（兜底）
  $candidates = @()
  if ($port -gt 0) { $candidates += $port }

  # ② 动态发现：找本机正在监听、且能响应 /version 的端口。
  #    2026-10-20 踩坑：DSH 每次启动端口都变，写死候选必然漏。
  try {
    $listening = @()
    $tcp = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
      Select-Object -ExpandProperty LocalPort -Unique
    foreach ($p in $tcp) {
      if ($candidates -contains $p) { continue }
      if ($p -lt 1024 -or $p -gt 65535) { continue }
      $listening += $p
    }
    # 只保留"像 DSH"的（能响应我们的 version 端点）
    foreach ($p in $listening) {
      try {
        $v = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $p + "/api/dsh-notify-say/version") -TimeoutSec 1
        if ($v -and $v.ok) { $candidates += $p }
      } catch { continue }
    }
  } catch { }

  # ③ 历史端口兜底
  foreach ($p in @(59525, 53523, 50061, 19387)) {
    if ($candidates -notcontains $p) { $candidates += $p }
  }

  foreach ($p in $candidates) {
    try {
      $null = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $p + "/api/dsh-notify-say/pending-jump") `
        -Method Post -ContentType 'application/json' -Body $bodyObj -TimeoutSec 2 `
        -Headers @{ 'Origin' = ("http://127.0.0.1:" + $p) }
      break
    } catch { continue }
  }
}

# ── 4. 拉起 DSH 窗口（复用官方协议，不自己操作窗口）──────────────────────
#
# ⚠️ 2026-10-20：`Start-Process 'dsh://open'` 会**弹一个命令行窗口** ——
# 它走 ShellExecute，控制台子进程可见。用户实测「点 Toast 后拉起一个
# 命令行窗口」，就是这行造成的。
#
# 修法：
#   · 优先用 explorer.exe 转发 shell 协议（最干净，不产生可见控制台）
#   · 兜底才直接 Start-Process，并加 -WindowStyle Hidden
try {
  $explorer = Join-Path $env:SystemRoot 'explorer.exe'
  if (Test-Path -LiteralPath $explorer) {
    Start-Process -FilePath $explorer -ArgumentList 'dsh://open' -WindowStyle Hidden | Out-Null
  } else {
    Start-Process 'dsh://open' -WindowStyle Hidden | Out-Null
  }
} catch {
  try { Start-Process 'dsh://open' -WindowStyle Hidden | Out-Null } catch { }
}
