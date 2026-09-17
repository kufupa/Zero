; Nava Outlook Assistant — zero-admin per-user installer.
; ClickOnce Inclusion List public-key hashes must be generated on the Windows
; signing box. This script does not treat an empty Inclusion key as trust.
; Local load relies on LoadBehavior=3 and file:///...|vstolocal.

[Setup]
AppName=Nava Outlook Assistant
AppVersion=1.0.0
DefaultDirName={userlocalappdata}\NavaOutlookAddin
DefaultGroupName=Nava AI
PrivilegesRequired=lowest
OutputBaseFilename=NavaOutlookSetup
OutputDir=.
Compression=lzma
SolidCompression=yes

[Files]
Source: "..\NavaOutlookAddin\bin\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: string; ValueName: "FriendlyName"; ValueData: "Nava AI Reservationist"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: string; ValueName: "Description"; ValueData: "Nava AI Assistant for Classic Outlook 2016"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: dword; ValueName: "LoadBehavior"; ValueData: "3"
Root: HKCU; Subkey: "Software\Microsoft\Office\Outlook\Addins\NavaOutlookAddin"; ValueType: string; ValueName: "Manifest"; ValueData: "file:///{app}\NavaOutlookAddin.vsto|vstolocal"

; Clear Outlook resiliency blacklist so a previous crash does not keep the add-in disabled.
Root: HKCU; Subkey: "Software\Microsoft\Office\16.0\Outlook\Resiliency\DisabledItems"; ValueType: none; Flags: deletekey dontcreatekey
Root: HKCU; Subkey: "Software\Microsoft\Office\16.0\Outlook\Resiliency\DoNotDisableAddinList"; ValueType: dword; ValueName: "NavaOutlookAddin"; ValueData: "1"
