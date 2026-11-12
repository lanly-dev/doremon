# Doremon Windows scanner.
# Streams one snapshot per interval to stdout as tab-separated lines:
#   BEGIN <tsMs> <cores>
#   P <pid> <name> <cpuSeconds> <memBytes> <threads> <windowTitle> <description> <company> <path>
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

# Resolve an executable path without touching Process.MainModule, which is very
# slow when called for every process every tick. PROCESS_QUERY_LIMITED_
# INFORMATION works for most user processes; protected ones fail and fall back
# to the app's built-in descriptions.
$script:pathTypeReady = $true
try {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DoremonProcessPath {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(int access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW", ExactSpelling = true)]
  private static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder text, ref int size);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  public static string Get(int pid) {
    const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return "";
    try {
      StringBuilder text = new StringBuilder(1024);
      int size = text.Capacity;
      if (!QueryFullProcessImageName(handle, 0, text, ref size)) return "";
      return text.ToString(0, size);
    } finally {
      CloseHandle(handle);
    }
  }
}
"@ -ErrorAction Stop
} catch {
  $script:pathTypeReady = $false
}

# Executable version resources rarely change, and groups such as svchost have
# dozens of instances sharing one file. Read each path once per scanner run.
$script:versionCache = @{}

function CleanField([string]$value, [int]$maxLength) {
  if ([string]::IsNullOrEmpty($value)) { return '' }
  $text = ($value -replace '[\t\r\n]', ' ').Trim()
  if ($text.Length -gt $maxLength) { $text = $text.Substring(0, $maxLength) }
  return $text
}

function Get-DoremonProcessDetails([int]$ProcessId) {
  $empty = @{ description = ''; company = ''; path = '' }
  if (-not $script:pathTypeReady) { return $empty }

  $path = ''
  try { $path = [DoremonProcessPath]::Get($ProcessId) } catch { $path = '' }
  if ([string]::IsNullOrEmpty($path)) { return $empty }

  $cached = $script:versionCache[$path]
  if ($null -ne $cached) { return $cached }

  $description = ''
  $company = ''
  try {
    $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)
    $description = CleanField $info.FileDescription 160
    $company = CleanField $info.CompanyName 120
  } catch { }

  $details = @{
    description = $description
    company = $company
    path = (CleanField $path 240)
  }
  $script:versionCache[$path] = $details
  return $details
}

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

    $details = Get-DoremonProcessDetails $p.Id
    Emit "P`t$($p.Id)`t$($p.ProcessName)`t$cpu`t$mem`t$threads`t$title`t$($details.description)`t$($details.company)`t$($details.path)"
  }

  foreach ($c in @(Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    $state = [string]$c.State
    if ([string]::IsNullOrEmpty($state)) { $state = 'Listen' }
    Emit "L`ttcp`t$($c.LocalAddress)`t$($c.LocalPort)`t$state`t$($c.OwningProcess)"
  }

  foreach ($u in @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) {
    Emit "L`ttudp`t$($u.LocalAddress)`t$($u.LocalPort)`tBound`t$($u.OwningProcess)"
  }

  Emit "END`t$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"

  $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started
  $wait = $Interval - $elapsed
  if ($wait -lt 250) { $wait = 250 }
  Start-Sleep -Milliseconds $wait
}
