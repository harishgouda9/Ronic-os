$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag20.txt'
Set-Content -Path $log -Value 'diag20 start'

$reg = (Get-ChildItem "$env:USERPROFILE\.cargo\registry\src" -Directory | Select-Object -First 1).FullName
$er = Get-ChildItem $reg -Directory -Filter 'embed-resource-*' | Select-Object -First 1
Add-Content $log ('embed_resource=' + $er.Name)
Get-ChildItem $er.FullName -Recurse -Filter '*.rs' | ForEach-Object {
  $f = $_
  Select-String -Path $f.FullName -Pattern 'rustc-link-arg|link-arg-bins|fn compile|fn compile_for|\.obj|\.lib|windres' |
    ForEach-Object { Add-Content $log ('  ' + $f.Name + ':' + $_.LineNumber + ': ' + $_.Line.Trim()) }
}

Add-Content $log '--- tauri Cargo.toml features 60-95 ---'
$tc = Join-Path $reg 'tauri-2.12.4\Cargo.toml'
$lines = Get-Content $tc
for ($i = 59; $i -lt 95; $i++) { Add-Content $log (($i+1).ToString() + ': ' + $lines[$i]) }

Add-Content $log '--- OUT_DIR contents ---'
$target = "$env:LOCALAPPDATA\omniworkspace-target"
Get-ChildItem $target -Recurse -Directory -Filter 'out' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -like '*build*omniworkspace*' } |
  ForEach-Object { Add-Content $log ('OUT: ' + $_.FullName); Get-ChildItem $_.FullName | ForEach-Object { Add-Content $log ('    ' + $_.Name + ' ' + $_.Length) } }

Add-Content $log 'diag20 end'
