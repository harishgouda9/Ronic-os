$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag14.txt'
Set-Content -Path $log -Value 'diag14 start'
$reg = Join-Path $env:USERPROFILE '.cargo\registry\src\index.crates.io-1949cf8c6b5b557f'

try {
  Add-Content $log '=== tauri-build versions ==='
  Get-ChildItem $reg -Directory -Filter 'tauri-build-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Add-Content $log ("  {0}" -f $_.Name) }

  Add-Content $log ''
  Add-Content $log '=== tauri-build: manifest / comctl32 / winres references ==='
  $tb = Get-ChildItem $reg -Directory -Filter 'tauri-build-*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($tb) {
    Get-ChildItem $tb.FullName -Recurse -Include '*.rs' -ErrorAction SilentlyContinue |
      Select-String -Pattern 'manifest|comctl32|Common-Controls|winres|embed_resource|WindowsResource' -ErrorAction SilentlyContinue |
      ForEach-Object { Add-Content $log ("  {0}:{1}: {2}" -f $_.Filename, $_.LineNumber, $_.Line.Trim()) }
  }

  Add-Content $log ''
  Add-Content $log '=== tauri-build manifest files on disk ==='
  Get-ChildItem $tb.FullName -Recurse -Include '*.manifest','*.xml' -ErrorAction SilentlyContinue |
    ForEach-Object { Add-Content $log ("  {0}" -f $_.FullName) }

  Add-Content $log ''
  Add-Content $log '=== muda windows/mod.rs TaskDialogIndirect context ==='
  $muda = Join-Path $reg 'muda-0.20.0\src\platform_impl\windows\mod.rs'
  if (Test-Path $muda) {
    $lines = Get-Content $muda
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match 'TaskDialogIndirect') {
        $s = [Math]::Max(0, $i - 12); $e = [Math]::Min($lines.Count - 1, $i + 4)
        for ($j = $s; $j -le $e; $j++) { Add-Content $log ("  {0,5}: {1}" -f ($j+1), $lines[$j]) }
        Add-Content $log '  ---'
      }
    }
  }

  Add-Content $log ''
  Add-Content $log '=== Cargo.lock versions ==='
  $lock = 'c:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri\Cargo.lock'
  Select-String -Path $lock -Pattern 'name = "muda"|name = "tauri-build"|name = "tauri-runtime-wry"|name = "tauri"|name = "embed-resource"|name = "winres"' -Context 0,1 |
    ForEach-Object { Add-Content $log ("  {0} {1}" -f $_.Line.Trim(), ($_.Context.PostContext -join '').Trim()) }

  Add-Content $log ''
  Add-Content $log '=== tauri crate: does it embed a manifest? ==='
  $tauri = Get-ChildItem $reg -Directory -Filter 'tauri-2.*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if ($tauri) {
    Add-Content $log ("tauri dir: {0}" -f $tauri.Name)
    Get-ChildItem $tauri.FullName -Recurse -Include '*.manifest','*.xml' -ErrorAction SilentlyContinue |
      ForEach-Object { Add-Content $log ("  {0}" -f $_.FullName) }
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag14 end'
