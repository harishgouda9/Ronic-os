$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag11.txt'
Set-Content -Path $log -Value 'diag11 start'
try {
  $objdump = 'C:\Users\haris\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin\objdump.exe'
  $deps = "$env:LOCALAPPDATA\omniworkspace-target\debug\deps"

  function Get-Imports($exe) {
    $o = & $objdump -p $exe 2>&1 | Out-String
    $set = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($m in [regex]::Matches($o, '(?m)^\s*DLL Name:\s*(\S+)')) { [void]$set.Add($m.Groups[1].Value) }
    return $set
  }

  $fail = Get-ChildItem $deps -Filter 'omniworkspace_lib-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $hello = Get-ChildItem $deps -Filter 'hello-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  Add-Content $log ("fail  : {0}" -f $fail.FullName)
  Add-Content $log ("hello : {0}" -f $hello.FullName)

  $fi = Get-Imports $fail.FullName
  $hi = Get-Imports $hello.FullName
  Add-Content $log ("fail imports: {0}" -f $fi.Count)
  Add-Content $log ("hello imports: {0}" -f $hi.Count)
  Add-Content $log '--- DLLs only in FAIL binary ---'
  foreach ($d in ($fi | Where-Object { -not $hi.Contains($_) } | Sort-Object)) { Add-Content $log ("  {0}" -f $d) }
  Add-Content $log '--- DLLs only in HELLO binary ---'
  foreach ($d in ($hi | Where-Object { -not $fi.Contains($_) } | Sort-Object)) { Add-Content $log ("  {0}" -f $d) }

  # Where do the extra DLLs live on disk?
  $searchDirs = @(
    (Join-Path $env:SystemRoot 'System32'),
    "$env:LOCALAPPDATA\omniworkspace-target\debug",
    $deps,
    "$env:LOCALAPPDATA\omniworkspace-target\release",
    (Join-Path $env:SystemRoot 'SysWOW64')
  )
  Add-Content $log '--- copies of extra DLLs found on disk ---'
  foreach ($d in ($fi | Where-Object { -not $hi.Contains($_) } | Sort-Object)) {
    $found = @()
    foreach ($sd in $searchDirs) {
      if (Test-Path $sd) {
        $c = Get-ChildItem $sd -Filter $d -ErrorAction SilentlyContinue
        foreach ($x in $c) { $found += ("{0} ({1} bytes)" -f $x.FullName, $x.Length) }
      }
    }
    Add-Content $log ("{0}: {1}" -f $d, $(if ($found) { $found -join ' | ' } else { 'NOT FOUND' }))
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag11 end'
