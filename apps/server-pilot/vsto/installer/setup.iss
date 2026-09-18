; Nava Outlook Assistant — zero-admin per-user installer.
; Kills Outlook, copies LocalAppData, runs RegisterTrust.exe (CurrentUser
; TrustedPublisher + Inclusion List + URI-encoded Manifest). Chains WebView2
; Evergreen bootstrapper when missing. Aborts if VSTO Runtime is absent.

[Setup]
AppName=Nava Outlook Assistant
AppVersion=1.0.2
DefaultDirName={localappdata}\NavaOutlookAddin
DefaultGroupName=Nava AI
PrivilegesRequired=lowest
OutputBaseFilename=NavaOutlookSetup
OutputDir=.
Compression=lzma
SolidCompression=yes
CloseApplications=force
RestartApplications=no
MinVersion=6.1sp1

[Files]
Source: "..\NavaOutlookAddin\bin\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs
Source: "RegisterTrust.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: string; ValueName: "FriendlyName"; ValueData: "Nava AI Reservationist"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: string; ValueName: "Description"; ValueData: "Nava AI Assistant for Classic Outlook 2016"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: dword; ValueName: "LoadBehavior"; ValueData: "3"
Root: HKCU; Subkey: "Software\Microsoft\Office\15.0\Outlook\Resiliency\DoNotDisableAddinList"; ValueType: dword; ValueName: "NavaOutlookAddin"; ValueData: "1"
Root: HKCU; Subkey: "Software\Microsoft\Office\16.0\Outlook\Resiliency\DoNotDisableAddinList"; ValueType: dword; ValueName: "NavaOutlookAddin"; ValueData: "1"

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2..."; Flags: waituntilterminated skipifsourcedoesntexist; Check: not WebView2Present

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c certutil -user -delstore TrustedPublisher NavaOutlookAddin"; Flags: runhidden

[Code]
function VstorPresent: Boolean;
begin
  Result :=
    RegValueExists(HKLM32, 'SOFTWARE\Microsoft\VSTO Runtime Setup\v4R', 'Version') or
    RegValueExists(HKLM32, 'SOFTWARE\Microsoft\VSTO Runtime Setup\v4', 'Version') or
    RegValueExists(HKLM64, 'SOFTWARE\Microsoft\VSTO Runtime Setup\v4R', 'Version') or
    RegValueExists(HKLM64, 'SOFTWARE\Microsoft\VSTO Runtime Setup\v4', 'Version');
end;

function WebView2Present: Boolean;
begin
  Result :=
    RegKeyExists(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') or
    RegKeyExists(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') or
    RegKeyExists(HKLM64, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') or
    RegKeyExists(HKLM32, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') or
    RegKeyExists(HKLM64, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}');
end;

function InitializeSetup(): Boolean;
begin
  if not VstorPresent then
  begin
    MsgBox('This PC is missing the Microsoft Office add-in runtime (VSTO). Nava cannot load in Outlook until IT installs "Visual Studio 2010 Tools for Office Runtime".', mbCriticalError, MB_OK);
    Result := False;
  end
  else
    Result := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  NeedsRestart := False;
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM OUTLOOK.EXE /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1500);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    if not Exec(ExpandConstant('{app}\RegisterTrust.exe'), '"' + ExpandConstant('{app}') + '"', ExpandConstant('{app}'), SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode) then
      MsgBox('Could not start Nava trust helper.', mbError, MB_OK)
    else if ResultCode <> 0 then
      MsgBox('Could not trust Nava for this Windows user (error ' + IntToStr(ResultCode) + '). If Windows asked about a certificate, click Yes and run Setup again.', mbError, MB_OK);
  end;
end;
