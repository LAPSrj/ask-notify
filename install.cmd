@echo off
setlocal

set "SCRIPT_DIR=%~dp0"

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo Error: powershell.exe not found on PATH. 1>&2
  exit /b 1
)

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Error: node.exe not found on PATH. Install Node.js first. 1>&2
  exit /b 1
)

echo Running install.ps1...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1"
if errorlevel 1 exit /b %errorlevel%

echo.
echo Wiring the Notification hook into %%USERPROFILE%%\.claude\settings.json...
node "%SCRIPT_DIR%install-hook.js"
if errorlevel 1 exit /b %errorlevel%

endlocal
