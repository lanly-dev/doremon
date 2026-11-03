# Doremon process actions: kill / suspend / resume one process.
# Prints "OK" on success, or "ERR:<message>" and exits 1 on failure.
#
# -Action kill|suspend|resume -TargetPid <pid>

param(
  [Parameter(Mandatory = $true)][ValidateSet('kill', 'suspend', 'resume')][string]$Action,
  [Parameter(Mandatory = $true)][int]$TargetPid
)

$ErrorActionPreference = 'Stop'
$out = [Console]::Out

function Fail([string]$message) {
  $out.WriteLine('ERR:' + $message)
  exit 1
}

function Initialize-Native {
  if ('Doremon.Native' -as [type]) { return }
  Add-Type -Namespace Doremon -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("ntdll.dll")]
public static extern uint NtSuspendProcess(System.IntPtr processHandle);
[System.Runtime.InteropServices.DllImport("ntdll.dll")]
public static extern uint NtResumeProcess(System.IntPtr processHandle);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern System.IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(System.IntPtr handle);
'@
}

try {
  $target = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if (-not $target) {
    # Already gone: nothing left to do.
    $out.WriteLine('OK')
    exit 0
  }

  if ($Action -eq 'kill') {
    Stop-Process -Id $TargetPid -Force
    $out.WriteLine('OK')
    exit 0
  }

  # Windows has no public suspend API; NtSuspendProcess/NtResumeProcess from
  # ntdll is the same mechanism Task Manager uses.
  Initialize-Native
  $PROCESS_SUSPEND_RESUME = 0x0800
  $handle = [Doremon.Native]::OpenProcess($PROCESS_SUSPEND_RESUME, $false, $TargetPid)
  if ($handle -eq [System.IntPtr]::Zero) {
    Fail 'Access denied. Run Doremon as administrator to change this process.'
  }

  $status = 0
  try {
    if ($Action -eq 'suspend') {
      $status = [Doremon.Native]::NtSuspendProcess($handle)
    } else {
      $status = [Doremon.Native]::NtResumeProcess($handle)
    }
  } finally {
    [void][Doremon.Native]::CloseHandle($handle)
  }

  if ($status -ne 0) { Fail ('Windows returned status ' + $status) }
  $out.WriteLine('OK')
} catch {
  Fail $_.Exception.Message
}
