; Nava Outlook Assistant — zero-admin per-user installer.
; Post-install register-trust.cmd installs the build's self-signed cert into
; the current user's TrustedPublisher + Root stores and writes a URI-encoded
; file:/// Manifest (spaces in the Windows profile path become %20).

[Setup]
AppName=Nava Outlook Assistant
AppVersion=1.0.1
DefaultDirName={localappdata}\NavaOutlookAddin
DefaultGroupName=Nava AI
PrivilegesRequired=lowest
OutputBaseFilename=NavaOutlookSetup
OutputDir=.
Compression=lzma
SolidCompression=yes
CloseApplications=yes
RestartApplications=no

[Files]
Source: "..\NavaOutlookAddin\bin\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs
Source: "register-trust.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: string; ValueName: "FriendlyName"; ValueData: "Nava AI Reservationist"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: string; ValueName: "Description"; ValueData: "Nava AI Assistant for Classic Outlook 2016"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: dword; ValueName: "LoadBehavior"; ValueData: "3"
Root: HKCU; Subkey: "Software\Microsoft\Office\16.0\Outlook\Resiliency\DoNotDisableAddinList"; ValueType: dword; ValueName: "NavaOutlookAddin"; ValueData: "1"

[Run]
Filename: "{app}\register-trust.cmd"; StatusMsg: "Trusting Nava Outlook Assistant for this Windows user..."; Flags: waituntilterminated

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c certutil -user -delstore TrustedPublisher NavaOutlookAddin"; Flags: runhidden
