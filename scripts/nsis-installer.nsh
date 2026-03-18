!include "FileFunc.nsh"

!macro customHeader
  ; Hide the (empty) details list — electron-builder uses 7z solid extraction
  ; which produces no per-file output, so the box would just be blank.
  ShowInstDetails nevershow
!macroend

!macro customInit
  ; Best-effort: terminate a running app instance before install/uninstall
  ; to avoid NSIS "app cannot be closed" errors during upgrades.
  nsExec::ExecToLog 'taskkill /IM "${APP_EXECUTABLE_FILENAME}" /F /T'
  Pop $0
  Sleep 800
!macroend

!macro customInstall
  ; ─── Install Timing Log ───
  ; Write timestamps to help diagnose slow installation phases.
  ; Log file: %APPDATA%\LobsterAI\install-timing.log

  CreateDirectory "$APPDATA\LobsterAI"
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" w

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "extract-done: $5-$4-$3 $6:$7:$8$\r$\n"

  ; ─── V8 Compile Cache Warmup (silent) ───
  ; After files are extracted to $INSTDIR, load the gateway bundle once using
  ; Electron's own Node runtime (ELECTRON_RUN_AS_NODE=1) so V8 compiles and
  ; caches the bytecode.  This turns the user's first gateway startup from
  ; ~95s (cold V8 compile) into ~15s (cached bytecode).
  ;
  ; The warmup script is a no-op when the bundle is missing and exits 0 on
  ; any error, so it cannot block or break the installer.

  SetDetailsPrint none

  StrCpy $1 "$APPDATA\LobsterAI\openclaw\state\.compile-cache"

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "NODE_COMPILE_CACHE", t "$1")i'

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "warmup-start: $5-$4-$3 $6:$7:$8$\r$\n"

  nsExec::ExecToStack '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\cfmind\warmup-compile-cache.cjs" --cache-dir "$1"'
  Pop $0
  Pop $1

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "warmup-done: $5-$4-$3 $6:$7:$8 exit=$0$\r$\n"

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "NODE_COMPILE_CACHE", t "")i'

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "install-done: $5-$4-$3 $6:$7:$8$\r$\n"
  FileClose $2

  SetDetailsPrint both
!macroend
