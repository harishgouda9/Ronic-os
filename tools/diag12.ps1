$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag12.txt'
Set-Content -Path $log -Value 'diag12 start'

function Read-PE([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $e_lfanew = [BitConverter]::ToInt32($bytes, 0x3C)
  if ([BitConverter]::ToUInt32($bytes, $e_lfanew) -ne 0x4550) { throw "not PE: $path" }
  $coff = $e_lfanew + 4
  $numSections = [BitConverter]::ToUInt16($bytes, $coff + 2)
  $sizeOpt = [BitConverter]::ToUInt16($bytes, $coff + 16)
  $opt = $coff + 20
  $magic = [BitConverter]::ToUInt16($bytes, $opt)
  $is64 = ($magic -eq 0x20B)
  $ddOff = if ($is64) { $opt + 112 } else { $opt + 96 }
  $numDD = [BitConverter]::ToUInt32($bytes, $ddOff - 4)
  $secOff = $opt + $sizeOpt
  $secs = @()
  for ($i = 0; $i -lt $numSections; $i++) {
    $s = $secOff + ($i * 40)
    $secs += [pscustomobject]@{
      VA   = [BitConverter]::ToUInt32($bytes, $s + 12)
      VSz  = [BitConverter]::ToUInt32($bytes, $s + 8)
      Raw  = [BitConverter]::ToUInt32($bytes, $s + 20)
      RSz  = [BitConverter]::ToUInt32($bytes, $s + 16)
    }
  }
  $imgSize = [BitConverter]::ToUInt32($bytes, $opt + 56)
  $res = [pscustomobject]@{ Bytes=$bytes; Is64=$is64; Secs=$secs; ImgSize=$imgSize; DdOff=$ddOff }
  return $res
}

function Get-Dd([object]$pe, [int]$i) { return [BitConverter]::ToUInt32($pe.Bytes, $pe.DdOff + ($i * 8)) }

function Get-R2O([object]$pe, [uint32]$rva) {
  foreach ($s in $pe.Secs) {
    $sz = if ($s.VSz -ne 0) { $s.VSz } else { $s.RSz }
    if ($rva -ge $s.VA -and $rva -lt ($s.VA + $sz)) {
      return [uint32]($s.Raw + ($rva - $s.VA))
    }
  }
  return [uint32]0xFFFFFFFF
}

function Get-ImportList($pe) {
  $bytes = $pe.Bytes
  $impRva = Get-Dd $pe 1
  $result = @{}
  if ($impRva -eq 0) { return $result }
  $off = Get-R2O $pe $impRva
  while ($true) {
    $ilt = [BitConverter]::ToUInt32($bytes, $off)
    $nameRva = [BitConverter]::ToUInt32($bytes, $off + 12)
    if ($ilt -eq 0 -and $nameRva -eq 0) { break }
    $no = Get-R2O $pe $nameRva
    $sb = New-Object System.Text.StringBuilder
    while ($bytes[$no] -ne 0) { [void]$sb.Append([char]$bytes[$no]); $no++ }
    $dll = $sb.ToString()
    $names = New-Object System.Collections.Generic.List[string]
    if ($ilt -ne 0) {
      $to = Get-R2O $pe $ilt
      $step = if ($pe.Is64) { 8 } else { 4 }
      while ($true) {
        $v = if ($pe.Is64) { [BitConverter]::ToUInt64($bytes, $to) } else { [uint64][BitConverter]::ToUInt32($bytes, $to) }
        if ($v -eq 0) { break }
        if (($v -band 0x8000000000000000) -ne 0) {
          $names.Add("#" + ($v -band 0xFFFF))
        } else {
          $hn = Get-R2O $pe ([uint32]$v)
          $p = $hn + 2
          $s2 = New-Object System.Text.StringBuilder
          while ($bytes[$p] -ne 0) { [void]$s2.Append([char]$bytes[$p]); $p++ }
          $names.Add($s2.ToString())
        }
        $to += $step
      }
    }
    $result[$dll] = $names
    $off += 20
  }
  return $result
}

function Get-ExportSet([string]$path) {
  try {
    $pe = Read-PE $path
    $bytes = $pe.Bytes
    $expRva = Get-Dd $pe 0
    if ($expRva -eq 0) { return $null }
    $o = Get-R2O $pe $expRva
    $numNames = [BitConverter]::ToUInt32($bytes, $o + 24)
    $addrNames = [BitConverter]::ToUInt32($bytes, $o + 32)
    $no = Get-R2O $pe $addrNames
    $set = New-Object 'System.Collections.Generic.HashSet[string]'
    for ($i = 0; $i -lt $numNames; $i++) {
      $nr = [BitConverter]::ToUInt32($bytes, $no + ($i * 4))
      $p = Get-R2O $pe $nr
      $s = New-Object System.Text.StringBuilder
      while ($bytes[$p] -ne 0) { [void]$s.Append([char]$bytes[$p]); $p++ }
      [void]$set.Add($s.ToString())
    }
    return $set
  } catch { return $null }
}

try {
  $deps = "$env:LOCALAPPDATA\omniworkspace-target\debug\deps"
  $fail = Get-ChildItem $deps -Filter 'omniworkspace_lib-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  Add-Content $log ("FAIL EXE: {0}" -f $fail.FullName)
  $pe = Read-PE $fail.FullName
  $imports = Get-ImportList $pe
  Add-Content $log ("import DLL count: {0}" -f $imports.Count)

  $sys32 = Join-Path $env:SystemRoot 'System32'
  $searchDirs = @("$env:LOCALAPPDATA\omniworkspace-target\debug\deps", $sys32, "$env:LOCALAPPDATA\omniworkspace-target\debug", "$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin", (Join-Path $env:SystemRoot 'SysWOW64'))

  foreach ($dll in ($imports.Keys | Sort-Object)) {
    $names = $imports[$dll]
    $cands = @()
    foreach ($sd in $searchDirs) {
      if (Test-Path $sd) {
        $c = Get-ChildItem -Path $sd -Filter $dll -ErrorAction SilentlyContinue -File
        foreach ($x in $c) { $cands += $x.FullName }
      }
    }
    if ($cands.Count -eq 0) {
      Add-Content $log ("NODLL   {0}  ({1} imports: {2})" -f $dll, $names.Count, ($names -join ','))
      continue
    }
    # loader order: app dir (deps) -> System32 -> others -> SysWOW64
    $chosen = $cands[0]
    $ex = Get-ExportSet $chosen
    if ($null -eq $ex) {
      Add-Content $log ("NOEXP   {0}  <- {1}" -f $dll, $chosen)
      continue
    }
    $miss = @()
    foreach ($n in $names) {
      if ($n.StartsWith('#')) { continue }
      if (-not $ex.Contains($n)) { $miss += $n }
    }
    if ($miss.Count -gt 0) {
      Add-Content $log ("MISSING {0}  <- {1}" -f $dll, $chosen)
      foreach ($m in $miss) { Add-Content $log ("          {0}" -f $m) }
      Add-Content $log ("          candidates: {0}" -f ($cands -join ' | '))
    } else {
      Add-Content $log ("OK      {0}  <- {1}  ({2} imports)" -f $dll, $chosen, $names.Count)
    }
  }

  # Extra: all copies of WebView2Loader.dll + their exports + version
  Add-Content $log '=== WebView2Loader.dll copies ==='
  $wv = @()
  foreach ($root in @("$env:LOCALAPPDATA\omniworkspace-target", "$env:USERPROFILE\.cargo", "$env:USERPROFILE\.rustup", 'C:\Users\haris\AppData\Local\Microsoft\WinGet')) {
    if (Test-Path $root) {
      $wv += Get-ChildItem $root -Recurse -Filter 'WebView2Loader.dll' -ErrorAction SilentlyContinue -File
    }
  }
  foreach ($w in ($wv | Sort-Object FullName -Unique)) {
    $ex = Get-ExportSet $w.FullName
    $names = if ($ex) { ($ex | Sort-Object) -join ',' } else { 'NO EXPORTS' }
    Add-Content $log ("{0}  ({1} bytes)  exports: {2}" -f $w.FullName, $w.Length, $names)
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
  Add-Content $log ($_.ScriptStackTrace)
}
Add-Content $log 'diag12 end'
