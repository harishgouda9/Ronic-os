$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag9.txt'
Set-Content -Path $log -Value 'diag9 start'
try {
  $target = "$env:LOCALAPPDATA\omniworkspace-target"
  $objdump = 'C:\Users\haris\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin\objdump.exe'
  $exe = "$target\debug\deps\omniworkspace_lib-be57a82e1b3861b4.exe"

  $imports = [ordered]@{}
  $cur = $null
  foreach ($l in (Get-Content (Join-Path $env:TEMP 'ow_diag2.txt'))) {
    if ($l -match 'DLL Name:\s*(\S+)\s*$') {
      $cur = $matches[1]
      if (-not $imports.Contains($cur)) { $imports[$cur] = New-Object System.Collections.ArrayList }
    } elseif ($cur -and $l -match '^\s+<none>\s+[0-9a-f]+\s+(\S+)\s*$') {
      [void]$imports[$cur].Add($matches[1])
    }
  }

  $cache = @{}
  function Get-Exports([string]$path) {
    if ($cache.ContainsKey($path)) { return $cache[$path] }
    $names = @{}
    if (Test-Path $path) {
      $o = & $objdump -p $path 2>&1 | Out-String
      foreach ($m in [regex]::Matches($o, '(?m)^\s*\[\s*\d+\]\s*\+base\[\s*\d+\]\s+[0-9a-f]+\s+(\S+)\s*$')) {
        $names[$m.Groups[1].Value] = $true
      }
    }
    $cache[$path] = $names
    return $names
  }

  $sys32 = Join-Path $env:SystemRoot 'System32'
  $dirs = @("$target\debug\deps", "$target\debug", $sys32)
  foreach ($dll in $imports.Keys) {
    $funcs = $imports[$dll]
    $found = $null
    foreach ($d in $dirs) {
      $p = Join-Path $d $dll
      if (Test-Path $p) { $found = $p; break }
    }
    if (-not $found) {
      Add-Content $log ("NODLL   {0}  (need {1} funcs) - APISET?" -f $dll, $funcs.Count)
      continue
    }
    $exp = Get-Exports $found
    if ($exp.Count -eq 0) {
      Add-Content $log ("NOEXP   {0} -> {1}  (need {2})" -f $dll, $found, ($funcs -join ','))
      continue
    }
    $missing = @($funcs | Where-Object { -not $exp.ContainsKey($_) })
    if ($missing.Count -gt 0) {
      Add-Content $log ("MISSING {0} -> {1}  missing: {2}" -f $dll, $found, ($missing -join ','))
    } else {
      Add-Content $log ("OK      {0} -> {1}  ({2} funcs)" -f $dll, $found, $funcs.Count)
    }
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag9 end'
