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

reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "FriendlyName" /t REG_SZ /d "Nava AI Reservationist" /f
reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "Description" /t REG_SZ /d "Nava AI Assistant" /f
reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "LoadBehavior" /t REG_DWORD /d 3 /f
reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "Manifest" /t REG_SZ /d "file:///%TARGET%\NavaOutlookAddin.vsto|vstolocal" /f

echo Done! Launch Outlook 2016 to verify.
pause
