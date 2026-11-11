# Doremon "Start with Windows" helper.
# Reads or edits the per-user Run key that launches the app at sign-in.
# Prints "ON"/"OFF" for -Action status, "OK" after a change, or "ERR:<message>".
#
# -Action status|enable|disable -ParentPid <app pid>

param(
  [Parameter(Mandatory = $true)][ValidateSet('status', 'enable', 'disable')][string]$Action,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
$out = [Console]::Out
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'Doremon'

function Fail([string]$message) {
  $out.WriteLine('ERR:' + $message)
  exit 1
}

try {
  $registered = $null
  try {
    $registered = (Get-ItemProperty -Path $runKey -Name $valueName -ErrorAction Stop).$valueName
  } catch {
    $registered = $null
  }

  if ($Action -eq 'status') {
    $out.WriteLine($(if ($registered) { 'ON' } else { 'OFF' }))
    exit 0
  }

  if ($Action -eq 'disable') {
    if ($registered) { Remove-ItemProperty -Path $runKey -Name $valueName -ErrorAction Stop }
    $out.WriteLine('OK')
    exit 0
  }

  if ($ParentPid -le 0) { Fail 'Missing the application process id.' }
  $process = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if (-not $process -or -not $process.Path) { Fail 'Could not locate the Doremon executable.' }

  # --window-hidden is a Neutralino flag: the app starts in the tray, no window.
  $command = '"' + $process.Path + '" --window-hidden'
  if (-not (Test-Path -Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
  Set-ItemProperty -Path $runKey -Name $valueName -Value $command
  $out.WriteLine('OK')
} catch {
  Fail $_.Exception.Message
}
