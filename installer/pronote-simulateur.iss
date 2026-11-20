; Installeur Inno Setup de pronote-simulateur. Compilation : iscc installer\pronote-simulateur.iss
; Le setup est cree dans installer\Output\pronote-simulateur-Setup-1.0.0.exe
#define MyAppName "pronote-simulateur"
#define MyAppVersion "2.0.0"
#define MyAppURL "https://github.com/Les-Doubles-A/pronote-simulateur"

[Setup]
AppId={{91D48A7E-62F1-4B3C-8D2A-7E59C0F41B32}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Les-Doubles-A
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=Output
OutputBaseFilename={#MyAppName}-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
SetupIconFile=pronote-simulateur.ico
UninstallDisplayIcon={app}\pronote-simulateur.ico
InfoAfterFile=INSTALLATION.txt
Uninstallable=yes

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "INSTALLATION.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "pronote-simulateur.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\icons\*"; DestDir: "{app}\extension\icons"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\manifest.json"; DestDir: "{app}\extension"; Flags: ignoreversion
Source: "..\background.js"; DestDir: "{app}\extension"; Flags: ignoreversion
Source: "..\content.js"; DestDir: "{app}\extension"; Flags: ignoreversion
Source: "..\styles.css"; DestDir: "{app}\extension"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName} - dossier de l'extension"; Filename: "{app}\extension"; IconFilename: "{app}\pronote-simulateur.ico"
Name: "{autoprograms}\{#MyAppName} - instructions"; Filename: "{app}\INSTALLATION.txt"

[Run]
Filename: "{app}\extension"; Description: "Ouvrir le dossier de l'extension"; Flags: postinstall shellexec skipifsilent nowait
