$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag25.txt'
Set-Content -Path $log -Value 'diag25 start'
$td = "$env:LOCALAPPDATA\omniworkspace-target\debug"

Get-ChildItem "$td\deps" -Filter 'omniworkspace_lib-*.exe' -ErrorAction SilentlyContinue |
  ForEach-Object { Add-Content $log ('testexe: ' + $_.FullName + ' size=' + $_.Length + ' mtime=' + $_.LastWriteTime) }
Get-ChildItem "$td" -Filter 'omniworkspace*.exe' -ErrorAction SilentlyContinue |
  ForEach-Object { Add-Content $log ('appexe: ' + $_.FullName + ' size=' + $_.Length) }

$lock = 'C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri\Cargo.lock'
Select-String -Path $lock -Pattern 'name = "embed-resource"' -Context 0,3 |
  ForEach-Object { Add-Content $log ($_.LineNumber.ToString() + ': ' + $_.Line.Trim()); $_.Context.PostContext | ForEach-Object { Add-Content $log ('   ' + $_.Trim()) } }

Add-Content $log 'diag25 end'
