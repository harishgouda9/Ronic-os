$root = 'C:\Users\haris\OneDrive\Desktop\Omni Workspace OS'
$out = $env:TEMP
$stdout = Join-Path $out 'ow_run.txt'
$stderr = Join-Path $out 'ow_run.err.txt'
Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
$script = Join-Path $root 'tools\run.ps1'
$p = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $script + '"') `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$p.Id | Out-File -Encoding ascii (Join-Path $out 'ow_pid.txt')
"launched pid=$($p.Id)" | Out-File -Encoding utf8 (Join-Path $out 'ow_launch.txt')
