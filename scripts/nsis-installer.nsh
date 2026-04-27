!include "FileFunc.nsh"

!macro GetTimestamp OUTVAR
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "[DateTime]::Now.ToString(\"yyyy-MM-dd HH:mm:ss.fff\")"'
  Pop $0
  Pop ${OUTVAR}
  StrCmp $0 "0" +2
    StrCpy ${OUTVAR} "unknown-time"
!macroend

!macro customHeader
  ; Request admin privileges for script execution (tar extract, etc.)
  ; This does NOT change the default install path — just ensures UAC elevation.
  RequestExecutionLevel admin

  ; Keep only the progress bar visible. The details box stays hidden and
  ; NSIS/electron-builder retains the default status text behavior.
  ShowInstDetails nevershow
!macroend

!macro customInit
  CreateDirectory "$APPDATA\LobsterAI"
  FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" w
  !insertmacro GetTimestamp $8
  FileWrite $9 "$8 phase=custom-init-start instdir=$INSTDIR appdata=$APPDATA$\r$\n"
  FileClose $9

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

  DetailPrint "[Installer] Stopping running LobsterAI processes"
  System::Call 'kernel32::GetTickCount()i .r7'
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
  System::Call 'kernel32::GetTickCount()i .r6'
  IntOp $5 $6 - $7
  FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
  !insertmacro GetTimestamp $8
  FileWrite $9 "$8 phase=process-stop-complete exit=$0 elapsed_ms=$5$\r$\n"
  FileClose $9

  ; ── Backup user-created skills to AppData before extraction overwrites them ──
  ; Copy non-bundled skills to %APPDATA%\LobsterAI\skills-backup\ so they are
  ; preserved when NSIS extracts the new version over the existing install.
  ; The backup is restored in customInstall after extraction completes.
  ;
  ; Quoting note: paths use \"..\" (backslash-escaped quote) — NOT $\"..$\" —
  ; because $\"..$\" produces raw quotes that Windows CRT argv parsing consumes,
  ; leaving the path unquoted and causing PowerShell method calls to fail.
  DetailPrint "[Installer] Backing up user-created skills"
  System::Call 'kernel32::GetTickCount()i .r7'
  ClearErrors
  FileOpen $R0 "$APPDATA\LobsterAI\skill-migrate.log" w
  IfErrors BackupLogOpenFailed
    !insertmacro GetTimestamp $8
    FileWrite $R0 "$8 phase=backup-start instdir=$INSTDIR appdata=$APPDATA$\r$\n"
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
  System::Call 'kernel32::GetTickCount()i .r6'
  IntOp $5 $6 - $7

  StrCmp $R0 "" BackupSkipCloseLog
    !insertmacro GetTimestamp $8
    FileWrite $R0 "$8 phase=backup-end exit=$0 elapsed_ms=$5$\r$\n"
    FileWrite $R0 "$8 phase=backup-output text=$1$\r$\n"
    FileClose $R0
  BackupSkipCloseLog:
  FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
  !insertmacro GetTimestamp $8
  FileWrite $9 "$8 phase=skill-backup-complete exit=$0 elapsed_ms=$5$\r$\n"
  FileClose $9

  ; ── Remove old installation directory ──
  ; Rename $INSTDIR so the old uninstaller exe disappears from its registered
  ; path — electron-builder cannot invoke it and the "app cannot be closed"
  ; dialog (present in old uninstallers that lack customUnInit) is never shown.
  ; User skills are already safe in the AppData backup above, so skill
  ; preservation does not depend on this rename succeeding.
  ;
  ; Important: never reuse a fixed "$INSTDIR.old" path. If a previous async
  ; delete leaves that directory behind, Rename fails immediately and the old
  ; uninstaller remains in place. Instead, schedule cleanup of any stale
  ; *.old* dirs, then rename to a unique per-run suffix and schedule deletion
  ; of that unique directory in the background so the installer UI can appear
  ; immediately after the rename succeeds.
  DetailPrint "[Installer] Removing previous installation directory"
  System::Call 'kernel32::GetTickCount()i .r7'
  IfFileExists "$INSTDIR\*.*" 0 SkipOldDirRemoval
    nsExec::ExecToLog 'cmd /c for /d %D in ("$INSTDIR.old*") do @start "" /b cmd /c rd /s /q "%~fD"'
    Pop $0
    System::Call 'kernel32::GetTickCount()i .r4'
    StrCpy $3 "$INSTDIR.old.$4"
    Rename "$INSTDIR" "$3"
    IfErrors 0 RenameOK
      Goto SkipOldDirRemoval
    RenameOK:
      nsExec::ExecToLog 'cmd /c start "" /b cmd /c rd /s /q "$3"'
      Pop $0
  SkipOldDirRemoval:
  System::Call 'kernel32::GetTickCount()i .r6'
  IntOp $5 $6 - $7
  FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
  !insertmacro GetTimestamp $8
  FileWrite $9 "$8 phase=old-install-cleanup-complete elapsed_ms=$5 renamed_path=$3 cleanup_mode=async$\r$\n"
  FileClose $9
!macroend

!macro customInstall
  ; ─── Install Timing Log ───
  ; Write timestamps to help diagnose slow installation phases.
  ; Log file: %APPDATA%\LobsterAI\install-timing.log

  CreateDirectory "$APPDATA\LobsterAI"
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=nsis-extract-complete$\r$\n"
  FileClose $2
  DetailPrint "[Installer] Preparing installation steps"

  ; ─── Extract combined resource archive (win-resources.tar) ───
  ; All large resource directories (cfmind/, SKILLs/, python-win/) are packed
  ; into a single tar file. NSIS 7z extracts one large file almost instantly;
  ; we then unpack the tar here using Electron's Node runtime.

  ; ─── Windows Defender Exclusion (optional, best-effort) ───
  ; Add exclusions before tar extraction so Defender does not slow down the
  ; expansion of large resource trees.
  CreateDirectory "$INSTDIR\resources\cfmind"
  CreateDirectory "$INSTDIR\resources\python-win"
  CreateDirectory "$INSTDIR\resources\SKILLs"
  DetailPrint "[Installer] Preparing resource directories"
  DetailPrint "[Installer] Adding Windows Defender exclusions before extraction"
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=defender-exclusion-start$\r$\n"
  FileClose $2
  System::Call 'kernel32::GetTickCount()i .r7'
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "try { Add-MpPreference -ExclusionPath $\"$INSTDIR\resources\cfmind$\",$\"$INSTDIR\resources\python-win$\",$\"$INSTDIR\resources\SKILLs$\",$\"$INSTDIR\resources\app.asar.unpacked$\" -ErrorAction Stop; Write-Output \"[Installer] Windows Defender exclusions added\" } catch { Write-Output (\"[Installer] Windows Defender exclusions skipped: \" + $$_.Exception.Message) }"'
  Pop $0
  System::Call 'kernel32::GetTickCount()i .r6'
  IntOp $5 $6 - $7
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=defender-exclusion-complete exit=$0 elapsed_ms=$5$\r$\n"
  FileClose $2

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'

  DetailPrint "[Installer] Launching bundled extractor"
  DetailPrint "[Installer] Extracting bundled resources"
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=tar-extract-start tar=$INSTDIR\resources\win-resources.tar dest=$INSTDIR\resources$\r$\n"
  FileClose $2
  System::Call 'kernel32::GetTickCount()i .r7'

  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\unpack-cfmind.cjs" "$INSTDIR\resources\win-resources.tar" "$INSTDIR\resources" "$APPDATA\LobsterAI\install-timing.log"'
  Pop $0
  System::Call 'kernel32::GetTickCount()i .r6'
  IntOp $5 $6 - $7

  StrCmp $0 "0" TarExtractOK
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=tar-extract-error exit=$0 elapsed_ms=$5$\r$\n"
    FileClose $2
    MessageBox MB_OK|MB_ICONEXCLAMATION "Resource extraction failed (exit code $0). See %APPDATA%\LobsterAI\install-timing.log for details."
  TarExtractOK:

  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=tar-extract-complete exit=$0 elapsed_ms=$5$\r$\n"
  FileClose $2
  DetailPrint "[Installer] Bundled resources extraction complete"
  Delete "$INSTDIR\resources\win-resources.tar"

  ; ── Restore user-created skills from AppData backup ──
  ; The backup was created in customInit before extraction began. Restore any
  ; skills not already present in the new install, then clean up the backup.
  IfFileExists "$APPDATA\LobsterAI\skills-backup\*.*" 0 SkipSkillRestore
    DetailPrint "[Installer] Restoring user-created skills"
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=skill-restore-start$\r$\n"
    FileClose $2
    System::Call 'kernel32::GetTickCount()i .r7'

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
    System::Call 'kernel32::GetTickCount()i .r6'
    IntOp $5 $6 - $7
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=skill-restore-complete exit=$0 elapsed_ms=$5$\r$\n"
    FileWrite $2 "$8 phase=skill-restore-output text=$1$\r$\n"
    FileClose $2
  SkipSkillRestore:

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'

  ; Clean up the unpack script — no longer needed after installation
  DetailPrint "[Installer] Cleaning up temporary installer files"
  Delete "$INSTDIR\resources\unpack-cfmind.cjs"

  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=install-complete$\r$\n"
  FileClose $2
  DetailPrint "[Installer] Installation complete"
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
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "try { Remove-MpPreference -ExclusionPath $\"$INSTDIR\resources\cfmind$\",$\"$INSTDIR\resources\python-win$\",$\"$INSTDIR\resources\SKILLs$\",$\"$INSTDIR\resources\app.asar.unpacked$\" -ErrorAction SilentlyContinue } catch {}"'
  Pop $0
  Pop $1
!macroend
