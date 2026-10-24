@echo off
setlocal
set TARGET_DIR=C:\Users\haris\AppData\Local\omniworkspace-target\debug
echo === Finding manifest files ===
dir /s /b "%TARGET_DIR%\build\omniworkspace-*/out/common-controls-v6.manifest" 2>nul
echo === Finding build directories ===
dir /ad /b "%TARGET_DIR%\build\omniworkspace-*" 2>nul
endlocal