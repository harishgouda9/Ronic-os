@echo off
setlocal enabledelayedexpansion
set TARGET_DIR=C:\Users\haris\AppData\Local\omniworkspace-target\debug\deps
set BUILD_BASE=C:\Users\haris\AppData\Local\omniworkspace-target\debug\build

echo === Finding manifest ===
set MANIFEST_SRC=
for /d %%d in ("%BUILD_BASE%\omniworkspace-*") do (
    if exist "%%d\out\common-controls-v6.manifest" (
        set MANIFEST_SRC=%%d\out\common-controls-v6.manifest
        goto :found_manifest
    )
)
:found_manifest

if not defined MANIFEST_SRC (
    echo ERROR: Manifest not found
    goto :eof
)
echo Found manifest: %MANIFEST_SRC%

echo === Finding test executables ===
dir /b "%TARGET_DIR%\omniworkspace_lib-*.exe" 2>nul

echo === Copying manifest alongside test executables ===
for %%f in ("%TARGET_DIR%\omniworkspace_lib-*.exe") do (
    echo Copying manifest to %%~dpnf.manifest
    copy /y "%MANIFEST_SRC%" "%%~dpnf.manifest" >nul 2>&1
    if exist "%%~dpnf.manifest" (
        echo   OK: %%~nxf.manifest
    ) else (
        echo   FAILED: %%~nxf.manifest
    )
)

echo === Running latest test executable ===
for /f "delims=" %%f in ('dir /b /o-d "%TARGET_DIR%\omniworkspace_lib-*.exe" 2^>nul') do (
    set LATEST=%%f
    goto :found
)
:found
if defined LATEST (
    echo Path: %TARGET_DIR%\%LATEST%
    "%TARGET_DIR%\%LATEST%" > C:\Users\haris\AppData\Local\Temp\ow_test_run.log 2>&1
    echo EXIT_CODE=%ERRORLEVEL%
    type C:\Users\haris\AppData\Local\Temp\ow_test_run.log
) else (
    echo No test executable found
)
endlocal