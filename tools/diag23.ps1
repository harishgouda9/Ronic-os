$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag23.txt'
Set-Content -Path $log -Value 'diag23 start'
$root = 'C:\Users\haris\OneDrive\Desktop\Omni Workspace OS'
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin;$env:PATH"
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\omniworkspace-target"
$env:CARGO_TERM_COLOR = 'never'

Push-Location "$root\src-tauri"
$o = & cargo tree -e features -i muda 2>&1 | Out-String -Width 200
Add-Content $log '=== cargo tree -i muda ==='
Add-Content $log $o
Pop-Location

$td = "$env:LOCALAPPDATA\omniworkspace-target\debug"
Get-ChildItem $td -Filter 'omniworkspace_lib-*.exe' | ForEach-Object { Add-Content $log ('testexe: ' + $_.FullName + ' ' + $_.Length) }
Get-ChildItem $td -Filter 'omniworkspace-*.exe' | ForEach-Object { Add-Content $log ('appexe: ' + $_.FullName + ' ' + $_.Length) }

$testexe = (Get-ChildItem $td -Filter 'omniworkspace_lib-*.exe' | Select-Object -First 1).FullName
if ($testexe) {
  Add-Content $log '=== test exe imports (comctl32/taskdialog) ==='
  $o = & objdump -p $testexe 2>&1 | Select-String -Pattern 'comctl32|TaskDialog|DLL Name' | Out-String -Width 200
  Add-Content $log $o
}
Add-Content $log 'diag23 end'
