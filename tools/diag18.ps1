$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag18.txt'
Set-Content -Path $log -Value 'diag18 start'

$reg = (Get-ChildItem "$env:USERPROFILE\.cargo\registry\src" -Directory | Select-Object -First 1).FullName
Add-Content $log ('registry=' + $reg)

$tb = Join-Path $reg 'tauri-build-2.7.3\src\lib.rs'
if (Test-Path $tb) {
  Add-Content $log '--- tauri-build link-arg / resource lines ---'
  Select-String -Path $tb -Pattern 'rustc-link-arg|res\.compile|\.compile\(|link-arg-bins|app_manifest' |
    ForEach-Object { Add-Content $log ($_.LineNumber.ToString() + ': ' + $_.Line.Trim()) }
}

$wr = Join-Path $reg 'winres-0.1.12\src\lib.rs'
if (-not (Test-Path $wr)) {
  $wr = (Get-ChildItem $reg -Directory -Filter 'winres-*' | Select-Object -First 1).FullName + '\src\lib.rs'
}
if (Test-Path $wr) {
  Add-Content $log ('--- winres: ' + $wr + ' ---')
  Select-String -Path $wr -Pattern 'rustc-link-arg|link-arg-bins|fn compile' |
    ForEach-Object { Add-Content $log ($_.LineNumber.ToString() + ': ' + $_.Line.Trim()) }
}

Add-Content $log '--- tauri crates enabling common-controls-v6 ---'
Get-ChildItem $reg -Directory -Filter 'tauri*' | ForEach-Object {
  $c = Join-Path $_.FullName 'Cargo.toml'
  if (Test-Path $c) {
    Select-String -Path $c -Pattern 'common-controls-v6' -SimpleMatch |
      ForEach-Object { Add-Content $log ($_.Path + ' :' + $_.LineNumber + ': ' + $_.Line.Trim()) }
  }
}

Add-Content $log 'diag18 end'
