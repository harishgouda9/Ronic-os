@echo off
set CARGO_TARGET_DIR=C:\Users\haris\AppData\Local\omniworkspace-target
cd /d "C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri"
cargo test --manifest-path Cargo.toml > C:\Users\haris\AppData\Local\Temp\ow_test_full.log 2>&1
echo EXIT_CODE=%ERRORLEVEL% >> C:\Users\haris\AppData\Local\Temp\ow_test_full.log