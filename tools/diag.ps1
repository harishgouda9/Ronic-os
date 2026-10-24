$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag.txt'
function W($t) { Add-Content -Path $log -Value ("`n=== $t ===") }
Set-Content -Path $log -Value 'diag start'
try {
  $userHome = $env:USERPROFILE
  $target = "$env:LOCALAPPDATA\omniworkspace-target"
  W 'rustc -vV'
  $r = & rustc -vV 2>&1 | Out-String
  Add-Content $log $r
  W 'cargo -vV'
  Add-Content $log (& cargo -vV 2>&1 | Out-String)
  W 'rustup toolchain list'
  Add-Content $log (& rustup toolchain list 2>&1 | Out-String)
  $tcBin = "$userHome\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin"
  W 'toolchain bin dlls'
  Add-Content $log ((Get-ChildItem $tcBin -Filter *.dll -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table -AutoSize | Out-String))
  $sc = "$userHome\.rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained"
  W 'self-contained dir'
  Add-Content $log ((Get-ChildItem $sc -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table -AutoSize | Out-String))
  W 'target debug dlls'
  Add-Content $log ((Get-ChildItem "$target\debug" -Filter *.dll -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table -AutoSize | Out-String))
  W 'target debug/deps dlls'
  Add-Content $log ((Get-ChildItem "$target\debug\deps" -Filter *.dll -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table -AutoSize | Out-String))
  W 'where dlls'
  foreach ($d in @('WebView2Loader.dll','libgcc_s_seh-1.dll','libwinpthread-1.dll')) {
    Add-Content $log "--- $d"
    Add-Content $log (& where.exe $d 2>&1 | Out-String)
  }
  W 'test exe list'
  $exe = Get-ChildItem "$target\debug\deps" -Filter 'omniworkspace_lib-*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($exe) {
    Add-Content $log "exe: $($exe.FullName)"
    Add-Content $log (& $exe.FullName --list 2>&1 | Out-String)
    Add-Content $log "run exit: $LASTEXITCODE"
  } else {
    Add-Content $log 'no test exe found'
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag end'

