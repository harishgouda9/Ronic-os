$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag24.txt'
Set-Content -Path $log -Value 'diag24 start'
$root = 'C:\Users\haris\OneDrive\Desktop\Omni Workspace OS'
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin;$env:PATH"

Add-Content $log ('default-host: ' + (& rustc -vV | Select-String 'host:' | Out-String).Trim())
Add-Content $log ('windres: ' + (Get-Command windres -ErrorAction SilentlyContinue).Source)
Add-Content $log ('ar: ' + (Get-Command ar -ErrorAction SilentlyContinue).Source)

$td = "$env:LOCALAPPDATA\omniworkspace-target\debug"
Get-ChildItem $td -Filter 'omniworkspace_lib-*.exe' -ErrorAction SilentlyContinue |
  ForEach-Object { Add-Content $log ('testexe: ' + $_.FullName + ' size=' + $_.Length) }
Get-ChildItem $td -Filter 'omniworkspace-*.exe' -ErrorAction SilentlyContinue |
  ForEach-Object { Add-Content $log ('appexe: ' + $_.FullName + ' size=' + $_.Length) }

Add-Content $log ('lock exists: ' + (Test-Path "$root\src-tauri\Cargo.lock"))
Add-Content $log 'diag24 end'
