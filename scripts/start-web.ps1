# OpenMuse web UI launcher (Expo web on http://localhost:8081).
# LOCAL ADDITION (2026-09-24): scheduled-task entry point for reboot survival.
# See start-api.ps1 for why Start-Process is used instead of the `&` operator.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $root 'apps\mobile'
$node = 'C:\EIAdminBot\windows-runtime\node-v24.15.0-win-x64\node.exe'
if (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue) {
  Write-Output 'OpenMuse web already listening on 8081; refusing to start a second instance.'
  exit 0
}
$proc = Start-Process -FilePath $node `
  -ArgumentList 'node_modules\expo\bin\cli', 'start', '--web', '--port', '8081' `
  -WorkingDirectory $mobile -NoNewWindow -PassThru `
  -RedirectStandardOutput (Join-Path $root 'web.out.log') `
  -RedirectStandardError (Join-Path $root 'web.err.log')
$proc.WaitForExit()
exit $proc.ExitCode
