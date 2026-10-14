@echo off
setlocal
title LobsterAI Gateway Diagnostics
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect.ps1"
set "DIAG_EXIT=%ERRORLEVEL%"
if not "%DIAG_EXIT%"=="0" echo Diagnostic collection ended with code %DIAG_EXIT%. Please send a screenshot of this window to support.
echo.
pause
exit /b %DIAG_EXIT%
