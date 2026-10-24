@echo off
setlocal
set BASE=C:\Users\haris\AppData\Local\omniworkspace-target\debug\build\omniworkspace-fbd240536546b465
echo === Contents of out dir ===
dir /b "%BASE%\out\" 2>nul || echo "out dir not found"
echo === Contents of build dir ===
dir /b "%BASE%\" 2>nul
endlocal