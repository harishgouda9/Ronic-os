$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag29.txt'
Set-Content -Path $log -Value 'diag29 start'
Push-Location "C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri"
$env:CARGO_TARGET_DIR = "C:\Users\haris\AppData\Local\omniworkspace-target"
cargo test --no-run --manifest-path Cargo.toml > $log 2>&1
Pop-Location
Add-Content $log 'diag29 end'