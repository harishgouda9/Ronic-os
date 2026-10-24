$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag8.txt'
Set-Content -Path $log -Value 'diag8 start'
try {
  $objdump = 'C:\Users\haris\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin\objdump.exe'
  $target = "$env:LOCALAPPDATA\omniworkspace-target"
  $wv = "$target\debug\deps\WebView2Loader.dll"

  Add-Content $log '=== RAW objdump -p WebView2Loader.dll (x64) ==='
  $o = & $objdump -p $wv 2>&1 | Out-String
  Add-Content $log $o

  Add-Content $log '=== RAW objdump -p test exe : DLL Names only ==='
  $exe = "$target\debug\deps\omniworkspace_lib-be57a82e1b3861b4.exe"
  $o2 = & $objdump -p $exe 2>&1 | Out-String
  $dlls = [regex]::Matches($o2, 'DLL Name:\s*(\S+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
  foreach ($d in $dlls) { Add-Content $log ("IMPDLL {0}" -f $d) }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag8 end'
