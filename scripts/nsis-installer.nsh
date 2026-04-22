!include "FileFunc.nsh"

!define ROOT_DRIVE_INSTALL_DIR_SUFFIX "LobsterAI"

Function TrimTrailingPathSeparator
  Exch $0
  Push $1

  StrCmp $0 "" TrimTrailingPathSeparatorDone

  StrCpy $1 $0 1 -1
  StrCmp $1 "\" 0 +2
  StrCpy $0 $0 -1
  StrCmp $1 "/" 0 TrimTrailingPathSeparatorDone
  StrCpy $0 $0 -1

TrimTrailingPathSeparatorDone:
  Pop $1
  Exch $0
FunctionEnd

Function NormalizeRootDriveInstallDirectory
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5

  ${GetRoot} "$0" $1
  StrCmp $1 "" NormalizeRootDriveInstallDirectoryDone

  Push $0
  Call TrimTrailingPathSeparator
  Pop $2

  Push $1
  Call TrimTrailingPathSeparator
  Pop $3

  StrCmp "$2" "$3" 0 NormalizeRootDriveInstallDirectoryDone

  StrLen $4 $3
  IntCmp $4 2 NormalizeRootDriveInstallDirectoryDone NormalizeRootDriveInstallDirectoryIsDriveRoot NormalizeRootDriveInstallDirectoryDone

NormalizeRootDriveInstallDirectoryIsDriveRoot:
  StrCpy $5 $3 1 1
  StrCmp $5 ":" 0 NormalizeRootDriveInstallDirectoryDone

  StrCpy $4 $1 1 -1
  StrCmp $4 "\" NormalizeRootDriveInstallDirectoryHasSeparator
  StrCmp $4 "/" NormalizeRootDriveInstallDirectoryHasSeparator
  StrCpy $1 "$1\"

NormalizeRootDriveInstallDirectoryHasSeparator:
  StrCpy $0 "$1${ROOT_DRIVE_INSTALL_DIR_SUFFIX}"

NormalizeRootDriveInstallDirectoryDone:
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

Function .onVerifyInstDir
  Push $0
  StrCpy $0 $INSTDIR
  Push $0
  Call NormalizeRootDriveInstallDirectory
  Pop $INSTDIR
  Pop $0
FunctionEnd

!macro customHeader
  ; Request admin privileges for script execution (tar extract, etc.)
  ; This does NOT change the default install path — just ensures UAC elevation.
  RequestExecutionLevel admin

  ; Hide the (empty) details list — electron-builder uses 7z solid extraction
  ; which produces no per-file output, so the box would just be blank.
  ShowInstDetails nevershow
!macroend

!macro customInit
  ; ── Kill every process that might hold file handles in the install dir ──
  ;
  ; 1. LobsterAI.exe — the main app AND the OpenClaw gateway (ELECTRON_RUN_AS_NODE)
  ; 2. node.exe whose binary lives inside the LobsterAI install tree
  ;    (Web Search bridge server, MCP servers spawned with detached:true)
  ;
  ; Stop-Process -Force is equivalent to taskkill /F — the processes have no
  ; chance to run before-quit cleanup, so file handles may linger briefly as
  ; "ghost handles" in the Windows kernel. We poll until no matching process
  ; remains before proceeding.

  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "\
    Stop-Process -Name LobsterAI -Force -ErrorAction SilentlyContinue;\
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*LobsterAI*\" } | Stop-Process -Force -ErrorAction SilentlyContinue;\
    for ($$i = 0; $$i -lt 15; $$i++) {\
      $$procs = @();\
      $$procs += Get-Process -Name LobsterAI -ErrorAction SilentlyContinue;\
      $$procs += Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*LobsterAI*\" };\
      if ($$procs.Count -eq 0) { break };\
      Start-Sleep -Milliseconds 500;\
    }"'
  Pop $0

  ; ── Backup user-created skills to AppData before extraction overwrites them ──
  ; Copy non-bundled skills to %APPDATA%\LobsterAI\skills-backup\ so they are
  ; preserved when NSIS extracts the new version over the existing install.
  ; The backup is restored in customInstall after extraction completes.
  ;
  ; Quoting note: paths use \"..\" (backslash-escaped quote) — NOT $\"..$\" —
  ; because $\"..$\" produces raw quotes that Windows CRT argv parsing consumes,
  ; leaving the path unquoted and causing PowerShell method calls to fail.
  CreateDirectory "$APPDATA\LobsterAI"
  ClearErrors
  FileOpen $R0 "$APPDATA\LobsterAI\skill-migrate.log" w
  IfErrors BackupLogOpenFailed
    FileWrite $R0 "backup-start INSTDIR=$INSTDIR APPDATA=$APPDATA$\r$\n"
    Goto BackupDoExec
  BackupLogOpenFailed:
    StrCpy $R0 ""
  BackupDoExec:

  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "\
    $$src    = \"$INSTDIR\resources\SKILLs\";\
    $$backup = \"$APPDATA\LobsterAI\skills-backup\";\
    $$config = \"$$src\skills.config.json\";\
    if (Test-Path $$backup) { Remove-Item -Path $$backup -Recurse -Force -ErrorAction SilentlyContinue };\
    if (Test-Path $$src) {\
      $$bundled = @(try {\
        if (Test-Path $$config) {\
          (Get-Content $$config -Raw | ConvertFrom-Json).defaults.PSObject.Properties.Name\
        }\
      } catch { });\
      $$userSkills = @(Get-ChildItem -Path $$src -Directory | Where-Object { $$bundled -notcontains $$_.Name });\
      if ($$userSkills.Count -gt 0) {\
        New-Item -ItemType Directory -Path $$backup -Force | Out-Null;\
        $$userSkills | ForEach-Object {\
          Copy-Item -Path $$_.FullName -Destination (Join-Path $$backup $$_.Name) -Recurse -Force\
        }\
      }\
    }"'
  Pop $0
  Pop $1

  StrCmp $R0 "" BackupSkipCloseLog
    FileWrite $R0 "backup-end exit=$0$\r$\n"
    FileWrite $R0 "output: $1$\r$\n"
    FileClose $R0
  BackupSkipCloseLog:

  ; ── Remove old installation directory ──
  ; Rename $INSTDIR so the old uninstaller exe disappears from its registered
  ; path — electron-builder cannot invoke it and the "app cannot be closed"
  ; dialog (present in old uninstallers that lack customUnInit) is never shown.
  ; User skills are already safe in the AppData backup above, so skill
  ; preservation does not depend on this rename succeeding.
  IfFileExists "$INSTDIR\*.*" 0 SkipOldDirRemoval
    Rename "$INSTDIR" "$INSTDIR.old"
    IfErrors 0 RenameOK
      Goto SkipOldDirRemoval
    RenameOK:
      nsExec::Exec 'cmd /c rd /s /q "$INSTDIR.old"'
  SkipOldDirRemoval:
!macroend

!macro customInstall
  ; ─── Install Timing Log ───
  ; Write timestamps to help diagnose slow installation phases.
  ; Log file: %APPDATA%\LobsterAI\install-timing.log

  CreateDirectory "$APPDATA\LobsterAI"
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" w

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "extract-done: $5-$4-$3 $6:$7:$8$\r$\n"

  ; ─── Extract combined resource archive (win-resources.tar) ───
  ; All large resource directories (cfmind/, SKILLs/, python-win/) are packed
  ; into a single tar file. NSIS 7z extracts one large file almost instantly;
  ; we then unpack the tar here using Electron's Node runtime.

  SetDetailsPrint none

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-start: $5-$4-$3 $6:$7:$8$\r$\n"

  nsExec::ExecToStack '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\unpack-cfmind.cjs" "$INSTDIR\resources\win-resources.tar" "$INSTDIR\resources"'
  Pop $0
  Pop $1

  StrCmp $0 "0" TarExtractOK
    FileWrite $2 "tar-extract-error: exit=$0 output=$1$\r$\n"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Resource extraction failed (exit code $0):$\r$\n$\r$\n$1"
  TarExtractOK:

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-done: $5-$4-$3 $6:$7:$8 exit=$0$\r$\n"
  Delete "$INSTDIR\resources\win-resources.tar"

  ; ── Restore user-created skills from AppData backup ──
  ; The backup was created in customInit before extraction began. Restore any
  ; skills not already present in the new install, then clean up the backup.
  IfFileExists "$APPDATA\LobsterAI\skills-backup\*.*" 0 SkipSkillRestore
    ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
    FileWrite $2 "skill-restore-start: $5-$4-$3 $6:$7:$8$\r$\n"

    nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "\
      $$backup    = \"$APPDATA\LobsterAI\skills-backup\";\
      $$newSkills = \"$INSTDIR\resources\SKILLs\";\
      Get-ChildItem -Path $$backup -Directory | ForEach-Object {\
        $$target = Join-Path $$newSkills $$_.Name;\
        if (-not (Test-Path $$target)) {\
          Copy-Item -Path $$_.FullName -Destination $$target -Recurse -Force\
        }\
      };\
      Remove-Item -Path $$backup -Recurse -Force -ErrorAction SilentlyContinue"'
    Pop $0
    Pop $1

    ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
    FileWrite $2 "skill-restore-done: $5-$4-$3 $6:$7:$8 exit=$0$\r$\n"
    FileWrite $2 "skill-restore-output: $1$\r$\n"
  SkipSkillRestore:

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'

  ; ─── Windows Defender Exclusion (optional, best-effort) ───
  ; Add the install directory and appdata directory to Windows Defender
  ; exclusions to avoid real-time scanning during startup.
  ;
  ; $INSTDIR          — bundled runtime (cfmind ~3000 files), SKILLs, python-win
  ; $APPDATA\LobsterAI — compile cache, SQLite state, config, logs
  ;
  ; This is a best-effort optimization:
  ; - Requires admin privileges (already elevated for installation)
  ; - Silently skipped if Defender is not running or policy disallows it
  ; - Common practice for developer tools (VS Code, Docker Desktop, etc.)

  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "try { Add-MpPreference -ExclusionPath $\"$INSTDIR$\",$\"$APPDATA\LobsterAI$\" -ErrorAction Stop; Write-Output ok } catch { Write-Output skip }"'
  Pop $0
  Pop $1
  FileWrite $2 "defender-exclusion: exit=$0 result=$1$\r$\n"

  ; Clean up the unpack script — no longer needed after installation
  Delete "$INSTDIR\resources\unpack-cfmind.cjs"

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "install-done: $5-$4-$3 $6:$7:$8$\r$\n"
  FileClose $2

  SetDetailsPrint both
!macroend

!macro customUnInit
  ; Kill all running app instances (main app + OpenClaw gateway + detached
  ; node.exe services) before the uninstaller's built-in process check.
  ; Without this, the uninstaller detects the OpenClaw gateway process
  ; (also named LobsterAI.exe) and shows an "app cannot be closed" dialog
  ; where even "Retry" never succeeds — because the gateway has no UI window
  ; for the user to close.
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "\
    Stop-Process -Name LobsterAI -Force -ErrorAction SilentlyContinue;\
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*LobsterAI*\" } | Stop-Process -Force -ErrorAction SilentlyContinue;\
    for ($$i = 0; $$i -lt 15; $$i++) {\
      $$procs = @();\
      $$procs += Get-Process -Name LobsterAI -ErrorAction SilentlyContinue;\
      $$procs += Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*LobsterAI*\" };\
      if ($$procs.Count -eq 0) { break };\
      Start-Sleep -Milliseconds 500;\
    }"'
  Pop $0
!macroend

!macro customUnInstall
  ; ─── Remove Windows Defender Exclusion on uninstall ───
  ; Clean up the exclusions we added during installation.
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "try { Remove-MpPreference -ExclusionPath $\"$INSTDIR$\",$\"$APPDATA\LobsterAI$\" -ErrorAction SilentlyContinue } catch {}"'
  Pop $0
  Pop $1
!macroend
