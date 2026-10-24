@echo off
setlocal
set BASE=C:\Users\haris\AppData\Local\omniworkspace-target\debug\build
echo === Checking for manifest in all build dirs ===
for /d %%d in ("%BASE%\omniworkspace-*") do (
    echo Checking %%d\out\
    dir /b "%%d\out\common-controls-v6.manifest" 2>nul && echo   FOUND
    if exist "%%d\out\common-controls-v6.manifest" echo   FOUND at %%d\out\common-controls-v6.manifest
)
echo === Also checking for .rc files ===
for /d %%d in ("%BASE%\omniworkspace-*") do (
    dir /b "%%d\out\common-controls-v6.rc" 2>nul && echo   FOUND RC at %%d\out\common-controls-v6.rc
)
endlocal