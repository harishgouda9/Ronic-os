$ErrorActionPreference = 'Continue'
$root = 'C:\Users\haris\OneDrive\Desktop\Omni Workspace OS'
$out = $env:TEMP
$userHome = $env:USERPROFILE
$env:PATH = "$userHome\.cargo\bin;$userHome\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin;$env:PATH"
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\omniworkspace-target"
$env:CARGO_TERM_PROGRESS_WHEN = 'never'
$env:CARGO_TERM_COLOR = 'never'

function Section([string]$name) {
  Write-Host "=== $name ==="
}

function Run-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$Exe,
    [string[]]$CmdArgs = @()
  )
  Section $Name
  $log = Join-Path $out $File
  $errLog = "$log.err"
  $p = Start-Process -FilePath $Exe -ArgumentList $CmdArgs -WorkingDirectory $WorkDir `
    -RedirectStandardOutput $log -RedirectStandardError $errLog -NoNewWindow -Wait -PassThru
  Get-Content $errLog -ErrorAction SilentlyContinue | Add-Content -Path $log -Encoding utf8
  Remove-Item $errLog -Force -ErrorAction SilentlyContinue
  Write-Host "$Name exit: $($p.ExitCode) (log: $log)"
  return $p.ExitCode
}

Set-Location $root

$results = @{}
$results['cargo-check'] = Run-Step -Name 'cargo-check' -WorkDir "$root\src-tauri" -File 'ow_cargo_check.txt' -Exe 'cargo' -CmdArgs @('check', '--all-targets', '--message-format', 'short')
$results['cargo-test'] = Run-Step -Name 'cargo-test' -WorkDir "$root\src-tauri" -File 'ow_cargo_test.txt' -Exe 'cargo' -CmdArgs @('test', '--message-format', 'short')
$results['tsc'] = Run-Step -Name 'tsc' -WorkDir $root -File 'ow_tsc.txt' -Exe 'node' -CmdArgs @('./node_modules/typescript/bin/tsc', '--noEmit')
$results['node-test'] = Run-Step -Name 'node-test' -WorkDir $root -File 'ow_nodetest.txt' -Exe 'node' -CmdArgs @('--test', 'scripts/desktop.test.mjs')

$failed = @()
foreach ($k in $results.Keys) {
  if ($results[$k] -ne 0) { $failed += "$k($($results[$k]))" }
}
if ($failed.Count -gt 0) {
  Write-Host "FAILED: $($failed -join ', ')"
  exit 1
}
Write-Host 'ALL PASSED'
exit 0
