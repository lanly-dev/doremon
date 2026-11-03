# Doremon Windows scanner.
# Streams one snapshot per interval to stdout as tab-separated lines:
#   BEGIN <tsMs> <cores>
#   P <pid> <name> <cpuSeconds> <memBytes> <threads> <windowTitle>
#   L <proto> <address> <port> <state> <pid>
#   END <tsMs>
# Runs as a single long-lived process so the app never pays PowerShell startup
# cost on every refresh.

param([int]$Interval = 2000, [int]$Parent = 0)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$out = [Console]::Out
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$cores = [Environment]::ProcessorCount
$clean = "`r`n`t"

function Emit([string]$line) {
  $out.WriteLine($line)
  $out.Flush()
}

while ($true) {
  # Exit when the app is gone, so a force-killed app cannot leave this scanner polling forever.
  if ($Parent -gt 0 -and -not (Get-Process -Id $Parent -ErrorAction SilentlyContinue)) { exit }

  $started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Emit "BEGIN`t$started`t$cores"

  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    $cpu = 0.0
    $mem = 0.0
    $threads = 0
    $title = ''
    try {
      if ($null -ne $p.CPU) { $cpu = [math]::Round([double]$p.CPU, 3) }
      if ($null -ne $p.WorkingSet64) { $mem = [double]$p.WorkingSet64 }
      if ($null -ne $p.Threads) { $threads = $p.Threads.Count }
      if (-not [string]::IsNullOrEmpty($p.MainWindowTitle)) {
        $title = $p.MainWindowTitle
        foreach ($ch in @("`t", "`r", "`n")) { $title = $title.Replace($ch, ' ') }
      }
    } catch { }
    Emit "P`t$($p.Id)`t$($p.ProcessName)`t$cpu`t$mem`t$threads`t$title"
  }

  foreach ($c in @(Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    $state = [string]$c.State
    if ([string]::IsNullOrEmpty($state)) { $state = 'Listen' }
    Emit "L`ttcp`t$($c.LocalAddress)`t$($c.LocalPort)`t$state`t$($c.OwningProcess)"
  }

  foreach ($u in @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) {
    Emit "L`tudp`t$($u.LocalAddress)`t$($u.LocalPort)`tBound`t$($u.OwningProcess)"
  }

  Emit "END`t$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"

  $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started
  $wait = $Interval - $elapsed
  if ($wait -lt 250) { $wait = 250 }
  Start-Sleep -Milliseconds $wait
}
