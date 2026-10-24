$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag7.txt'
Set-Content -Path $log -Value 'diag7 start'
try {
  $target = "$env:LOCALAPPDATA\omniworkspace-target"
  $objdump = 'C:\Users\haris\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin\objdump.exe'

  Add-Content $log '=== test exes in deps ==='
  Get-ChildItem "$target\debug\deps" -Filter 'omniworkspace_lib-*.exe' -ErrorAction SilentlyContinue |
    ForEach-Object { Add-Content $log ("EXE {0}  {1}  {2}" -f $_.Name, $_.Length, $_.LastWriteTime) }

  Add-Content $log '=== all WebView2Loader.dll copies ==='
  $wv = @()
  Get-ChildItem $target -Recurse -Filter 'WebView2Loader.dll' -ErrorAction SilentlyContinue | ForEach-Object {
    $vi = $_.VersionInfo
    Add-Content $log ("WV {0} | size={1} | file={2} | product={3} | mtime={4}" -f $_.FullName, $_.Length, $vi.FileVersion, $vi.ProductVersion, $_.LastWriteTime)
    $wv += $_.FullName
  }

  Add-Content $log '=== WebView2Loader.dll exports (each copy) ==='
  foreach ($d in $wv) {
    Add-Content $log ("--- {0}" -f $d)
    $o = & $objdump -p $d 2>&1 | Out-String
    $names = [regex]::Matches($o, '(?m)^\s+\[\s*\d+\]\s+(\S+)$') | ForEach-Object { $_.Groups[1].Value }
    if (-not $names) {
      $names = [regex]::Matches($o, '(?m)^\s+[0-9]+\s+[0-9]+\s+[0-9]+\s+(\S+)\s*$') | ForEach-Object { $_.Groups[1].Value }
    }
    Add-Content $log ("export count: {0}" -f $names.Count)
    foreach ($n in $names) { Add-Content $log ("  EXP {0}" -f $n) }
    foreach ($need in @('CreateCoreWebView2EnvironmentWithOptions','GetAvailableCoreWebView2BrowserVersionString','CreateCoreWebView2Environment','WebView2LoaderCreateCoreWebView2EnvironmentWithOptions')) {
      Add-Content $log ("  HAS[{0}] = {1}" -f $need, ($names -contains $need))
    }
  }

  Add-Content $log '=== system32 presence of api-set dlls ==='
  foreach ($d in @('api-ms-win-crt-private-l1-1-0.dll','api-ms-win-core-synch-l1-2-0.dll','api-ms-win-core-winrt-error-l1-1-0.dll','bcryptprimitives.dll','api-ms-win-crt-time-l1-1-0.dll')) {
    $p = Join-Path $env:SystemRoot "System32\$d"
    Add-Content $log ("SYS {0} exists={1}" -f $d, (Test-Path $p))
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag7 end'
