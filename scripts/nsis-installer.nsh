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
  ; few seconds. RMDir /r will silently skip locked files but remove the rest
  ; — including the old uninstaller exe. This prevents electron-builder from
  ; invoking old-uninstaller.exe (which lacks our customUnInit and would show
  ; an "app cannot be closed" dialog the user can never dismiss).
  ; The new installer will lay down a complete fresh copy of all files.
  RMDir /r "$INSTDIR"
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

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'

  ; ─── Windows Defender Exclusion (optional, best-effort) ───
  ; Add the OpenClaw runtime directory to Windows Defender exclusions to avoid
  ; real-time scanning of ~3000 JS/native files during gateway startup.
  ; This can reduce first-launch time from ~120s to ~10s on Windows.
  ;
  ; This is a best-effort optimization:
  ; - Requires admin privileges (already elevated for installation)
  ; - Silently skipped if Defender is not running or policy disallows it
  ; - Only excludes the bundled runtime, not the entire application
  ; - Common practice for developer tools (VS Code, Docker Desktop, etc.)

  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "try { Add-MpPreference -ExclusionPath $\"$INSTDIR\resources\cfmind$\" -ErrorAction Stop; Write-Output ok } catch { Write-Output skip }"'
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
  ; Clean up the exclusion we added during installation.
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "try { Remove-MpPreference -ExclusionPath $\"$INSTDIR\resources\cfmind$\" -ErrorAction SilentlyContinue } catch {}"'
  Pop $0
  Pop $1
!macroend
