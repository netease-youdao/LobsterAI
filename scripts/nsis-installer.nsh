!include "FileFunc.nsh"

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
  ; remains, then force-remove the old install directory so that the old
  ; uninstaller (which may lack our customUnInit fix) is never invoked.

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

  ; ── Remove old installation directory ──
  ; After all processes are gone, ghost file handles may still linger for a
  ; few seconds. We must remove the old install directory — including the old
  ; uninstaller exe — to prevent electron-builder from invoking it (which
  ; lacks our customUnInit and would show an undismissable dialog).
  ;
  ; Strategy: rename $INSTDIR to a temp name (instant, even for thousands of
  ; files). The actual deletion is deferred to customInstall so that
  ; user-created skills in $INSTDIR.old\resources\SKILLs can be copied back
  ; into the new install before the old directory is removed.
  ; If rename fails (ghost file handles), skip — the installer's built-in
  ; uninstall step will handle the old directory.
  ; Remove any stale .old directory left by a previous interrupted install.
  ; NSIS Rename silently fails when the destination already exists, which
  ; would cause the skill-restore logic in customInstall to be skipped.
  IfFileExists "$INSTDIR.old\*.*" 0 SkipStaleOldDirCleanup
    nsExec::ExecToLog 'cmd /c rd /s /q "$INSTDIR.old"'
    Pop $0
  SkipStaleOldDirCleanup:

  IfFileExists "$INSTDIR\*.*" 0 SkipOldDirRemoval
    Rename "$INSTDIR" "$INSTDIR.old"
    IfErrors 0 RenameOK
      Goto SkipOldDirRemoval
    RenameOK:
      ; Deletion is deferred to customInstall, after user-created skills are
      ; copied back from $INSTDIR.old to the new $INSTDIR.
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

  ; ── Restore user-created skills from old install dir ──
  ; Read skills.config.json from the old install to identify bundled skill IDs.
  ; Skills in $INSTDIR.old that are NOT listed in skills.config.json defaults
  ; are user-created and copied back into the new install.
  ; Falls back to "copy anything not already in the new dir" if the config is absent.
  ; This runs synchronously so the app never launches before skills are ready.
  IfFileExists "$INSTDIR.old\*.*" 0 OldDirMissing
    FileWrite $2 "old-dir-status: present$\r$\n"
    Goto SkillRestoreBegin
  OldDirMissing:
    FileWrite $2 "old-dir-status: missing (rename failed or clean install)$\r$\n"
    Goto SkipSkillRestore
  SkillRestoreBegin:
    ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
    FileWrite $2 "skill-restore-start: $5-$4-$3 $6:$7:$8$\r$\n"

    nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "\
      $$oldSkills = [IO.Path]::Combine($\"$INSTDIR.old$\", $\"resources$\", $\"SKILLs$\");\
      $$newSkills = [IO.Path]::Combine($\"$INSTDIR$\",     $\"resources$\", $\"SKILLs$\");\
      $$config    = [IO.Path]::Combine($$oldSkills, $\"skills.config.json$\");\
      $$bundled   = @(try {\
        if (Test-Path $$config) {\
          (Get-Content $$config -Raw | ConvertFrom-Json).defaults.PSObject.Properties.Name\
        }\
      } catch { });\
      Get-ChildItem -Path $$oldSkills -Directory | ForEach-Object {\
        if ($$bundled -notcontains $$_.Name) {\
          $$target = [IO.Path]::Combine($$newSkills, $$_.Name);\
          if (-not (Test-Path $$target)) {\
            Copy-Item -Path $$_.FullName -Destination $$target -Recurse -Force\
              -ErrorAction SilentlyContinue\
          }\
        }\
      }"'
    Pop $0

    ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
    FileWrite $2 "skill-restore-done: $5-$4-$3 $6:$7:$8 exit=$0$\r$\n"
  SkipSkillRestore:

  ; ── Delete the old install directory now that user skills are restored ──
  IfFileExists "$INSTDIR.old\*.*" 0 SkipOldDirCleanup
    nsExec::Exec 'cmd /c rd /s /q "$INSTDIR.old"'
  SkipOldDirCleanup:

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
