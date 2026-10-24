$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag2.txt'
function W($t) { Add-Content -Path $log -Value ("`n=== $t ===") }
Set-Content -Path $log -Value 'diag2 start'
try {
  $userHome = $env:USERPROFILE
  $target = "$env:LOCALAPPDATA\omniworkspace-target"
  $tcBin = "$userHome\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin"
  $deps = "$target\debug\deps"
  $winlibs = 'C:\Users\haris\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin'
  $exe = Join-Path $deps 'omniworkspace_lib-be57a82e1b3861b4.exe'

  W 'run plain'
  $o = & $exe --list 2>&1 | Out-String
  Add-Content $log ("plain exit={0}`n{1}" -f $LASTEXITCODE, $o)

  W 'run with toolchain bin first on PATH'
  $env:PATH = "$tcBin;$env:PATH"
  $o = & $exe --list 2>&1 | Out-String
  Add-Content $log ("tcpath exit={0}`n{1}" -f $LASTEXITCODE, $o)

  W 'run with winlibs removed from PATH'
  $env:PATH = (($env:PATH -split ';') | Where-Object { $_ -notlike '*WinLibs*' }) -join ';'
  $o = & $exe --list 2>&1 | Out-String
  Add-Content $log ("nowinlibs exit={0}`n{1}" -f $LASTEXITCODE, $o)

  W 'objdump imports'
  $objdump = Join-Path $winlibs 'objdump.exe'
  if (Test-Path $objdump) {
    $o = & $objdump -p $exe 2>&1 | Out-String
    Add-Content $log $o
  } else {
    Add-Content $log "no objdump at $objdump"
    $o = & dumpbin /DEPENDENTS $exe 2>&1 | Out-String
    Add-Content $log $o
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag2 end'

