$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag26.txt'
Set-Content -Path $log -Value 'diag26 start'
$reg = "$env:USERPROFILE\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f"
$tb = Join-Path $reg 'tauri-build-2.7.3'

Get-ChildItem $tb -Recurse -Filter '*.rs' | ForEach-Object {
  $hits = Select-String -Path $_.FullName -Pattern 'winres|manifest|rustc-link-arg|embed_resource|write_resource_file' -AllMatches
  if ($hits) {
    Add-Content $log ('=== ' + $_.FullName)
    $hits | ForEach-Object { Add-Content $log ('  ' + $_.LineNumber + ': ' + $_.Line.Trim()) }
  }
}
Add-Content $log 'diag26 end'
