$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag27.txt'
Set-Content -Path $log -Value 'diag27 start'
Push-Location "C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri"
cargo test --no-run --manifest-path Cargo.toml 2>&1 | Tee-Object -FilePath $log -Append
Pop-Location
Add-Content $log 'diag27 end'
