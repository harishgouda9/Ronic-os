$root = 'C:\Users\haris\OneDrive\Desktop\Omni Workspace OS'
$out = $env:TEMP
Set-Location $root
$lines = @()
$lines += '=== DIFF STAT ==='
$lines += (git --no-pager diff --stat 2>&1 | Out-String)
$lines += '=== DIFF (rust entry + config) ==='
$lines += (git --no-pager diff -- src-tauri/src/lib.rs src-tauri/tauri.conf.json package.json scripts/desktop.mjs 2>&1 | Out-String)
$lines += '=== VITE CONFIG ==='
$lines += (Get-Content (Join-Path $root 'vite.config.ts') -Raw -ErrorAction SilentlyContinue | Out-String)
$lines += '=== INDEX HTML ==='
$lines += (Get-Content (Join-Path $root 'index.html') -Raw -ErrorAction SilentlyContinue | Out-String)
$lines | Out-File -Encoding utf8 (Join-Path $out 'ow_diff.txt')
