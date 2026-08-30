# One-shot restart of the PDFEditor server: non-blocking AND windowless.
# Start the server via WScript.Shell COM: Run(cmd, 0, False) hides the window,
# detaches the process completely, and involves no event subscriptions, so the
# PowerShell script exits cleanly and the caller shell never hangs.
#   - Start-Process -WindowStyle Hidden + -Redirect*: PS 5.1 hang bug (old
#     restarts froze until manually aborted).
#   - System.Diagnostics.Process + Register-ObjectEvent: event subscription
#     keeps PowerShell alive while the server lives (also hangs).
#   - WMI cmd /c: works but pops a visible cmd window.
# NOTE: keep this file ASCII-only - PowerShell 5.1 reads BOM-less files as ANSI.
# NOTE: $root must not contain spaces (cmd /c cd /d quoting).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 3000

# 1) Kill the old server listening on the port (plus any npm start wrapper)
$pids = @()
try {
  $pids += Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess
} catch { }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*npm-cli.js*start*' } | ForEach-Object { $pids += $_.ProcessId }
$pids = $pids | Sort-Object -Unique
foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

# 2) Start the new server: hidden window, cmd does the log redirection internally
$ws = New-Object -ComObject WScript.Shell
$ws.Run("cmd /c cd /d $root && node server.js > .server.log 2> .server.err.log", 0, $false) | Out-Null
Start-Sleep -Seconds 2

# 3) Health check
try {
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/docs" -TimeoutSec 5
  Write-Host "server restarted OK, docs = $($r.files.Count)"
} catch {
  Write-Host "health check failed: $_"
  $errPath = Join-Path $root '.server.err.log'
  if (Test-Path $errPath) { Get-Content $errPath -Tail 20 }
  exit 1
}
