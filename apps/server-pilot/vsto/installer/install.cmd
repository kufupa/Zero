@echo off
echo Installing Nava Outlook Assistant into User AppData...
set TARGET=%LOCALAPPDATA%\NavaOutlookAddin
set SCRIPT_DIR=%~dp0
taskkill /F /IM OUTLOOK.EXE /T >nul 2>&1
mkdir "%TARGET%" 2>nul
xcopy /Y /E "%SCRIPT_DIR%..\NavaOutlookAddin\bin\Release\*" "%TARGET%\"
if errorlevel 1 (
  echo Copy failed. Build NavaOutlookAddin in Release first.
  exit /b 1
)
if exist "%SCRIPT_DIR%RegisterTrust.exe" copy /Y "%SCRIPT_DIR%RegisterTrust.exe" "%TARGET%\" >nul
"%TARGET%\RegisterTrust.exe" "%TARGET%"
if errorlevel 1 (
  echo Trust registration failed.
  exit /b 1
)
echo Done! Launch Outlook 2016 to verify.
pause
