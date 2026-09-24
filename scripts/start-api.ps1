# OpenMuse API launcher (Hono + CopilotKit runtime + PGlite).
# LOCAL ADDITION (2026-09-24): used both for manual starts and as the
# scheduled-task entry point so the API comes back after a reboot.
#
# NOTE: use Start-Process rather than the `&` operator. Node/PGlite writes
# startup notices to stderr; with the call operator PowerShell promotes native
# stderr to a terminating error under $ErrorActionPreference='Stop' (this made
# the scheduled task exit 1 before the API could bind). Start-Process also
# propagates the real exit code and keeps the task process alive for
# restart-on-failure.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\EIAdminBot\windows-runtime\node-v24.15.0-win-x64\node.exe'
# Single-instance guard: two APIs opening the same PGlite data dir CORRUPTS it.
if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) {
  Write-Output 'OpenMuse API already listening on 8787; refusing to start a second instance.'
  exit 0
}
$proc = Start-Process -FilePath $node `
  -ArgumentList '--import', 'tsx', 'apps/server/src/index.ts' `
  -WorkingDirectory $root -NoNewWindow -PassThru `
  -RedirectStandardOutput (Join-Path $root 'api.out.log') `
  -RedirectStandardError (Join-Path $root 'api.err.log')
$proc.WaitForExit()
exit $proc.ExitCode
