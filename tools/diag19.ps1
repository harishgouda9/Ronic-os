$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag19.txt'
Set-Content -Path $log -Value 'diag19 start'

$reg = (Get-ChildItem "$env:USERPROFILE\.cargo\registry\src" -Directory | Select-Object -First 1).FullName
$dirs = Get-ChildItem $reg -Directory | Where-Object { $_.Name -like 'tauri-winres-*' -or $_.Name -like 'winres-*' }
foreach ($d in $dirs) {
  Add-Content $log ('=== ' + $d.Name)
  Get-ChildItem $d.FullName -Recurse -Filter '*.rs' | ForEach-Object {
    $f = $_
    Select-String -Path $f.FullName -Pattern 'rustc-link-arg|fn compile|link-arg-bins|OUT_DIR' |
      ForEach-Object { Add-Content $log ('  ' + $f.Name + ':' + $_.LineNumber + ': ' + $_.Line.Trim()) }
  }
}

Add-Content $log 'diag19 end'
