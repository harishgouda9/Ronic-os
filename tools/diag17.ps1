$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag17.txt'
Set-Content -Path $log -Value 'diag17 start'
$target = "$env:LOCALAPPDATA\omniworkspace-target"

function Get-ManifestText([string]$path) {
  $b = [System.IO.File]::ReadAllBytes($path)
  $s = [System.Text.Encoding]::UTF8.GetString($b)
  $i = $s.IndexOf('<assembly', [System.StringComparison]::Ordinal)
  if ($i -lt 0) { return 'NO <assembly> FOUND' }
  $j = $s.IndexOf('</assembly>', $i, [System.StringComparison]::Ordinal)
  if ($j -lt 0) { return 'NO </assembly> FOUND' }
  $j = $j + 12
  $txt = $s.Substring($i, $j - $i)
  $txt = $txt -replace '[^\u0020-\u007E\r\n]', '.'
  return $txt
}

try {
  $exes = Get-ChildItem "$target\debug\deps" -Filter '*.exe' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime
  foreach ($c in $exes) {
    Add-Content $log ('=== ' + $c.Name + ' | ' + $c.LastWriteTime + ' | ' + $c.Length)
    Add-Content $log (Get-ManifestText $c.FullName)
    Add-Content $log ''
  }
} catch {
  Add-Content $log ('ERROR: ' + $_.Exception.Message)
}
Add-Content $log 'diag17 end'
