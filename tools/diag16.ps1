$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag16.txt'
Set-Content -Path $log -Value 'diag16 start'
$target = "$env:LOCALAPPDATA\omniworkspace-target"

function Has-String([string]$path, [string]$needle) {
  $b = [System.IO.File]::ReadAllBytes($path)
  $s = [System.Text.Encoding]::ASCII.GetString($b)
  return $s.IndexOf($needle, [System.StringComparison]::Ordinal) -ge 0
}

try {
  $cands = @()
  $cands += Get-ChildItem "$target\debug\deps" -Filter 'omniworkspace*' -File -ErrorAction SilentlyContinue
  $cands += Get-ChildItem "$target\debug" -Filter '*.exe' -File -ErrorAction SilentlyContinue
  foreach ($c in $cands) {
    $m = Has-String $c.FullName 'Microsoft.Windows.Common-Controls'
    $t = Has-String $c.FullName 'TaskDialogIndirect'
    Add-Content $log ($c.FullName + ' | size=' + $c.Length + ' | manifest=' + $m + ' | taskdialog=' + $t)
  }
} catch {
  Add-Content $log ('ERROR: ' + $_.Exception.Message)
}
Add-Content $log 'diag16 end'
