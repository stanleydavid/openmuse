# Register the OpenMuse stack as per-user scheduled tasks that start at logon.
# LOCAL ADDITION (2026-09-24): idempotent — re-running replaces the definitions.
# Tasks run hidden as the current user and restart on failure (up to 3 tries).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$tasks = @(
  @{ Name = 'OpenMuse-API';    Script = 'start-api.ps1';    Desc = 'OpenMuse API (Hono + CopilotKit runtime + PGlite) on 127.0.0.1:8787' },
  @{ Name = 'OpenMuse-Web';    Script = 'start-web.ps1';    Desc = 'OpenMuse web UI (Expo web) on http://localhost:8081' },
  @{ Name = 'OpenMuse-Worker'; Script = 'start-worker.ps1'; Desc = 'OpenMuse browser worker (Playwright sidecar) on 127.0.0.1:8790' }
)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

foreach ($t in $tasks) {
  $scriptPath = Join-Path $PSScriptRoot $t.Script
  $action = New-ScheduledTaskAction -Execute $ps `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`"" `
    -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ("$env:USERDOMAIN\$env:USERNAME")
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger `
    -Settings $settings -Description $t.Desc -Force | Out-Null
  Write-Output "registered: $($t.Name) -> $scriptPath"
}
