$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag3.txt'
Set-Content -Path $log -Value 'diag3 start'
try {
  $userHome = $env:USERPROFILE
  $target = "$env:LOCALAPPDATA\omniworkspace-target"
  $tcBin = "$userHome\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin"
  $deps = "$target\debug\deps"
  $winlibs = 'C:\Users\haris\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin'
  $objdump = Join-Path $winlibs 'objdump.exe'
  $exe = Join-Path $deps 'omniworkspace_lib-be57a82e1b3861b4.exe'

  Add-Content $log '=== DLL names imported by test exe ==='
  $lines = & $objdump -p $exe 2>&1
  $names = @()
  $cur = $null
  foreach ($l in $lines) {
    if ($l -match 'DLL Name:\s*(\S+)') { $cur = $matches[1]; $names += $cur }
  }
  $names | Sort-Object -Unique | ForEach-Object { Add-Content $log $_ }

  Add-Content $log '=== resolution ==='
  foreach ($d in ($names | Sort-Object -Unique)) {
    $found = @()
    foreach ($dir in @($deps, $target, $target + '\release', $tcBin, $winlibs, $env:SystemRoot + '\System32', $env:SystemRoot)) {
      $p = Join-Path $dir $d
      if (Test-Path $p) { $found += $p }
    }
    if ($found.Count -eq 0) { Add-Content $log ("NODLL  {0}" -f $d) }
    else { Add-Content $log ("FOUND  {0}  ->  {1}" -f $d, ($found -join ' | ')) }
  }

  Add-Content $log '=== release dir ==='
  $rd = Join-Path $target 'release'
  if (Test-Path $rd) {
    Get-ChildItem $rd | ForEach-Object { Add-Content $log ("{0}  {1}" -f $_.Name, $_.Length) }
  } else { Add-Content $log 'no release dir' }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag3 end'

