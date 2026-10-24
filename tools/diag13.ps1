$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag13.txt'
Set-Content -Path $log -Value 'diag13 start'

function Get-Exports([string]$path) {
  $b = [System.IO.File]::ReadAllBytes($path)
  $lf = [BitConverter]::ToInt32($b, 0x3C)
  $coff = $lf + 4
  $nsec = [BitConverter]::ToUInt16($b, $coff + 2)
  $szOpt = [BitConverter]::ToUInt16($b, $coff + 16)
  $opt = $coff + 20
  $is64 = ([BitConverter]::ToUInt16($b, $opt) -eq 0x20B)
  $ddOff = if ($is64) { $opt + 112 } else { $opt + 96 }
  $secOff = $opt + $szOpt
  $secs = @()
  for ($i = 0; $i -lt $nsec; $i++) {
    $s = $secOff + ($i * 40)
    $secs += [pscustomobject]@{ VA=[BitConverter]::ToUInt32($b,$s+12); VSz=[BitConverter]::ToUInt32($b,$s+8); Raw=[BitConverter]::ToUInt32($b,$s+20); RSz=[BitConverter]::ToUInt32($b,$s+16) }
  }
  function R2O([uint32]$rva) {
    foreach ($s in $secs) {
      $sz = if ($s.VSz -ne 0) { $s.VSz } else { $s.RSz }
      if ($rva -ge $s.VA -and $rva -lt ($s.VA + $sz)) { return [uint32]($s.Raw + ($rva - $s.VA)) }
    }
    return [uint32]0xFFFFFFFF
  }
  $expRva = [BitConverter]::ToUInt32($b, $ddOff)
  if ($expRva -eq 0) { return @() }
  $o = R2O $expRva
  $numNames = [BitConverter]::ToUInt32($b, $o + 24)
  $addrNames = [BitConverter]::ToUInt32($b, $o + 32)
  $no = R2O $addrNames
  $out = @()
  for ($i = 0; $i -lt $numNames; $i++) {
    $nr = [BitConverter]::ToUInt32($b, $no + ($i*4))
    $p = R2O $nr
    $sb = New-Object System.Text.StringBuilder
    while ($b[$p] -ne 0) { [void]$sb.Append([char]$b[$p]); $p++ }
    $out += $sb.ToString()
  }
  return $out
}

try {
  Add-Content $log '=== System32\comctl32.dll ==='
  $c = 'C:\WINDOWS\System32\comctl32.dll'
  $vi = (Get-Item $c).VersionInfo
  Add-Content $log ("file version: {0}  product: {1}  size: {2}" -f $vi.FileVersion, $vi.ProductVersion, (Get-Item $c).Length)
  $ex = Get-Exports $c
  Add-Content $log ("export count: {0}" -f $ex.Count)
  Add-Content $log ("has TaskDialogIndirect: {0}" -f ($ex -contains 'TaskDialogIndirect'))
  Add-Content $log ("has TaskDialog: {0}" -f ($ex -contains 'TaskDialog'))
  Add-Content $log ("has InitCommonControlsEx: {0}" -f ($ex -contains 'InitCommonControlsEx'))

  Add-Content $log ''
  Add-Content $log '=== registry search: TaskDialogIndirect ==='
  $reg = Join-Path $env:USERPROFILE '.cargo\registry\src'
  if (Test-Path $reg) {
    $hits = Get-ChildItem $reg -Recurse -Include '*.rs' -ErrorAction SilentlyContinue |
      Select-String -Pattern 'TaskDialogIndirect' -List -ErrorAction SilentlyContinue
    foreach ($h in $hits) { Add-Content $log ("  {0}" -f $h.Path) }
    if (-not $hits) { Add-Content $log '  (no hits in .rs files)' }
  } else { Add-Content $log '  (no registry src)' }

  Add-Content $log ''
  Add-Content $log '=== registry search: link comctl32 ==='
  $hits2 = Get-ChildItem $reg -Recurse -Include '*.rs' -ErrorAction SilentlyContinue |
    Select-String -Pattern 'link\(name\s*=\s*"comctl32"' -List -ErrorAction SilentlyContinue
  foreach ($h in $hits2) { Add-Content $log ("  {0}" -f $h.Path) }

  Add-Content $log ''
  Add-Content $log '=== cargo registry dirs ==='
  Get-ChildItem $reg -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName | ForEach-Object { Add-Content $log ("  {0}" -f $_) }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag13 end'
