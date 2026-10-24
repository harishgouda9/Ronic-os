$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag6.txt'
Set-Content -Path $log -Value 'diag6 start'
try {
  $src = Join-Path $env:TEMP 'ow_diag2.txt'
  $imports = [ordered]@{}
  $cur = $null
  foreach ($l in (Get-Content $src)) {
    if ($l -match 'DLL Name:\s*(\S+)\s*$') {
      $cur = $matches[1]
      if (-not $imports.Contains($cur)) { $imports[$cur] = New-Object System.Collections.ArrayList }
    } elseif ($cur -and $l -match '^\s+<none>\s+[0-9a-f]+\s+(\S+)\s*$') {
      [void]$imports[$cur].Add($matches[1])
    }
  }
  Add-Content $log ("DLL count: {0}" -f $imports.Count)
  foreach ($k in $imports.Keys) {
    Add-Content $log ("{0}|{1}" -f $k, ($imports[$k] -join ','))
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag6 end'
