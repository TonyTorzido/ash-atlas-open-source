@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\dev\run-main.ps1" %*
set "ASH_ATLAS_EXIT=%ERRORLEVEL%"
if not "%ASH_ATLAS_EXIT%"=="0" (
  echo.
  echo Ash Atlas launcher failed with exit code %ASH_ATLAS_EXIT%.
  pause
)
exit /b %ASH_ATLAS_EXIT%
