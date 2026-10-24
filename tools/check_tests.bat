@echo off
echo === Checking for tests directory ===
if exist "C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri\tests" (
    echo Tests directory exists
    dir "C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri\tests"
) else (
    echo No tests directory
)

echo === Checking for #[test] in Rust source ===
findstr /r /c:"#\[test\]" "C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri\src\*.rs" 2>nul || echo "No #[test] found in src/"

echo === Checking for mod tests ===
findstr /r /c:"mod tests" "C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri\src\*.rs" 2>nul || echo "No mod tests found in src/"

echo === Checking for [[test]] in Cargo.toml ===
findstr /r /c:"\[\[test\]\]" "C:\Users\haris\OneDrive\Desktop\Omni Workspace OS\src-tauri\Cargo.toml" 2>nul || echo "No [[test]] in Cargo.toml"