@echo off
echo Installing Nava Outlook Assistant into User AppData...
set TARGET=%LOCALAPPDATA%\NavaOutlookAddin
mkdir "%TARGET%" 2>nul
xcopy /Y /E bin\Release\* "%TARGET%\"

reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "FriendlyName" /t REG_SZ /d "Nava AI Reservationist" /f
reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "Description" /t REG_SZ /d "Nava AI Assistant" /f
reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "LoadBehavior" /t REG_DWORD /d 3 /f
reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "Manifest" /t REG_SZ /d "file:///%TARGET%\NavaOutlookAddin.vsto|vstolocal" /f
reg delete "HKCU\Software\Microsoft\Office\16.0\Outlook\Resiliency\DisabledItems" /f 2>nul

echo Done! Launch Outlook 2016 to verify.
pause
