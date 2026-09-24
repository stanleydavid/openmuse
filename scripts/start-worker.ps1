# OpenMuse browser worker launcher (Playwright-based sidecar on 127.0.0.1:8790).
# LOCAL ADDITION (2026-09-24): scheduled-task entry point for reboot survival.
# See start-api.ps1 for why Start-Process is used instead of the `&` operator.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\EIAdminBot\windows-runtime\node-v24.15.0-win-x64\node.exe'
if (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue) {
  Write-Output 'OpenMuse worker already listening on 8790; refusing to start a second instance.'
  exit 0
}
$proc = Start-Process -FilePath $node `
  -ArgumentList '--env-file=.env', '--import', 'tsx', 'apps/worker/src/index.ts' `
  -WorkingDirectory $root -NoNewWindow -PassThru `
  -RedirectStandardOutput (Join-Path $root 'worker.out.log') `
  -RedirectStandardError (Join-Path $root 'worker.err.log')
$proc.WaitForExit()
exit $proc.ExitCode
