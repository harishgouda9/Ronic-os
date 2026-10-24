$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag15.txt'
Set-Content -Path $log -Value 'diag15 start'
$reg = Join-Path $env:USERPROFILE '.cargo\registry\src\index.crates.io-1949cf8c6b5b557f'
try {
  $tb = Join-Path $reg 'tauri-build-2.7.3'
  Add-Content $log '=== tauri-build windows-app-manifest.xml ==='
  Get-Content (Join-Path $tb 'src\windows-app-manifest.xml') | ForEach-Object { Add-Content $log ("  {0}" -f $_) }

  Add-Content $log ''
  Add-Content $log '=== tauri-build lib.rs: windows manifest embedding ==='
  $lib = Get-Content (Join-Path $tb 'src\lib.rs')
  for ($i = 0; $i -lt $lib.Count; $i++) {
    if ($lib[$i] -match 'windows-app-manifest|manifest|embed_resource|rustc-link-arg|link-arg|common-controls|comctl32') {
      $s = [Math]::Max(0, $i - 6); $e = [Math]::Min($lib.Count - 1, $i + 6)
      Add-Content $log ("--- around line {0} ---" -f ($i+1))
      for ($j = $s; $j -le $e; $j++) { Add-Content $log ("  {0,5}: {1}" -f ($j+1), $lib[$j]) }
    }
  }

  Add-Content $log ''
  Add-Content $log '=== tauri-build build.rs files list ==='
  Get-ChildItem (Join-Path $tb 'src') -File | ForEach-Object { Add-Content $log ("  {0}" -f $_.Name) }

  Add-Content $log ''
  Add-Content $log '=== tauri crate Cargo.toml: muda dep features ==='
  $tc = Join-Path $reg 'tauri-2.12.4\Cargo.toml'
  Select-String -Path $tc -Pattern 'muda' -Context 0,6 | ForEach-Object {
    Add-Content $log ("  {0}" -f $_.Line.Trim())
    $_.Context.PostContext | ForEach-Object { Add-Content $log ("      {0}" -f $_.Trim()) }
  }

  Add-Content $log ''
  Add-Content $log '=== muda Cargo.toml features ==='
  $mc = Join-Path $reg 'muda-0.20.0\Cargo.toml'
  Select-String -Path $mc -Pattern 'common-controls-v6|^\[features\]|default =' -Context 0,4 | ForEach-Object {
    Add-Content $log ("  {0}" -f $_.Line.Trim())
    $_.Context.PostContext | ForEach-Object { Add-Content $log ("      {0}" -f $_.Trim()) }
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag15 end'
