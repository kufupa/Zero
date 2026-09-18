@echo off
setlocal
set "APP=%LOCALAPPDATA%\NavaOutlookAddin"
set "CER=%APP%\NavaOutlookAddin.cer"
set "VSTO=%APP%\NavaOutlookAddin.vsto"

if exist "%CER%" (
  certutil -user -addstore TrustedPublisher "%CER%" >nul 2>&1
  certutil -user -addstore Root "%CER%" >nul 2>&1
)

reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "FriendlyName" /t REG_SZ /d "Nava AI Reservationist" /f >nul
reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "Description" /t REG_SZ /d "Nava AI Assistant for Classic Outlook 2016" /f >nul
reg add "HKCU\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin" /v "LoadBehavior" /t REG_DWORD /d 3 /f >nul
reg add "HKCU\Software\Microsoft\Office\16.0\Outlook\Resiliency\DoNotDisableAddinList" /v "NavaOutlookAddin" /t REG_DWORD /d 1 /f >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$vsto = Join-Path $env:LOCALAPPDATA 'NavaOutlookAddin\NavaOutlookAddin.vsto'; if (-not (Test-Path -LiteralPath $vsto)) { exit 2 }; $uri = ([Uri]$vsto).AbsoluteUri + '|vstolocal'; $key = 'HKCU:\Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin'; New-Item -Path $key -Force | Out-Null; New-ItemProperty -Path $key -Name Manifest -PropertyType String -Value $uri -Force | Out-Null"

setx VSTO_SUPPRESSDISPLAYALERTS 0 >nul
setx VSTO_LOGALERTS 1 >nul
endlocal
exit /b 0
