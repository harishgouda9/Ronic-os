$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_hello.txt'
Set-Content -Path $log -Value 'hello test start'
try {
  $work = Join-Path $env:TEMP 'ow_hello_pg'
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  Set-Location $work
  $cargoBin = "$env:USERPROFILE\.cargo\bin"
  $tcBin = "$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin"

  Add-Content $log '=== create project ==='
  & "$cargoBin\cargo.exe" new hello --bin 2>&1 | Out-String | ForEach-Object { Add-Content $log $_ }

  Set-Location (Join-Path $work 'hello')
  $env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\omniworkspace-target"

  Add-Content $log '=== cargo test (hello) ==='
  $p = Start-Process -FilePath "$cargoBin\cargo.exe" -ArgumentList @('test','--message-format','short') `
    -WorkingDirectory (Join-Path $work 'hello') -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $env:TEMP 'ow_hello_out.txt') `
    -RedirectStandardError (Join-Path $env:TEMP 'ow_hello_err.txt')
  Add-Content $log ("cargo test exit: {0}" -f $p.ExitCode)
  Get-Content (Join-Path $env:TEMP 'ow_hello_out.txt') -ErrorAction SilentlyContinue | ForEach-Object { Add-Content $log $_ }
  Get-Content (Join-Path $env:TEMP 'ow_hello_err.txt') -ErrorAction SilentlyContinue | ForEach-Object { Add-Content $log $_ }

  Add-Content $log '=== direct run of hello test exe ==='
  $h = Get-ChildItem "$env:LOCALAPPDATA\omniworkspace-target\debug\deps" -Filter 'hello-*.exe' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($h) {
    Add-Content $log ("exe: {0}" -f $h.FullName)
    $env:PATH = "$tcBin;$env:PATH"
    $pp = Start-Process -FilePath $h.FullName -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput (Join-Path $env:TEMP 'ow_hello_exe_out.txt') `
      -RedirectStandardError (Join-Path $env:TEMP 'ow_hello_exe_err.txt')
    Add-Content $log ("direct run exit: {0}" -f $pp.ExitCode)
    Get-Content (Join-Path $env:TEMP 'ow_hello_exe_out.txt') -ErrorAction SilentlyContinue | ForEach-Object { Add-Content $log $_ }
    Get-Content (Join-Path $env:TEMP 'ow_hello_exe_err.txt') -ErrorAction SilentlyContinue | ForEach-Object { Add-Content $log $_ }
  } else { Add-Content $log 'no hello exe' }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'hello test end'
