@echo off
setlocal
cd /d "%~dp0"
echo ================================================
echo ModelPro Windows 10 Basic Test
echo ================================================
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR: PowerShell was not found.
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run-ModelPro-Basic-Test.ps1"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo TEST RESULT: PASS
) else (
  echo TEST RESULT: FAIL ^(exit %RC%^)
)
echo Logs are under: %~dp0logs
pause
exit /b %RC%
