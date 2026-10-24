$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag21.txt'
Set-Content -Path $log -Value 'diag21 start'

$reg = (Get-ChildItem "$env:USERPROFILE\.cargo\registry\src" -Directory | Select-Object -First 1).FullName

foreach ($n in @('muda-0.20.0','tauri-runtime-wry-2.12.2','wry-*')) {
  $d = Get-ChildItem $reg -Directory -Filter $n -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $d) { Add-Content $log ('missing: ' + $n); continue }
  Add-Content $log ('=== ' + $d.Name)
  Get-ChildItem $d.FullName -Recurse -Include '*.rs','Cargo.toml' -File | ForEach-Object {
    $f = $_
    Select-String -Path $f.FullName -Pattern 'common-controls-v6|TaskDialogIndirect|TaskDialog' |
      ForEach-Object { Add-Content $log ('  ' + $f.Name + ':' + $_.LineNumber + ': ' + $_.Line.Trim()) }
  }
}

$rc = "$env:LOCALAPPDATA\omniworkspace-target\debug\build\omniworkspace-76380e3e2bbda0a6\out\resource.rc"
if (Test-Path $rc) { Add-Content $log '=== resource.rc ==='; Get-Content $rc | ForEach-Object { Add-Content $log ('  ' + $_) } }

Add-Content $log 'diag21 end'
