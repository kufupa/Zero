; Nava Outlook Assistant — zero-admin per-user installer.
; Kills Outlook, copies LocalAppData, runs RegisterTrust.exe (CurrentUser
; TrustedPublisher + Inclusion List + URI-encoded Manifest). Chains WebView2
; Evergreen bootstrapper when missing. Aborts if VSTO Runtime is absent.
; Trust, WebView2, and Outlook-still-running are fatal — Setup must not
; report success with a dead add-in.

[Setup]
AppName=Nava Outlook Assistant
AppVersion=1.0.7
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

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c certutil -user -delstore TrustedPublisher NavaOutlookAddin"; Flags: runhidden

[Code]
procedure FailSetup(const Message: String);
begin
  MsgBox(Message, mbCriticalError, MB_OK);
  Abort;
end;

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

function OutlookStillRunning: Boolean;
var
  ResultCode: Integer;
  TmpFile, Listing: String;
begin
  TmpFile := ExpandConstant('{tmp}\nava-outlook-tasklist.txt');
  Exec(ExpandConstant('{cmd}'), '/C tasklist /FI "IMAGENAME eq OUTLOOK.EXE" /NH > "' + TmpFile + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Listing := '';
  LoadStringFromFile(TmpFile, Listing);
  Result :=
    (Pos('OUTLOOK.EXE', Uppercase(Listing)) > 0) or
    (FindWindowByClassName('rctrl_renwnd32') <> 0);
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
  Tries: Integer;
begin
  NeedsRestart := False;
  Tries := 0;
  while Tries < 3 do
  begin
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM OUTLOOK.EXE /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1500);
    if not OutlookStillRunning then
    begin
      Result := '';
      Exit;
    end;
    Inc(Tries);
  end;
  Result := 'Outlook is still running. Close Outlook completely (check the hidden icons by the clock), then run Setup again.';
end;

procedure EnsureWebView2;
var
  ResultCode: Integer;
  Bootstrapper: String;
begin
  if WebView2Present then
    Exit;
  Bootstrapper := ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe');
  if not FileExists(Bootstrapper) then
    FailSetup('This installer is missing Microsoft Edge WebView2. Download Nava Outlook Setup again.');
  if not Exec(Bootstrapper, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    FailSetup('Could not start Microsoft Edge WebView2 setup. Nava cannot open without it.');
  if (ResultCode <> 0) or (not WebView2Present) then
    FailSetup('Microsoft Edge WebView2 did not install. Check internet, then run Setup again.');
end;

procedure EnsureTrust;
var
  ResultCode: Integer;
begin
  if not Exec(ExpandConstant('{app}\RegisterTrust.exe'), '"' + ExpandConstant('{app}') + '"', ExpandConstant('{app}'), SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode) then
    FailSetup('Could not start Nava trust helper. Setup did not finish. Run Setup again.');
  if ResultCode <> 0 then
    FailSetup('Could not trust Nava for this Windows user (error ' + IntToStr(ResultCode) + '). If Windows asked about a certificate, click Yes, then run Setup again.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    EnsureWebView2;
    EnsureTrust;
  end;
end;
