$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag28.txt'
Set-Content -Path $log -Value 'diag28 start'
Push-Location "C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri"
$env:CARGO_TARGET_DIR = "C:\Users\haris\AppData\Local\omniworkspace-target"
cargo test --no-run --manifest-path Cargo.toml 2>&1 | Tee-Object -FilePath $log -Append
Pop-Location
Add-Content $log 'diag28 end'