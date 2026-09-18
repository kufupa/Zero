@echo off
echo Installing Nava Outlook Assistant into User AppData...
set TARGET=%LOCALAPPDATA%\NavaOutlookAddin
set SCRIPT_DIR=%~dp0
mkdir "%TARGET%" 2>nul
xcopy /Y /E "%SCRIPT_DIR%..\NavaOutlookAddin\bin\Release\*" "%TARGET%\"
if errorlevel 1 (
  echo Copy failed. Build NavaOutlookAddin in Release first.
  exit /b 1
)

call "%SCRIPT_DIR%register-trust.cmd"

echo Done! Launch Outlook 2016 to verify.
pause
