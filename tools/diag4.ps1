$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag4.txt'
Set-Content -Path $log -Value 'diag4 start'
try {
  Add-Content $log '=== Application event log (entry point / module errors) ==='
  $evts = Get-WinEvent -FilterHashtable @{LogName='Application'} -MaxEvents 400 -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -like '*omniworkspace*' }
  if (-not $evts) { Add-Content $log 'no matching events' }
  foreach ($e in $evts) {
    $msg = ($e.Message -replace '\r?\n', ' | ')
    Add-Content $log ("{0} id={1} {2}" -f $e.TimeCreated.ToString('s'), $e.Id, $msg)
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag4 end'
