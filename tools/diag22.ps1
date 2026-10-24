$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag22.txt'
Set-Content -Path $log -Value 'diag22 start'
$reg = (Get-ChildItem "$env:USERPROFILE\.cargo\registry\src" -Directory | Select-Object -First 1).FullName

Get-ChildItem $reg -Directory -Filter 'embed-resource-*' | ForEach-Object { Add-Content $log ('embed-version: ' + $_.Name) }

$er = Join-Path $reg 'embed-resource-3.0.12\src\lib.rs'
if (Test-Path $er) {
  Add-Content $log '=== compile_impl context ==='
  Select-String -Path $er -Pattern 'fn compile_impl|macro_rules! compile_impl|prefix' -Context 1,3 |
    Select-Object -First 12 | ForEach-Object { Add-Content $log ($_.LineNumber.ToString() + ': ' + $_.Line.Trim()) }
}

foreach ($t in @('tauri-2.9.5','tauri-2.11.0','tauri-2.12.0')) {
  $tc = Join-Path $reg ($t + '\Cargo.toml')
  if (Test-Path $tc) {
    Add-Content $log ('=== ' + $t)
    Select-String -Path $tc -Pattern 'common-controls-v6' -Context 1,3 |
      ForEach-Object { Add-Content $log ($_.LineNumber.ToString() + ': ' + $_.Line.Trim()) }
  }
}
Add-Content $log 'diag22 end'
