!include "FileFunc.nsh"

; Build-time payload size metadata, generated into build-tar/ by
; scripts/electron-builder-hooks.cjs (afterPack) on every Windows packaging
; run. PROJECT_DIR is defined by electron-builder for each makensis
; invocation, so a missing fragment fails the packaging build loudly instead
; of shipping an installer without payload validation. Ad-hoc syntax checks
; without PROJECT_DIR compile with size validation degraded to
; existence-only checks and the staging-drive preflight disabled.
!ifdef PROJECT_DIR
  !include "${PROJECT_DIR}\build-tar\win-installer-payload-size.nsh"
!endif

; Free-space headroom on top of the measured payload sizes: NTFS cluster
; slack across tens of thousands of staged files, log/registry churn, and
; general safety. All staging space math is done in MB because NSIS
; integers are 32-bit signed and the extracted tree alone exceeds 2 GB.
!define LOBSTER_STAGING_MARGIN_MB 300

Var lobsterCurrentProcessPid
Var lobsterInstallerAttemptId
Var lobsterTargetProcessesStopStatus
Var lobsterResolveToolKind
Var lobsterResolvedToolPath
Var lobsterResolvedToolStatus
Var lobsterResolvedToolSource
Var lobsterTrustedPowerShellPath
Var lobsterTrustedPowerShellStatus
Var lobsterTrustedPowerShellSource
Var lobsterHiddenExecExitCode
Var lobsterHiddenExecOutput
Var lobsterHiddenExecLaunchError

!ifndef BUILD_UNINSTALLER
  ; Cross-hook state used by the update fast path and the electron-builder
  ; template timing hooks. These are installer variables (not registers) so
  ; nested NSIS macros cannot accidentally overwrite an in-flight timer.
  Var lobsterInstallScenario
  Var lobsterInvocationSource
  Var lobsterUpdatedFlag
  Var lobsterUiMode
  Var lobsterSilentSource
  Var lobsterLauncherFallback
  Var lobsterLegacySkillsStatus
  Var lobsterLegacySkillsRestoreStatus
  Var lobsterOldAppRelaunchStatus
  Var lobsterOldAppRelaunchError
  Var lobsterOldAppExecutablePath
  Var lobsterOldUninstallerPath
  Var lobsterOldAppAsarPath
  Var lobsterTrustedTarPath
  Var lobsterTrustedTarStatus
  Var lobsterTrustedTarSource
  Var lobsterOldInstallOriginalPath
  Var lobsterOldInstallOriginalPathNormalized
  Var lobsterOldInstallRegisteredPath
  Var lobsterOldInstallRegisteredPathNormalized
  Var lobsterOldInstallAlternateRegisteredPath
  Var lobsterOldInstallAlternateRegisteredPathNormalized
  Var lobsterOldInstallBackupPath
  Var lobsterOldInstallFailedPath
  Var lobsterOldInstallRenameStatus
  Var lobsterOldInstallRenameReason
  Var lobsterOldInstallRenameError
  Var lobsterOldInstallRenameAttempts
  Var lobsterOldInstallRollbackReason
  Var lobsterOldInstallRollbackStatus
  Var lobsterOldInstallRollbackError
  Var lobsterOldInstallCurrentDirectory
  Var lobsterOldUninstallCandidatePath
  Var lobsterOldUninstallCandidatePathNormalized
  Var lobsterOldUninstallStartTick
  Var lobsterOldUninstallLaunchStatus
  Var lobsterNewInstallValidationStatus
  Var lobsterNewInstallValidationReason
  !ifndef APP_PACKAGE_URL
    Var lobsterPackageMaterializeStartTick
  !else
    Var lobsterWebDownloadStartTick
    Var lobsterWebAcquireStartTick
    Var lobsterWebVerifyStartTick
  !endif
  Var lobsterPackageExtractStartTick
  Var lobsterPackageCopyStartTick
  Var lobsterInstallerCacheCopyStartTick
  !ifndef ESTIMATED_SIZE
    Var lobsterEstimatedSizeScanStartTick
    Var lobsterEstimatedSizeValue
  !endif
!endif

; -- Legacy Skills backup helper exit-code protocol --
; The PowerShell backup helper reports its outcome ONLY through these process
; exit codes. stdout is diagnostic text for the logs and must never drive
; control flow: LobsterExecHiddenToStack returns output with the helper's
; trailing CRLF attached, so an exact stdout comparison silently fails (this once
; misclassified "no user skills" as "backup succeeded" and produced a spurious
; legacy-restore-backup-missing degraded install).
!define LOBSTER_SKILL_BACKUP_EXIT_VERIFIED "0"
!define LOBSTER_SKILL_BACKUP_EXIT_INSPECT_FAILED "10"
!define LOBSTER_SKILL_BACKUP_EXIT_COPY_FAILED "11"
!define LOBSTER_SKILL_BACKUP_EXIT_VERIFY_FAILED "12"
!define LOBSTER_SKILL_BACKUP_EXIT_NO_USER_SKILLS "13"

; -- Design invariant --
; Nothing destructive may run before the user confirms the wizard (or the
; uninstall prompt). electron-builder inserts customInit in .onInit, which
; runs when the installer is merely opened -- cancelling at the welcome or
; directory page must leave the existing installation and running app
; untouched. All destructive work (stopping processes, backing up skills,
; renaming the old install dir) therefore lives in customCheckAppRunning,
; which electron-builder inserts inside the install section -- right after
; the user clicks Install and, critically, *before* uninstallOldVersion.

; Timestamp from NSIS built-ins (FileFunc ${GetTime}). The previous
; implementation spawned a PowerShell process per call just to format a
; timestamp -- with 20+ call sites that added tens of seconds per install on
; machines where security software inspects every process launch. Second
; precision is enough: phase durations are carried separately as elapsed_ms.
;
; Preserves every register (unlike the old version, which clobbered $0; the
; "copy exit codes to $R2 first" convention at call sites is kept anyway).
; OUTVAR must not be $0-$6.
!macro GetTimestamp OUTVAR
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  !ifdef BUILD_UNINSTALLER
    ${un.GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  !else
    ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  !endif
  ; $0=day $1=month $2=year $3=day-of-week name $4=hour $5=minute $6=second
  IntFmt $0 "%02d" $0
  IntFmt $1 "%02d" $1
  IntFmt $4 "%02d" $4
  IntFmt $5 "%02d" $5
  IntFmt $6 "%02d" $6
  StrCpy $0 "$2-$1-$0 $4:$5:$6"
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
  Pop ${OUTVAR}
!macroend

; attemptId is a correlation identifier only. It is intentionally generated by
; Windows and is never used as a security nonce or authorization token.
!ifdef BUILD_UNINSTALLER
Function un.lobsterEnsureInstallerAttemptId
!else
Function lobsterEnsureInstallerAttemptId
!endif
  StrCmp $lobsterInstallerAttemptId "" 0 LobsterAttemptIdReady
  System::Call 'ole32::CoCreateGuid(g .s)'
  Pop $lobsterInstallerAttemptId
  LobsterAttemptIdReady:
FunctionEnd

!macro EnsureInstallerAttemptId
  !ifdef BUILD_UNINSTALLER
    Call un.lobsterEnsureInstallerAttemptId
  !else
    Call lobsterEnsureInstallerAttemptId
  !endif
!macroend

; Resolve only Windows-owned system tools, never PATH entries. Both
; PowerShell and tar use this single resolver entry so the existence check and
; the eventual execution refer to the exact same absolute path.
!ifdef BUILD_UNINSTALLER
Function un.lobsterResolveTrustedSystemTool
!else
Function lobsterResolveTrustedSystemTool
!endif
  Push $0
  Push $1

  StrCpy $lobsterResolvedToolPath ""
  StrCpy $lobsterResolvedToolStatus "helper-not-found"
  StrCpy $lobsterResolvedToolSource "none"

  StrCmp $lobsterResolveToolKind "powershell" LobsterResolvePowerShell
  StrCmp $lobsterResolveToolKind "tar" LobsterResolveTar
  StrCpy $lobsterResolvedToolStatus "unsupported-tool"
  Goto LobsterResolveToolDone

  LobsterResolvePowerShell:
    System::Call 'kernel32::GetFileAttributesW(w "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe") i .r0'
    IntCmp $0 -1 LobsterResolvePowerShellSystem32 0 0
    IntOp $1 $0 & 0x410
    IntCmp $1 0 LobsterResolvePowerShellSysnativeReady LobsterResolvePowerShellSystem32 LobsterResolvePowerShellSystem32
    LobsterResolvePowerShellSysnativeReady:
      StrCpy $lobsterResolvedToolPath "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
      StrCpy $lobsterResolvedToolStatus "resolved"
      StrCpy $lobsterResolvedToolSource "sysnative"
      Goto LobsterResolveToolDone

    LobsterResolvePowerShellSystem32:
    System::Call 'kernel32::GetFileAttributesW(w "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe") i .r0'
    IntCmp $0 -1 LobsterResolveToolDone 0 0
    IntOp $1 $0 & 0x410
    IntCmp $1 0 LobsterResolvePowerShellSystem32Ready LobsterResolveToolDone LobsterResolveToolDone
    LobsterResolvePowerShellSystem32Ready:
      StrCpy $lobsterResolvedToolPath "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
      StrCpy $lobsterResolvedToolStatus "resolved"
      StrCpy $lobsterResolvedToolSource "system32"
      Goto LobsterResolveToolDone

  LobsterResolveTar:
    System::Call 'kernel32::GetFileAttributesW(w "$WINDIR\Sysnative\tar.exe") i .r0'
    IntCmp $0 -1 LobsterResolveTarSystem32 0 0
    IntOp $1 $0 & 0x410
    IntCmp $1 0 LobsterResolveTarSysnativeReady LobsterResolveTarSystem32 LobsterResolveTarSystem32
    LobsterResolveTarSysnativeReady:
      StrCpy $lobsterResolvedToolPath "$WINDIR\Sysnative\tar.exe"
      StrCpy $lobsterResolvedToolStatus "resolved"
      StrCpy $lobsterResolvedToolSource "sysnative"
      Goto LobsterResolveToolDone

    LobsterResolveTarSystem32:
    System::Call 'kernel32::GetFileAttributesW(w "$WINDIR\System32\tar.exe") i .r0'
    IntCmp $0 -1 LobsterResolveToolDone 0 0
    IntOp $1 $0 & 0x410
    IntCmp $1 0 LobsterResolveTarSystem32Ready LobsterResolveToolDone LobsterResolveToolDone
    LobsterResolveTarSystem32Ready:
      StrCpy $lobsterResolvedToolPath "$WINDIR\System32\tar.exe"
      StrCpy $lobsterResolvedToolStatus "resolved"
      StrCpy $lobsterResolvedToolSource "system32"

  LobsterResolveToolDone:
  Pop $1
  Pop $0
FunctionEnd

!macro ResolveTrustedPowerShell
  StrCpy $lobsterResolveToolKind "powershell"
  !ifdef BUILD_UNINSTALLER
    Call un.lobsterResolveTrustedSystemTool
  !else
    Call lobsterResolveTrustedSystemTool
  !endif
  StrCpy $lobsterTrustedPowerShellPath $lobsterResolvedToolPath
  StrCpy $lobsterTrustedPowerShellStatus $lobsterResolvedToolStatus
  StrCpy $lobsterTrustedPowerShellSource $lobsterResolvedToolSource
!macroend

!macro ResolveTrustedTar
  StrCpy $lobsterResolveToolKind "tar"
  !ifdef BUILD_UNINSTALLER
    Call un.lobsterResolveTrustedSystemTool
  !else
    Call lobsterResolveTrustedSystemTool
  !endif
  StrCpy $lobsterTrustedTarPath $lobsterResolvedToolPath
  StrCpy $lobsterTrustedTarStatus $lobsterResolvedToolStatus
  StrCpy $lobsterTrustedTarSource $lobsterResolvedToolSource
!macroend

; -- Hidden helper-process launcher --
; Every external helper (PowerShell, tar) is started through this one
; function. nsExec creates its child with CREATE_NEW_CONSOLE + SW_HIDE and
; NSIS Exec with a plain console: on Windows 11 with Windows Terminal as the
; default terminal the "hidden" console can still flash a terminal window,
; and the plain console always shows one until PowerShell hides it itself
; (field feedback 2026-09-02, dictbind bundle: users watched PowerShell pop
; up and vanish during the install and took the installer for malware).
; CREATE_NO_WINDOW (0x08000000) creates the child without any console window,
; so neither conhost nor Windows Terminal ever has something to show.
;
; In: stack = command line (below), mode (top): "wait" or "detach".
; Out: $lobsterHiddenExecExitCode = numeric exit code, or "error" when the
;      process could not be created (Win32 error in
;      $lobsterHiddenExecLaunchError); $lobsterHiddenExecOutput = combined
;      stdout+stderr text in wait mode (bounded, trailing CRLF preserved
;      exactly as nsExec::ExecToStack delivered it), or a launch-failed note.
;      "detach" returns right after creation, inherits no handles and reports
;      "0"/"error" only. The error flag is cleared on return; the Detached
;      macro re-raises it for launch failures (Exec contract).
; Every register is preserved; results travel through the variables so the
; macros below can reproduce the exact nsExec stack contracts.
!ifdef BUILD_UNINSTALLER
Function un.lobsterExecHiddenProcess
!else
Function lobsterExecHiddenProcess
!endif
  Exch $1
  Exch
  Exch $0
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9

  StrCpy $lobsterHiddenExecExitCode "error"
  StrCpy $lobsterHiddenExecOutput ""
  StrCpy $lobsterHiddenExecLaunchError "0"
  StrCpy $2 0
  StrCpy $3 0
  StrCpy $9 ""
  StrCmp $1 "wait" 0 LobsterHiddenExecStartupInfo

  ; Capture file for stdout+stderr; stdin comes from NUL so a helper that
  ; unexpectedly prompts fails instead of blocking on a console that does
  ; not exist. Both handles are inheritable.
  InitPluginsDir
  System::Call 'kernel32::GetTickCount() i .r4'
  StrCpy $9 "$PLUGINSDIR\lobster-helper-$4.out"
  System::Call '*(i 12, p 0, i 1) p .r5'
  System::Call 'kernel32::CreateFileW(w "NUL", i 0x80000000, i 3, p r5, i 3, i 0, p 0) p .r2'
  System::Call 'kernel32::CreateFileW(w r9, i 0x40000000, i 3, p r5, i 2, i 0x80, p 0) p .r3'
  System::Free $5
  IntCmp $2 -1 LobsterHiddenExecCaptureUnavailable
  IntCmp $3 -1 LobsterHiddenExecCaptureUnavailable
  Goto LobsterHiddenExecStartupInfo

  LobsterHiddenExecCaptureUnavailable:
  ; Run without redirection rather than failing the operation: output is
  ; diagnostics only, the exit code stays authoritative.
  IntCmp $2 -1 +2
    System::Call 'kernel32::CloseHandle(p r2)'
  IntCmp $3 -1 +2
    System::Call 'kernel32::CloseHandle(p r3)'
  StrCpy $2 0
  StrCpy $3 0
  Delete $9
  StrCpy $9 ""

  LobsterHiddenExecStartupInfo:
  ; STARTF_USESHOWWINDOW (1) with wShowWindow = SW_HIDE (0), plus
  ; STARTF_USESTDHANDLES (0x100; 257 in total) when capturing.
  StrCpy $6 1
  StrCpy $5 0
  StrCmp $9 "" +3
    StrCpy $6 257
    StrCpy $5 1
  ; STARTUPINFOW, 32-bit layout (68 bytes): cb, lpReserved, lpDesktop,
  ; lpTitle, dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars,
  ; dwFillAttribute, dwFlags, wShowWindow+cbReserved2 (one zero DWORD),
  ; lpReserved2, hStdInput, hStdOutput, hStdError.
  System::Call '*(i 68, p 0, p 0, p 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i r6, i 0, p 0, p r2, p r3, p r3) p .r7'
  ; PROCESS_INFORMATION (16 bytes): hProcess, hThread, dwProcessId, dwThreadId.
  System::Call '*(p 0, p 0, i 0, i 0) p .r8'
  ; CreateProcessW(NULL, cmd, NULL, NULL, bInheritHandles, CREATE_NO_WINDOW,
  ; inherit environment, inherit current directory, &si, &pi)
  System::Call 'kernel32::CreateProcessW(p 0, w r0, p 0, p 0, i r5, i 0x08000000, p 0, p 0, p r7, p r8) i .r4 ?e'
  Pop $lobsterHiddenExecLaunchError
  IntCmp $4 0 LobsterHiddenExecCreateFailed
  System::Call '*$8(p .r4, p .r5, i, i)'
  System::Call 'kernel32::CloseHandle(p r5)'
  StrCmp $1 "wait" 0 LobsterHiddenExecDetachedStarted
  System::Call 'kernel32::WaitForSingleObject(p r4, i -1)'
  System::Call 'kernel32::GetExitCodeProcess(p r4, *i .r5) i .r6'
  System::Call 'kernel32::CloseHandle(p r4)'
  IntCmp $6 0 LobsterHiddenExecCollect
  StrCpy $lobsterHiddenExecExitCode $5
  Goto LobsterHiddenExecCollect

  LobsterHiddenExecDetachedStarted:
  System::Call 'kernel32::CloseHandle(p r4)'
  StrCpy $lobsterHiddenExecExitCode "0"
  Goto LobsterHiddenExecCollect

  LobsterHiddenExecCreateFailed:
  StrCpy $lobsterHiddenExecOutput "launch-failed win32_error=$lobsterHiddenExecLaunchError"

  LobsterHiddenExecCollect:
  System::Free $7
  System::Free $8
  IntCmp $2 0 +2
    System::Call 'kernel32::CloseHandle(p r2)'
  IntCmp $3 0 +2
    System::Call 'kernel32::CloseHandle(p r3)'
  StrCmp $9 "" LobsterHiddenExecDone
  StrCmp $lobsterHiddenExecExitCode "error" LobsterHiddenExecDeleteCapture
  ClearErrors
  FileOpen $4 $9 r
  IfErrors LobsterHiddenExecDeleteCapture
  LobsterHiddenExecReadLoop:
    ClearErrors
    FileRead $4 $5
    IfErrors LobsterHiddenExecReadDone
    StrLen $6 $lobsterHiddenExecOutput
    IntCmp $6 4096 LobsterHiddenExecReadDone 0 LobsterHiddenExecReadDone
    StrCpy $lobsterHiddenExecOutput "$lobsterHiddenExecOutput$5"
    Goto LobsterHiddenExecReadLoop
  LobsterHiddenExecReadDone:
  FileClose $4
  LobsterHiddenExecDeleteCapture:
  Delete $9

  LobsterHiddenExecDone:
  ClearErrors
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $0
  Pop $1
FunctionEnd

!macro LobsterExecHidden MODE
  Push "${MODE}"
  !ifdef BUILD_UNINSTALLER
    Call un.lobsterExecHiddenProcess
  !else
    Call lobsterExecHiddenProcess
  !endif
!macroend

; nsExec::ExecToStack replacement. The caller pushes the command line first;
; afterwards the stack holds the exit code on top and the output below it.
!macro LobsterExecHiddenToStack
  !insertmacro LobsterExecHidden "wait"
  Push $lobsterHiddenExecOutput
  Push $lobsterHiddenExecExitCode
!macroend

; nsExec::ExecToLog replacement: exit code only (the details pane this
; installer never shows was the only consumer of the output).
!macro LobsterExecHiddenExitCode
  !insertmacro LobsterExecHidden "wait"
  Push $lobsterHiddenExecExitCode
!macroend

; Exec replacement: fire and forget; the error flag is set when the process
; could not be created.
!macro LobsterExecHiddenDetached
  !insertmacro LobsterExecHidden "detach"
  StrCmp $lobsterHiddenExecExitCode "error" 0 +2
    SetErrors
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; The custom include can be parsed before electron-builder's asynchronous
    ; !addplugindir output. Define the relaunch function here, after the
    ; generated shared header has registered StdUtils.
    !insertmacro DefineLobsterOldAppRelaunchFunction
    ; The staging functions reference $appPackageStagingDir, declared at the
    ; top of the patched installer.nsi -- also only available by now.
    !insertmacro DefineLobsterPayloadStagingFunctions
  !endif

  ; Request admin privileges for script execution (tar extract, etc.)
  ; This does NOT change the default install path -- just ensures UAC elevation.
  RequestExecutionLevel admin

  ; Declare the installer (and the uninstaller stub it writes) DPI-aware.
  ; electron-builder's template leaves the NSIS manifest without a dpiAware
  ; element, so on 125%-200% displays Windows renders the whole wizard at
  ; 96 DPI and bitmap-scales it up: the title-bar icon, the header icon and
  ; every label come out blurry. With the declaration the dialog is laid out
  ; at the native DPI and the icons are loaded at their true size from
  ; build/icons/win/icon.ico (16/24/32/48/64/128/256). MUI2 stretches the
  ; welcome/finish sidebar bitmap to the scaled control, so layout is kept.
  ManifestDPIAware true

  ; NSIS ships its CJK language files with the dialog font pinned to the
  ; Windows XP-era UI fonts: SimpChinese.nlf = SimSun 9pt, TradChinese.nlf =
  ; PMingLiU 9pt, Japanese.nlf = MS PGothic 9pt, Korean.nlf = Gulim 9pt. Those
  ; fonts carry embedded bitmap strikes for 12-16 px, which GDI draws as-is
  ; with no anti-aliasing, so at 9pt every label, button, the branding text
  ; and the bold MUI header (CreateFont from $(^Font)) come out jagged --
  ; and with the installer DPI-aware the pixels are no longer even blurred
  ; away by bitmap scaling. English and the other Latin languages keep the
  ; language-file default ("-" = MS Shell Dlg), an outline font that is
  ; unaffected. Override each CJK language with the font Windows 10+ itself
  ; uses for that locale's UI. SetFont /LANG replaces the language file's
  ; font for the per-language dialog templates and for $(^Font)/$(^FontSize),
  ; and LANG_* is only defined once addLangs has run, which is why this lives
  ; in customHeader (inserted after addLangs). Guarded so a narrowed
  ; installerLanguages list still compiles.
  !ifdef LANG_SIMPCHINESE
    SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9
  !endif
  !ifdef LANG_TRADCHINESE
    SetFont /LANG=${LANG_TRADCHINESE} "Microsoft JhengHei UI" 9
  !endif
  !ifdef LANG_JAPANESE
    SetFont /LANG=${LANG_JAPANESE} "Yu Gothic UI" 9
  !endif
  !ifdef LANG_KOREAN
    SetFont /LANG=${LANG_KOREAN} "Malgun Gothic" 9
  !endif

  ; Keep only the progress bar visible. The details box stays hidden and
  ; NSIS/electron-builder retains the default status text behavior.
  ShowInstDetails nevershow
!macroend

; -- Stop every process that might hold file handles in the install dir --
;
; 1. LobsterAI.exe -- the main app AND the OpenClaw gateway (ELECTRON_RUN_AS_NODE)
; 2. node.exe whose binary lives inside the LobsterAI install tree
;    (Web Search bridge server, MCP servers spawned with detached:true)
; 3. any other process whose executable lives under the install root --
;    python-win skill/MCP servers, bundled git/ssh helpers -- matched by
;    path prefix (field failure 2026-09-01: a survivor under the tree made
;    the old-install replacement fail on a held handle). The invoking
;    installer/uninstaller pid is excluded because the stock fallback can
;    run the old uninstaller in place from $INSTDIR, and a drive-root
;    install (root length <= 3) skips the sweep entirely.
;
; Stop-Process -Force is equivalent to taskkill /F -- the processes have no
; chance to run before-quit cleanup. The kill is re-issued on every poll
; round instead of once up front: a single kill loses against a long-running
; instance whose kernel teardown outlives a fixed observation window (field
; report 2026-07-29: a loaded old app survived the previous
; kill-once-then-poll 7.5s gate, while a freshly started instance died in one
; round) and against anything respawned between the kill and a later poll.
; 30 rounds x 500ms keeps the worst-case gate under ~20s wall time; the
; healthy path still converges on the first or second round.
;
; Shared between the installer and the uninstaller via customCheckAppRunning.
!macro stopLobsterAIProcesses
  DetailPrint "[Installer] Stopping running LobsterAI processes"
  StrCpy $lobsterTargetProcessesStopStatus "helper-not-found"
  System::Call 'kernel32::GetCurrentProcessId()i .r4'
  StrCpy $lobsterCurrentProcessPid $4
  System::Call 'kernel32::GetTickCount()i .r7'
  ; The survivor helper below and every log write in this macro need the
  ; directory, including on the helper-not-found path.
  CreateDirectory "$APPDATA\LobsterAI"
  StrCmp $lobsterTrustedPowerShellPath "" StopLobsterAIProcessesDone
  ; The path-prefix sweep in both helpers below needs the install root and
  ; this process id. Both travel through the child environment, not string
  ; interpolation: the install directory is user-selected and may hold shell
  ; metacharacters. Cleared at StopLobsterAIProcessesLog, which every path
  ; reaches.
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_STOP_ROOT", t "$INSTDIR")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_STOP_SELF_PID", t "$lobsterCurrentProcessPid")i'
  Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "\
    $$root = $$env:LOBSTERAI_STOP_ROOT;\
    if ($$root -and -not $$root.EndsWith([char]92)) { $$root = $$root + [char]92 };\
    $$selfPid = $$env:LOBSTERAI_STOP_SELF_PID;\
    $$sweep = $$root -and $$root.Length -gt 3;\
    for ($$i = 0; $$i -lt 30; $$i++) {\
      $$procs = @();\
      $$procs += Get-Process -Name LobsterAI -ErrorAction SilentlyContinue;\
      $$procs += Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*LobsterAI*\" };\
      if ($$sweep) { $$procs += Get-Process -ErrorAction SilentlyContinue | Where-Object { $$fp = $$null; try { $$fp = $$_.Path } catch { }; $$fp -and $$fp.StartsWith($$root, [System.StringComparison]::OrdinalIgnoreCase) -and $$_.Id.ToString() -ne $$selfPid } };\
      if ($$procs.Count -eq 0) { exit 0 };\
      $$procs | Stop-Process -Force -ErrorAction SilentlyContinue;\
      Start-Sleep -Milliseconds 500;\
    };\
    exit 3"'
  !insertmacro LobsterExecHiddenExitCode
  Pop $0
  StrCpy $R2 $0
  StrCpy $lobsterTargetProcessesStopStatus "numeric-exit-code"
  StrCmp $R2 "error" 0 +2
    StrCpy $lobsterTargetProcessesStopStatus "process-start-blocked"
  StrCmp $R2 "0" 0 +2
    StrCpy $lobsterTargetProcessesStopStatus "success"
  StrCmp $R2 "3" 0 StopLobsterAIProcessesLog
  ; The exit-3 verdict alone never says WHICH process refused to die. Re-snapshot
  ; and append one process-stop-survivor line per remaining process before the
  ; completion line below. Inputs travel through the child environment, not
  ; string interpolation: the log path contains the user profile directory,
  ; which may hold shell metacharacters. Helper exit code = survivor count at
  ; re-check time; 0 means the blockers died right after the verdict.
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_STOP_LOG_PATH", t "$APPDATA\LobsterAI\install-timing.log")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_STOP_ATTEMPT_ID", t "$lobsterInstallerAttemptId")i'
  Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "\
    $$ts = Get-Date -Format \"yyyy-MM-dd HH:mm:ss\";\
    $$root = $$env:LOBSTERAI_STOP_ROOT;\
    if ($$root -and -not $$root.EndsWith([char]92)) { $$root = $$root + [char]92 };\
    $$selfPid = $$env:LOBSTERAI_STOP_SELF_PID;\
    $$sweep = $$root -and $$root.Length -gt 3;\
    $$procs = @();\
    $$procs += Get-Process -Name LobsterAI -ErrorAction SilentlyContinue;\
    $$procs += Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*LobsterAI*\" };\
    if ($$sweep) { $$procs += Get-Process -ErrorAction SilentlyContinue | Where-Object { $$fp = $$null; try { $$fp = $$_.Path } catch { }; $$fp -and $$fp.StartsWith($$root, [System.StringComparison]::OrdinalIgnoreCase) -and $$_.Id.ToString() -ne $$selfPid } };\
    foreach ($$p in $$procs) {\
      $$fp = \"unknown\";\
      try { if ($$p.Path) { $$fp = $$p.Path } } catch { };\
      Add-Content -LiteralPath $$env:LOBSTERAI_STOP_LOG_PATH -Value \"$$ts phase=process-stop-survivor attempt_id=$$env:LOBSTERAI_STOP_ATTEMPT_ID name=$$($$p.ProcessName) pid=$$($$p.Id) path=$$fp\" -ErrorAction SilentlyContinue;\
    };\
    exit $$procs.Count"'
  !insertmacro LobsterExecHiddenExitCode
  Pop $1
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_STOP_LOG_PATH", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_STOP_ATTEMPT_ID", t "")i'
  FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $9 0 END
  !insertmacro GetTimestamp $8
  !ifdef BUILD_UNINSTALLER
    FileWrite $9 "$8 phase=process-stop-survivors-logged attempt_id=$lobsterInstallerAttemptId role=uninstaller helper_exit=$1$\r$\n"
  !else
    FileWrite $9 "$8 phase=process-stop-survivors-logged attempt_id=$lobsterInstallerAttemptId role=installer helper_exit=$1$\r$\n"
  !endif
  FileClose $9
  Goto StopLobsterAIProcessesLog

  StopLobsterAIProcessesDone:
  StrCpy $R2 "helper-not-found"

  StopLobsterAIProcessesLog:
  ; Clearing variables that were never set (helper-not-found path) is a no-op.
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_STOP_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_STOP_SELF_PID", t "")i'
  System::Call 'kernel32::GetTickCount()i .r6'
  IntOp $5 $6 - $7
  FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $9 0 END
  !insertmacro GetTimestamp $8
  !ifdef BUILD_UNINSTALLER
    FileWrite $9 "$8 phase=process-stop-complete attempt_id=$lobsterInstallerAttemptId role=uninstaller pid=$lobsterCurrentProcessPid status=$lobsterTargetProcessesStopStatus exit=$R2 elapsed_ms=$5$\r$\n"
  !else
    FileWrite $9 "$8 phase=process-stop-complete attempt_id=$lobsterInstallerAttemptId role=installer pid=$lobsterCurrentProcessPid status=$lobsterTargetProcessesStopStatus exit=$R2 elapsed_ms=$5$\r$\n"
  !endif
  FileClose $9
!macroend

!macro customInit
  ; Diagnostics only -- .onInit runs before the user has confirmed anything,
  ; so this macro must stay non-destructive.
  !insertmacro EnsureInstallerAttemptId
  StrCpy $lobsterInvocationSource "unknown"
  StrCpy $lobsterUpdatedFlag "absent"
  StrCpy $lobsterUiMode "interactive"
  StrCpy $lobsterSilentSource "none"
  StrCpy $lobsterLauncherFallback "unknown"
  ${If} ${isUpdated}
    StrCpy $lobsterUpdatedFlag "present"
  ${EndIf}
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    StrCpy $lobsterInvocationSource "app-update"
    StrCpy $lobsterLauncherFallback "none"
  ${EndIf}
  ${If} ${Silent}
    StrCpy $lobsterSilentSource "argv"
  ${EndIf}
  !if "$%LOBSTERAI_CHANNEL_BUILD%" == "1"
  !if "$%LOBSTERAI_SILENT_ON_DOUBLE_CLICK%" == "1"
    ${If} ${Silent}
    ${Else}
      ${If} ${isUpdated}
      ${Else}
        StrCpy $lobsterSilentSource "build-flag"
        SetSilent silent
      ${EndIf}
    ${EndIf}
  !endif
  !endif
  ${If} ${Silent}
    StrCpy $lobsterUiMode "silent"
  ${EndIf}
  CreateDirectory "$APPDATA\LobsterAI"
  FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $9 0 END
  !insertmacro GetTimestamp $8
  FileWrite $9 "$8 phase=custom-init-start attempt_id=$lobsterInstallerAttemptId installer_version=${VERSION} invocation_source=$lobsterInvocationSource updated_flag=$lobsterUpdatedFlag ui_mode=$lobsterUiMode silent_source=$lobsterSilentSource launcher_fallback=$lobsterLauncherFallback instdir=$INSTDIR appdata=$APPDATA$\r$\n"
  FileClose $9
!macroend

!ifndef BUILD_UNINSTALLER
  ; P0 preflight deliberately has only two outcomes. Any registration or
  ; non-empty target evidence remains on the existing compatibility path; the
  ; richer repair/relocate/reconcile action planner belongs to P0.5.
  !macro DetectFreshOrPossibleExisting
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6

    StrCpy $lobsterInstallScenario "possible-existing"
    ReadRegStr $0 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKEY_LOCAL_MACHINE "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $2 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $3 HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY}" UninstallString

    StrCmp $0 "" 0 LobsterInstallPreflightDone
    StrCmp $1 "" 0 LobsterInstallPreflightDone
    StrCmp $2 "" 0 LobsterInstallPreflightDone
    StrCmp $3 "" 0 LobsterInstallPreflightDone

    ; .onInit already called SetOutPath, which creates an empty $INSTDIR.
    ; Enumerate its contents instead of using IfFileExists with a wildcard:
    ; wildcard directory-existence checks misclassify that empty directory as
    ; an old install. Only a real child entry is existing evidence.
    ;
    ; The enumeration runs through the System plug-in so the Win32 error that
    ; ends it is captured in the same call (?e). The previous NSIS FindNext
    ; followed by a separate GetLastError read a stale value (plug-in loading
    ; sits in between), never saw ERROR_NO_MORE_FILES and therefore never
    ; classified any install as fresh (field logs: 46 of 46 preflights
    ; possible-existing, fresh machines included).
    ; WIN32_FIND_DATAW: dwFileAttributes, 3x FILETIME, nFileSizeHigh/Low,
    ; dwReserved0/1, cFileName[260], cAlternateFileName[14].
    System::Call '*(i, l, l, l, i, i, i, i, &w260, &w14) p .r6'
    System::Call 'kernel32::FindFirstFileW(w "$INSTDIR\*", p r6) p .r4 ?e'
    Pop $5
    IntCmp $4 -1 LobsterInstallPreflightFindFirstFailed
    LobsterInstallPreflightEntryLoop:
      System::Call '*$6(i, l, l, l, i, i, i, i, &w260 .r5, &w14)'
      StrCmp $5 "." LobsterInstallPreflightNextEntry
      StrCmp $5 ".." LobsterInstallPreflightNextEntry
      System::Call 'kernel32::FindClose(p r4)'
      Goto LobsterInstallPreflightDone
    LobsterInstallPreflightNextEntry:
      System::Call 'kernel32::FindNextFileW(p r4, p r6) i .r0 ?e'
      Pop $5
      IntCmp $0 0 LobsterInstallPreflightFindNextFailed
      Goto LobsterInstallPreflightEntryLoop

    LobsterInstallPreflightFindNextFailed:
      System::Call 'kernel32::FindClose(p r4)'
      IntCmp $5 18 LobsterInstallPreflightFresh
      Goto LobsterInstallPreflightDone

    LobsterInstallPreflightFindFirstFailed:
      ; ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND: the directory does not
      ; exist at all; ERROR_NO_MORE_FILES: it exists and is empty.
      IntCmp $5 2 LobsterInstallPreflightFresh
      IntCmp $5 3 LobsterInstallPreflightFresh
      IntCmp $5 18 LobsterInstallPreflightFresh
      Goto LobsterInstallPreflightDone

    LobsterInstallPreflightFresh:
    StrCpy $lobsterInstallScenario "fresh-install"

    LobsterInstallPreflightDone:
    System::Free $6
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  !macroend

  ; Free megabytes available to the caller on the volume holding a path.
  ; In: stack top = existing directory (or drive root) to query.
  ; Out: stack top = free MB as a decimal integer string, or "-1" when the
  ; query failed. 64-bit math via System::Int64Op -- byte counts here
  ; overflow NSIS' 32-bit signed integers.
  Function lobsterQueryFreeMegabytes
    Exch $0
    Push $1
    Push $2
    System::Call 'kernel32::GetDiskFreeSpaceExW(w r0, *l .r1, p 0, p 0) i .r2'
    IntCmp $2 0 LobsterQueryFreeMegabytesFailed
    System::Int64Op $1 / 1048576
    Pop $0
    Goto LobsterQueryFreeMegabytesDone
    LobsterQueryFreeMegabytesFailed:
      StrCpy $0 "-1"
    LobsterQueryFreeMegabytesDone:
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd

  ; Exact on-disk byte size of a file as a decimal string (64-bit safe, so
  ; the result can be compared verbatim against a build-time byte count).
  ; In: stack top = file path. Out: stack top = size string, or "-1".
  Function lobsterQueryFileSizeBytes
    Exch $0
    Push $1
    Push $2
    Push $3
    ; FILE_READ_ATTRIBUTES (0x80), full sharing (7), OPEN_EXISTING (3).
    System::Call 'kernel32::CreateFileW(w r0, i 0x80, i 7, p 0, i 3, i 0, p 0) i .r1'
    IntCmp $1 -1 LobsterQueryFileSizeFailed
    System::Call 'kernel32::GetFileSizeEx(i r1, *l .r2) i .r3'
    System::Call 'kernel32::CloseHandle(i r1)'
    IntCmp $3 0 LobsterQueryFileSizeFailed
    StrCpy $0 $2
    Goto LobsterQueryFileSizeDone
    LobsterQueryFileSizeFailed:
      StrCpy $0 "-1"
    LobsterQueryFileSizeDone:
    Pop $3
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd

  ; Collapse helper output into one bounded log line: keep the LAST 512
  ; characters (tar prints its fatal reason last) and replace CR/LF/TAB with
  ; spaces so the key=value log stays one record per line.
  Function lobsterBuildSingleLineTail
    Exch $0
    Push $1
    Push $2
    Push $3
    StrLen $1 $0
    IntCmp $1 512 LobsterTailSanitize LobsterTailSanitize 0
      IntOp $1 $1 - 512
      StrCpy $0 $0 512 $1
    LobsterTailSanitize:
    StrCpy $3 ""
    StrCpy $1 0
    LobsterTailLoop:
      StrCpy $2 $0 1 $1
      StrCmp $2 "" LobsterTailDone
      StrCmp $2 "$\r" LobsterTailBlank
      StrCmp $2 "$\n" LobsterTailBlank
      StrCmp $2 "$\t" LobsterTailBlank
      StrCpy $3 "$3$2"
      Goto LobsterTailNext
      LobsterTailBlank:
        StrCpy $3 "$3 "
      LobsterTailNext:
      IntOp $1 $1 + 1
      Goto LobsterTailLoop
    LobsterTailDone:
    StrCpy $0 $3
    Pop $3
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd

  ; The functions below reference $appPackageStagingDir, which the patched
  ; installer.nsi declares at file scope. This custom include is parsed
  ; before installer.nsi, so like the relaunch function they are emitted
  ; from customHeader, after that declaration exists.
  !macro DefineLobsterPayloadStagingFunctions
  ; -- Payload staging drive preflight (field case 2026-08-25) --
  ; TEMP on a nearly full C: let Nsis7z::Extract silently truncate the
  ; staged tree while the user installed to a roomy E:. Before the embedded
  ; package is materialized, verify the staging drive can hold the package
  ; plus the fully extracted tree; when it cannot and the install drive can
  ; also absorb the final install, stage inside $INSTDIR instead. Only when
  ; no drive has room does the install stop -- before anything destructive
  ; beyond the (rolled back) old-install rename has happened.
  Function lobsterSelectPayloadStagingDir
    !ifdef LOBSTER_PAYLOAD_UNPACKED_MB
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $8
    Push $9

    ; Staging need = materialized package (about this installer's own file
    ; size) + extracted 7z-out tree + margin, in MB.
    Push "$EXEPATH"
    Call lobsterQueryFileSizeBytes
    Pop $0
    StrCmp $0 "-1" 0 +2
      StrCpy $0 "0"
    System::Int64Op $0 / 1048576
    Pop $0
    IntOp $1 $0 + ${LOBSTER_PAYLOAD_UNPACKED_MB}
    IntOp $1 $1 + ${LOBSTER_STAGING_MARGIN_MB}

    StrCpy $4 $PLUGINSDIR 3
    Push "$PLUGINSDIR"
    Call lobsterQueryFreeMegabytes
    Pop $2
    StrCmp $2 "-1" LobsterStagingQueryFailed
    IntCmp $2 $1 LobsterStagingDefaultOk LobsterStagingDefaultInsufficient LobsterStagingDefaultOk

    LobsterStagingDefaultInsufficient:
    ; The temp drive cannot hold the staged payload. Relocating helps only
    ; when the install directory lives on a different volume with room for
    ; staging plus the final install (tree + tar extraction) at once.
    StrCpy $3 $INSTDIR 3
    IntOp $6 $1 + ${LOBSTER_PAYLOAD_UNPACKED_MB}
    IntOp $6 $6 + ${LOBSTER_WIN_RESOURCES_TAR_MB}
    StrCpy $5 $2
    StrCmp $3 $4 LobsterStagingNoRoom
    Push "$3"
    Call lobsterQueryFreeMegabytes
    Pop $5
    StrCmp $5 "-1" LobsterStagingQueryFailed
    IntCmp $5 $6 LobsterStagingRelocate LobsterStagingNoRoom LobsterStagingRelocate

    LobsterStagingRelocate:
    CreateDirectory "$INSTDIR"
    CreateDirectory "$INSTDIR\.lobsterai-staging"
    IfFileExists "$INSTDIR\.lobsterai-staging" 0 LobsterStagingRelocateCreateFailed
    StrCpy $appPackageStagingDir "$INSTDIR\.lobsterai-staging"
    DetailPrint "[Installer] Staging installation payload on the install drive"
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=staging-drive-selected attempt_id=$lobsterInstallerAttemptId drive=$3 mode=install-dir free_mb=$5 needed_mb=$6 plugins_drive=$4 plugins_free_mb=$2 plugins_needed_mb=$1 staging=$appPackageStagingDir$\r$\n"
    FileClose $9
    Goto LobsterStagingSelected

    LobsterStagingRelocateCreateFailed:
    ; Could not create the relocated staging directory. Keep the default so
    ; behavior matches previous installers; payload validation still stops a
    ; truncated staging tree afterwards.
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=staging-drive-selected attempt_id=$lobsterInstallerAttemptId drive=$4 mode=plugins-dir result=relocate-create-failed free_mb=$2 needed_mb=$1$\r$\n"
    FileClose $9
    Goto LobsterStagingSelected

    LobsterStagingQueryFailed:
    ; Never turn a failed probe into an install blocker. Extraction plus the
    ; staged-payload validation remain the authority on success.
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=staging-drive-selected attempt_id=$lobsterInstallerAttemptId drive=$4 mode=plugins-dir result=query-failed free_mb=$2 needed_mb=$1$\r$\n"
    FileClose $9
    Goto LobsterStagingSelected

    LobsterStagingNoRoom:
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=staging-preflight-insufficient attempt_id=$lobsterInstallerAttemptId plugins_drive=$4 plugins_free_mb=$2 staging_needed_mb=$1 install_drive=$3 install_free_mb=$5 install_needed_mb=$6 action=abort-install$\r$\n"
    FileClose $9
    !insertmacro customBeforeInstallerQuit "staging-space-insufficient"
    MessageBox MB_OK|MB_ICONEXCLAMATION "${U+78C1}${U+76D8}${U+7A7A}${U+95F4}${U+4E0D}${U+8DB3}${U+FF0C}${U+65E0}${U+6CD5}${U+5B89}${U+88C5} LobsterAI${U+3002}${U+8BF7}${U+6E05}${U+7406}${U+78C1}${U+76D8}${U+7A7A}${U+95F4}${U+540E}${U+91CD}${U+8BD5}${U+3002}$\r$\n$\r$\nThere is not enough free disk space to install LobsterAI: drive $4 has $2 MB free but staging the installation needs about $1 MB, and installing to drive $3 would need about $6 MB free there. Free up disk space and run the installer again. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
    SetErrorLevel 2
    Quit

    LobsterStagingDefaultOk:
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=staging-drive-selected attempt_id=$lobsterInstallerAttemptId drive=$4 mode=plugins-dir free_mb=$2 needed_mb=$1$\r$\n"
    FileClose $9

    LobsterStagingSelected:
    Pop $9
    Pop $8
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    !endif
  FunctionEnd

  ; Remove a relocated staging directory ($INSTDIR\.lobsterai-staging). Runs
  ; on the success path once the payload copy is done, and from every
  ; controlled failure exit; a no-op while staging is the default
  ; $PLUGINSDIR (the NSIS temp dir cleans itself up on exit).
  Function lobsterCleanupRelocatedPayloadStaging
    Push $8
    Push $9
    StrCmp $appPackageStagingDir "" LobsterStagingCleanupDone
    StrCmp $appPackageStagingDir "$PLUGINSDIR" LobsterStagingCleanupDone
    RMDir /r "$appPackageStagingDir"
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=staging-relocated-cleanup attempt_id=$lobsterInstallerAttemptId staging=$appPackageStagingDir$\r$\n"
    FileClose $9
    StrCpy $appPackageStagingDir "$PLUGINSDIR"
    LobsterStagingCleanupDone:
    Pop $9
    Pop $8
  FunctionEnd
  !macroend

  ; Template hook (patched extractAppPackage.nsh) invoked in *_app_files
  ; right before the app package is materialized to $appPackageStagingDir.
  !macro customSelectAppPackageStagingDir
    Call lobsterSelectPayloadStagingDir
  !macroend

  ; -- Staged payload validation --
  ; Nsis7z::Extract pushes no result, so the extracted tree itself is the
  ; only evidence of success. A full staging drive silently truncates it
  ; (field case 2026-08-25: win-resources.tar cut at 528 MB, the install
  ; completed, and the failure surfaced later as a misleading tar error).
  ; Verify the tree before CopyFiles can commit it: the app executable and
  ; resources\win-resources.tar must exist, and the tar must byte-match the
  ; size recorded at build time.
  !macro LobsterValidateStagedPayload MODE
    Push $0
    Push $1
    Push $2
    Push $3
    Push $8
    Push $9

    ${If} "${MODE}" == "staging"
      StrCpy $0 "$appPackageStagingDir\7z-out"
    ${Else}
      ; fallback-direct extracts straight into the restored $OUTDIR
      StrCpy $0 "$OUTDIR"
    ${EndIf}
    !ifdef LOBSTER_WIN_RESOURCES_TAR_BYTES
      StrCpy $3 "${LOBSTER_WIN_RESOURCES_TAR_BYTES}"
    !else
      StrCpy $3 "unknown"
    !endif
    StrCpy $2 "-"
    StrCpy $1 "ok"

    ${IfNot} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
      StrCpy $1 "app-executable-missing"
    ${ElseIfNot} ${FileExists} "$0\resources\win-resources.tar"
      StrCpy $1 "resources-tar-missing"
    ${Else}
      Push "$0\resources\win-resources.tar"
      Call lobsterQueryFileSizeBytes
      Pop $2
      ${If} $2 == "-1"
        ; A just-extracted file that cannot be measured is logged but not
        ; fatal on its own; the tar extraction phase still verifies content.
        StrCpy $1 "size-query-failed"
      !ifdef LOBSTER_WIN_RESOURCES_TAR_BYTES
      ${ElseIf} $2 != "${LOBSTER_WIN_RESOURCES_TAR_BYTES}"
        StrCpy $1 "resources-tar-size-mismatch"
      !endif
      ${EndIf}
    ${EndIf}

    ${If} $1 == "ok"
    ${OrIf} $1 == "size-query-failed"
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=payload-staging-validated attempt_id=$lobsterInstallerAttemptId mode=${MODE} result=$1 root=$0 tar_bytes=$2 expected_bytes=$3$\r$\n"
      FileClose $9
    ${Else}
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=payload-staging-validation-failed attempt_id=$lobsterInstallerAttemptId mode=${MODE} reason=$1 root=$0 found_bytes=$2 expected_bytes=$3 action=abort-install$\r$\n"
      FileClose $9
      ; Never commit a partial app: restore the previous installation first,
      ; then report. /SD keeps silent (/S) installs from blocking on the box.
      !insertmacro customBeforeInstallerQuit "payload-staging-validation-failed"
      MessageBox MB_OK|MB_ICONEXCLAMATION "${U+5B89}${U+88C5}${U+5305}${U+6570}${U+636E}${U+4E0D}${U+5B8C}${U+6574}${U+FF1A}${U+53EF}${U+80FD}${U+662F}${U+4E34}${U+65F6}${U+76EE}${U+5F55}${U+78C1}${U+76D8}${U+7A7A}${U+95F4}${U+4E0D}${U+8DB3}${U+6216}${U+5B89}${U+88C5}${U+5305}${U+4E0B}${U+8F7D}${U+4E0D}${U+5B8C}${U+6574}${U+3002}${U+8BF7}${U+6E05}${U+7406}${U+78C1}${U+76D8}${U+7A7A}${U+95F4}${U+540E}${U+91CD}${U+8BD5}${U+FF0C}${U+6216}${U+91CD}${U+65B0}${U+4E0B}${U+8F7D}${U+5B89}${U+88C5}${U+5305}${U+3002}$\r$\n$\r$\nThe LobsterAI installation stopped because the unpacked installer data is incomplete ($1). This usually means the drive holding the temporary directory ran out of space during extraction, or the installer download was truncated. Free up disk space on the temp drive or download the installer again. No partial application was committed. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}

    Pop $9
    Pop $8
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  !macroend

  ; Relaunch is deliberately conservative. Only the normal interactive
  ; app-update invocation (--updated + --force-run), after a confirmed process
  ; stop and with an unchanged/restored regular old executable, is eligible.
  ; The restored app is launched with no --updated argument.
  !macro DefineLobsterOldAppRelaunchFunction
  Function lobsterTryRelaunchOldApp
    Push $0
    Push $1
    Push $8
    Push $9

    StrCmp $lobsterOldAppRelaunchStatus "not-attempted" 0 LobsterOldAppRelaunchDone
    StrCpy $lobsterOldAppRelaunchStatus "blocked"
    StrCpy $lobsterOldAppRelaunchError "intent-not-trusted"

    ; Read the generated command-line flags at relaunch time. This function is
    ; emitted by customHeader only after StdUtils has been registered.
    ${StdUtils.TestParameter} $0 "updated"
    StrCmp $0 "true" 0 LobsterOldAppRelaunchLog
    ${StdUtils.TestParameter} $0 "force-run"
    StrCmp $0 "true" 0 LobsterOldAppRelaunchLog
    IfSilent 0 LobsterOldAppRelaunchInteractive
      StrCpy $lobsterOldAppRelaunchError "silent-invocation"
      Goto LobsterOldAppRelaunchLog
    LobsterOldAppRelaunchInteractive:
    StrCmp $lobsterTargetProcessesStopStatus "success" 0 LobsterOldAppRelaunchProcessStateBlocked
    StrCmp $lobsterOldAppExecutablePath "" 0 +3
      StrCpy $lobsterOldAppRelaunchError "old-source-missing"
      Goto LobsterOldAppRelaunchLog

    System::Call 'kernel32::GetFileAttributesW(w "$lobsterOldAppExecutablePath") i .r0'
    IntCmp $0 -1 LobsterOldAppRelaunchFootprintBlocked 0 0
    IntOp $1 $0 & 0x410
    IntCmp $1 0 0 LobsterOldAppRelaunchFootprintBlocked LobsterOldAppRelaunchFootprintBlocked
    System::Call 'kernel32::GetFileAttributesW(w "$lobsterOldUninstallerPath") i .r0'
    IntCmp $0 -1 LobsterOldAppRelaunchFootprintBlocked 0 0
    IntOp $1 $0 & 0x410
    IntCmp $1 0 0 LobsterOldAppRelaunchFootprintBlocked LobsterOldAppRelaunchFootprintBlocked
    System::Call 'kernel32::GetFileAttributesW(w "$lobsterOldAppAsarPath") i .r0'
    IntCmp $0 -1 LobsterOldAppRelaunchFootprintBlocked 0 0
    IntOp $1 $0 & 0x410
    IntCmp $1 0 0 LobsterOldAppRelaunchFootprintBlocked LobsterOldAppRelaunchFootprintBlocked

    StrCpy $lobsterOldAppRelaunchStatus "attempted"
    StrCpy $lobsterOldAppRelaunchError "none"
    ${StdUtils.ExecShellAsUser} $0 "$lobsterOldAppExecutablePath" "open" ""
    StrCpy $lobsterOldAppRelaunchError $0
    StrCmp $0 "0" LobsterOldAppRelaunchSucceeded
      StrCpy $lobsterOldAppRelaunchStatus "old-app-relaunch-failed"
      Goto LobsterOldAppRelaunchLog
    LobsterOldAppRelaunchSucceeded:
      StrCpy $lobsterOldAppRelaunchStatus "dispatched"
    Goto LobsterOldAppRelaunchLog

    LobsterOldAppRelaunchProcessStateBlocked:
      StrCpy $lobsterOldAppRelaunchError "process-state-not-confirmed-stopped"
      Goto LobsterOldAppRelaunchLog

    LobsterOldAppRelaunchFootprintBlocked:
      StrCpy $lobsterOldAppRelaunchError "old-footprint-not-verified"

    LobsterOldAppRelaunchLog:
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=old-app-relaunch attempt_id=$lobsterInstallerAttemptId status=$lobsterOldAppRelaunchStatus result=$lobsterOldAppRelaunchError source=$lobsterOldInstallOriginalPath args=none$\r$\n"
    FileClose $9

    LobsterOldAppRelaunchDone:
    Pop $9
    Pop $8
    Pop $1
    Pop $0
  FunctionEnd
  !macroend

  ; Restore the complete previous tree whenever a controlled installer failure
  ; occurs after the fast-path rename but before the new install is committed.
  ; Direct NSIS Quit calls bypass callbacks, so patched template exit sites call
  ; customBeforeInstallerQuit explicitly; interactive failure/cancel callbacks
  ; use the same function as a second line of defence.
  Function lobsterRollbackOldInstall
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9

    StrCmp $lobsterOldInstallRenameStatus "success" LobsterRollbackEligible
    StrCmp $lobsterOldInstallRenameStatus "prevalidated" 0 LobsterRollbackDone
    LobsterRollbackEligible:
    StrCpy $lobsterOldInstallRollbackStatus "started"
    StrCpy $lobsterOldInstallRollbackError "0"
    StrCpy $lobsterOldInstallRenameStatus "rollback-in-progress"
    System::Call 'kernel32::GetTickCount()i .r7'
    System::Call 'kernel32::GetCurrentProcessId()i .r4'
    StrCpy $lobsterOldInstallFailedPath "$lobsterOldInstallOriginalPath.failed.$4.$7"

    InitPluginsDir
    SetOutPath "$PLUGINSDIR"

    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=old-install-rollback-start attempt_id=$lobsterInstallerAttemptId reason=$lobsterOldInstallRollbackReason source=$lobsterOldInstallOriginalPath backup=$lobsterOldInstallBackupPath displaced=$lobsterOldInstallFailedPath$\r$\n"
    FileClose $9

    ; Remove an empty target directory first. If the new payload already wrote
    ; files, move the partial tree aside so the complete backup can return to
    ; the exact registered path without destructive deletion.
    RMDir "$lobsterOldInstallOriginalPath"
    StrCpy $2 "false"
    System::Call 'kernel32::MoveFileW(w "$lobsterOldInstallOriginalPath", w "$lobsterOldInstallFailedPath") i .r0 ?e'
    Pop $1
    IntCmp $0 0 LobsterRollbackTargetMoveFailed LobsterRollbackTargetMoved LobsterRollbackTargetMoved

    LobsterRollbackTargetMoved:
      StrCpy $2 "true"
      Goto LobsterRollbackRestoreBackup

    LobsterRollbackTargetMoveFailed:
      ; ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND is expected when payload
      ; extraction had not created the target yet. The restore attempt below
      ; is the authority on whether rollback can complete.
      StrCpy $lobsterOldInstallRollbackError "target-move:$1"

    LobsterRollbackRestoreBackup:
    System::Call 'kernel32::MoveFileW(w "$lobsterOldInstallBackupPath", w "$lobsterOldInstallOriginalPath") i .r0 ?e'
    Pop $1
    IntCmp $0 0 LobsterRollbackRestoreFailed LobsterRollbackRestoreSucceeded LobsterRollbackRestoreSucceeded

    LobsterRollbackRestoreSucceeded:
      StrCpy $lobsterOldInstallRollbackStatus "success"
      StrCpy $lobsterOldInstallRollbackError "0"
      StrCpy $lobsterOldInstallRenameStatus "rolled-back"

      ; A failed update must not leave its broad, install-scope Defender
      ; exclusion protecting the restored application indefinitely.
      StrCmp $lobsterTrustedPowerShellPath "" LobsterRollbackDefenderCleanupDone
      System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_DEFENDER_TARGET", t "$lobsterOldInstallOriginalPath")i'
      Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "try { Remove-MpPreference -ExclusionPath $$env:LOBSTERAI_DEFENDER_TARGET -ErrorAction SilentlyContinue } catch {}"'
      !insertmacro LobsterExecHiddenToStack
      Pop $0
      Pop $1
      System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_DEFENDER_TARGET", t "")i'
      LobsterRollbackDefenderCleanupDone:

      ; The displaced tree is never needed after a verified restore. Pass its
      ; exact path through the child environment instead of interpolating it
      ; into cmd/PowerShell code: custom install directories may contain shell
      ; metacharacters. The detached launch is deliberately non-blocking and,
      ; unlike NSIS Exec, creates no console window.
      StrCmp $2 "true" 0 LobsterRollbackLog
      System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_FAILED_CLEANUP_PATH", t "$lobsterOldInstallFailedPath")i'
      ClearErrors
      StrCmp $lobsterTrustedPowerShellPath "" LobsterRollbackFailedTreeCleanupDone
      Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath $$env:LOBSTERAI_FAILED_CLEANUP_PATH -Recurse -Force -ErrorAction SilentlyContinue"'
      !insertmacro LobsterExecHiddenDetached
      LobsterRollbackFailedTreeCleanupDone:
      System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_FAILED_CLEANUP_PATH", t "")i'
      Goto LobsterRollbackLog

    LobsterRollbackRestoreFailed:
      StrCpy $lobsterOldInstallRollbackStatus "failed"
      StrCpy $lobsterOldInstallRollbackError "backup-restore:$1"
      StrCpy $lobsterOldInstallRenameStatus "rollback-failed"

      ; If the partial tree was displaced but the complete backup could not be
      ; restored, put the partial tree back. Never delete either tree when the
      ; recovery state is ambiguous.
      StrCmp $2 "true" 0 LobsterRollbackLog
      System::Call 'kernel32::MoveFileW(w "$lobsterOldInstallFailedPath", w "$lobsterOldInstallOriginalPath") i .r0 ?e'
      Pop $3
      IntCmp $0 0 0 LobsterRollbackLog LobsterRollbackLog
      StrCpy $lobsterOldInstallRollbackError "$lobsterOldInstallRollbackError;partial-restore:$3"

    LobsterRollbackLog:
    System::Call 'kernel32::GetTickCount()i .r6'
    IntOp $5 $6 - $7
    StrCpy $2 "false"
    StrCpy $3 "false"
    IfFileExists "$lobsterOldInstallOriginalPath\*.*" 0 LobsterRollbackSourceChecked
      StrCpy $2 "true"
    LobsterRollbackSourceChecked:
    IfFileExists "$lobsterOldInstallBackupPath\*.*" 0 LobsterRollbackBackupChecked
      StrCpy $3 "true"
    LobsterRollbackBackupChecked:
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=old-install-rollback-complete attempt_id=$lobsterInstallerAttemptId status=$lobsterOldInstallRollbackStatus reason=$lobsterOldInstallRollbackReason error=$lobsterOldInstallRollbackError elapsed_ms=$5 source_exists=$2 backup_exists=$3 displaced=$lobsterOldInstallFailedPath$\r$\n"
    FileClose $9
    StrCmp $lobsterOldInstallRollbackStatus "success" 0 LobsterRollbackDone
    Call lobsterTryRelaunchOldApp

    LobsterRollbackDone:
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  !macro customRollbackOldInstall REASON
    StrCpy $lobsterOldInstallRollbackReason "${REASON}"
    Call lobsterRollbackOldInstall
  !macroend

  ; Every patched template exit site must leave a trace. The rollback below
  ; returns without writing anything when no fast-path rename happened
  ; (rename_status is neither success nor prevalidated), which previously let
  ; e.g. a silent web-download failure quit with no log line at all -- the
  ; install-timing.log just stopped mid-flow.
  !macro LobsterLogInstallerQuit REASON
    Push $8
    Push $9
    !insertmacro EnsureInstallerAttemptId
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=installer-quit attempt_id=$lobsterInstallerAttemptId reason=${REASON} ui_mode=$lobsterUiMode rename_status=$lobsterOldInstallRenameStatus$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
  !macroend

  ; Relocated payload staging lives on the install drive, so no controlled
  ; exit may leave it behind; the rollback that follows may also need the
  ; space it frees. A $PLUGINSDIR staging is left to NSIS' own temp cleanup.
  !macro customBeforeInstallerQuit REASON
    !insertmacro LobsterLogInstallerQuit "${REASON}"
    Call lobsterCleanupRelocatedPayloadStaging
    !insertmacro customRollbackOldInstall "${REASON}"
  !macroend

  !macro customInstallerFailed
    Call lobsterCleanupRelocatedPayloadStaging
    !insertmacro customRollbackOldInstall "installer-failed"
  !macroend

  !macro customInstallerUserAbort
    Call lobsterCleanupRelocatedPayloadStaging
    !insertmacro customRollbackOldInstall "user-abort"
  !macroend
!endif

; Replaces electron-builder's built-in CHECK_APP_RUNNING. Inserted:
;  - installer: inside the install section, right after the user confirms,
;    before uninstallOldVersion and file extraction
;  - uninstaller: un.install section (assisted) or un.onInit (silent /S)
!macro customCheckAppRunning
  ; Silent installs (/S from app stores and IT deployment, or channel builds
  ; with the double-click-silent flag) must show no installer-owned window at
  ; all: /S is a zero-UI contract and the invoking store/channel owns the
  ; install progress experience. Failure dialogs stay silent-safe through
  ; their /SD defaults. In-app updates use --updated with a visible progress
  ; page and are unaffected.
  !ifndef BUILD_UNINSTALLER
    !insertmacro EnsureInstallerAttemptId
    StrCpy $lobsterOldInstallOriginalPath "$INSTDIR"
    GetFullPathName $lobsterOldInstallOriginalPathNormalized "$INSTDIR"
    StrCpy $lobsterOldAppExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $lobsterOldUninstallerPath "$INSTDIR\${UNINSTALL_FILENAME}"
    StrCpy $lobsterOldAppAsarPath "$INSTDIR\resources\app.asar"
    StrCpy $lobsterOldInstallRegisteredPath ""
    StrCpy $lobsterOldInstallRegisteredPathNormalized ""
    StrCpy $lobsterOldInstallAlternateRegisteredPath ""
    StrCpy $lobsterOldInstallAlternateRegisteredPathNormalized ""
    StrCpy $lobsterOldInstallBackupPath ""
    StrCpy $lobsterOldInstallFailedPath ""
    StrCpy $lobsterOldInstallRenameStatus "preflight"
    StrCpy $lobsterOldInstallRenameReason "not-evaluated"
    StrCpy $lobsterOldInstallRenameError "0"
    StrCpy $lobsterOldInstallRenameAttempts "0"
    StrCpy $lobsterOldInstallRollbackReason ""
    StrCpy $lobsterOldInstallRollbackStatus "not-needed"
    StrCpy $lobsterOldInstallRollbackError "0"
    StrCpy $lobsterNewInstallValidationStatus "not-started"
    StrCpy $lobsterNewInstallValidationReason "not-evaluated"
    StrCpy $lobsterTargetProcessesStopStatus "not-started"
    StrCpy $lobsterLegacySkillsStatus "not-inspected"
    StrCpy $lobsterLegacySkillsRestoreStatus "not-required"
    StrCpy $lobsterOldAppRelaunchStatus "not-attempted"
    StrCpy $lobsterOldAppRelaunchError "none"

    ; The fresh decision is read-only and precedes every external helper,
    ; process stop, legacy Skills action, old uninstaller and directory rename.
    !insertmacro DetectFreshOrPossibleExisting
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=install-preflight-complete attempt_id=$lobsterInstallerAttemptId installer_version=${VERSION} invocation_source=$lobsterInvocationSource updated_flag=$lobsterUpdatedFlag ui_mode=$lobsterUiMode launcher_fallback=$lobsterLauncherFallback scenario=$lobsterInstallScenario instdir=$INSTDIR$\r$\n"
    FileClose $9

    StrCmp $lobsterInstallScenario "fresh-install" CustomCheckFreshInstall

    ; Record the legacy source with a native, non-following attribute check
    ; before any external helper or process stop. This is advisory only: an
    ; existing installation still has to stop its processes even when the
    ; legacy source is absent, and the source is checked again after the stop
    ; before any backup is authorized.
    StrCpy $lobsterLegacySkillsStatus "legacy-source-present"
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\resources\SKILLs") i .r0'
    IntCmp $0 -1 LegacySkillsSourcePreflightAbsent 0 0
    IntOp $1 $0 & 0x10
    IntCmp $1 0 LegacySkillsSourcePreflightInvalid LegacySkillsSourcePreflightDirectory LegacySkillsSourcePreflightDirectory
    LegacySkillsSourcePreflightDirectory:
    IntOp $1 $0 & 0x400
    IntCmp $1 0 LegacySkillsSourcePreflightLogged LegacySkillsSourcePreflightInvalid LegacySkillsSourcePreflightInvalid
    LegacySkillsSourcePreflightAbsent:
      StrCpy $lobsterLegacySkillsStatus "legacy-source-not-present"
      Goto LegacySkillsSourcePreflightLogged
    LegacySkillsSourcePreflightInvalid:
      StrCpy $lobsterLegacySkillsStatus "legacy-source-invalid"
    LegacySkillsSourcePreflightLogged:
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=legacy-skills-source-preflight attempt_id=$lobsterInstallerAttemptId status=$lobsterLegacySkillsStatus source=$INSTDIR\resources\SKILLs$\r$\n"
    FileClose $9

    !insertmacro ResolveTrustedPowerShell
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=system-tool-resolved attempt_id=$lobsterInstallerAttemptId tool=powershell status=$lobsterTrustedPowerShellStatus source=$lobsterTrustedPowerShellSource path=$lobsterTrustedPowerShellPath$\r$\n"
    FileClose $9

    !insertmacro stopLobsterAIProcesses
    StrCmp $lobsterTargetProcessesStopStatus "success" TargetProcessesStopped
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=install-failed-before-mutation attempt_id=$lobsterInstallerAttemptId failure_kind=process-stop-failed raw_status=$lobsterTargetProcessesStopStatus exit=$R2 action=old-install-untouched$\r$\n"
      FileClose $9
      MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI update stopped before replacing the previous version because the old application processes could not be confirmed stopped. Please close LobsterAI and retry. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      SetErrorLevel 2
      Quit
    TargetProcessesStopped:

    ; -- Backup user-created skills to AppData before extraction overwrites them --
    ; Copy non-bundled skills to %APPDATA%\LobsterAI\skills-backup\ so they are
    ; preserved when NSIS extracts the new version over the existing install.
    ; The backup is restored in customInstall after extraction completes.
    ; Must run before the $INSTDIR rename below -- it reads from $INSTDIR.
    ;
    ; Quoting note: paths use \"..\" (backslash-escaped quote) -- NOT $\"..$\" --
    ; because $\"..$\" produces raw quotes that Windows CRT argv parsing consumes,
    ; leaving the path unquoted and causing PowerShell method calls to fail.
    ; A missing legacy source is an allowed result and never launches
    ; PowerShell. Empty-but-present directories still go through inspection.
    System::Call 'kernel32::GetTickCount()i .r7'
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\resources\SKILLs") i .r0'
    IntCmp $0 -1 SkillBackupSourceAbsent 0 0
    IntOp $1 $0 & 0x10
    IntCmp $1 0 SkillBackupInspectFailed SkillBackupSourceTypeReady SkillBackupSourceTypeReady
    SkillBackupSourceTypeReady:
    IntOp $1 $0 & 0x400
    IntCmp $1 0 SkillBackupSourceReady SkillBackupInspectFailed SkillBackupInspectFailed

    SkillBackupSourceAbsent:
      StrCpy $lobsterLegacySkillsStatus "legacy-source-not-present"
      StrCpy $R2 "0"
      Goto SkillBackupResultLog

    SkillBackupInspectFailed:
      StrCpy $lobsterLegacySkillsStatus "legacy-inspect-failed"
      StrCpy $R2 "invalid-source-attributes"
      Goto SkillBackupResultLog

    SkillBackupSourceReady:
    DetailPrint "[Installer] Backing up user-created skills"
    ClearErrors
    FileOpen $R0 "$APPDATA\LobsterAI\skill-migrate.log" w
    IfErrors BackupLogOpenFailed
      !insertmacro GetTimestamp $8
      FileWrite $R0 "$8 phase=backup-start attempt_id=$lobsterInstallerAttemptId instdir=$INSTDIR appdata=$APPDATA$\r$\n"
      Goto BackupDoExec
    BackupLogOpenFailed:
      StrCpy $R0 ""
    BackupDoExec:

    ReadRegStr $4 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_SOURCE", t "$INSTDIR\resources\SKILLs")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_BACKUP_ROOT", t "$APPDATA\LobsterAI\skills-backup")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ATTEMPT_ID", t "$lobsterInstallerAttemptId")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_OLD_VERSION", t "$4")i'
    Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "\
      $$ErrorActionPreference = \"Stop\";\
      $$src       = $$env:LOBSTERAI_SKILL_SOURCE;\
      $$root      = $$env:LOBSTERAI_SKILL_BACKUP_ROOT;\
      $$attempt   = $$env:LOBSTERAI_INSTALL_ATTEMPT_ID;\
      $$oldVer    = $$env:LOBSTERAI_OLD_VERSION;\
      $$backup    = Join-Path $$root $$attempt;\
      $$staging   = $$backup + \".new\";\
      $$manifest  = Join-Path $$staging \"backup-manifest.json\";\
      $$config    = Join-Path $$src \"skills.config.json\";\
      $$phase   = \"inspect\";\
      try {\
        if ([string]::IsNullOrWhiteSpace($$attempt)) { throw \"attempt id missing\" };\
        if (-not (Test-Path -LiteralPath $$src -PathType Container)) { throw \"legacy source disappeared\" };\
        $$bundled = @(try {\
          if (Test-Path -LiteralPath $$config -PathType Leaf) {\
            (Get-Content -LiteralPath $$config -Raw | ConvertFrom-Json).defaults.PSObject.Properties.Name\
          }\
        } catch { });\
        $$userSkills = @(Get-ChildItem -LiteralPath $$src -Directory -ErrorAction Stop | Where-Object { $$bundled -notcontains $$_.Name });\
        if ($$userSkills.Count -eq 0) { Write-Output \"legacy-no-user-skills\"; exit ${LOBSTER_SKILL_BACKUP_EXIT_NO_USER_SKILLS} };\
        $$phase = \"backup-copy\";\
        if (Test-Path -LiteralPath $$staging) { Remove-Item -LiteralPath $$staging -Recurse -Force -ErrorAction Stop };\
        if (Test-Path -LiteralPath $$backup) { throw \"attempt backup already exists\" };\
        New-Item -ItemType Directory -Path $$staging -Force -ErrorAction Stop | Out-Null;\
        $$userSkills | ForEach-Object {\
          Copy-Item -LiteralPath $$_.FullName -Destination (Join-Path $$staging $$_.Name) -Recurse -Force -ErrorAction Stop\
        };\
        Set-Content -LiteralPath (Join-Path $$staging \".attempt-id\") -Value $$attempt -NoNewline -ErrorAction Stop;\
        $$directories = @(Get-ChildItem -LiteralPath $$staging -Directory -Recurse -Force -ErrorAction Stop | Sort-Object FullName | ForEach-Object {\
          $$_.FullName.Substring($$staging.Length).TrimStart([IO.Path]::DirectorySeparatorChar).Replace([IO.Path]::DirectorySeparatorChar, [char]47)\
        });\
        $$files = @(Get-ChildItem -LiteralPath $$staging -File -Recurse -Force -ErrorAction Stop | Where-Object { $$_.Name -ne \"backup-manifest.json\" } | Sort-Object FullName | ForEach-Object {\
          [ordered]@{\
            path = $$_.FullName.Substring($$staging.Length).TrimStart([IO.Path]::DirectorySeparatorChar).Replace([IO.Path]::DirectorySeparatorChar, [char]47);\
            length = $$_.Length;\
            sha256 = (Get-FileHash -LiteralPath $$_.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()\
          }\
        });\
        $$payload = [ordered]@{\
          schemaVersion = 1;\
          attemptId = $$attempt;\
          source = $$src;\
          oldVersion = $$oldVer;\
          createdAt = (Get-Date).ToUniversalTime().ToString(\"o\");\
          skills = @($$userSkills.Name | Sort-Object);\
          directories = $$directories;\
          files = $$files;\
          statistics = [ordered]@{\
            skillCount = $$userSkills.Count;\
            directoryCount = $$directories.Count;\
            fileCount = $$files.Count;\
            totalBytes = [long](($$files | Measure-Object -Property length -Sum).Sum)\
          };\
          validation = [ordered]@{ status = \"created\"; algorithm = \"SHA256\" }\
        };\
        $$payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $$manifest -Encoding UTF8 -ErrorAction Stop;\
        Move-Item -LiteralPath $$staging -Destination $$backup -ErrorAction Stop;\
        $$phase = \"backup-verify\";\
        $$manifest = Join-Path $$backup \"backup-manifest.json\";\
        $$verified = Get-Content -LiteralPath $$manifest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop;\
        if ($$verified.schemaVersion -ne 1) { throw \"manifest schema mismatch\" };\
        if ($$verified.attemptId -ne $$attempt) { throw \"manifest attempt mismatch\" };\
        if ($$verified.source -ne $$src) { throw \"manifest source mismatch\" };\
        if (@($$verified.skills).Count -ne $$userSkills.Count) { throw \"manifest skill count mismatch\" };\
        foreach ($$skill in @($$verified.skills)) {\
          if (-not (Test-Path -LiteralPath (Join-Path $$backup $$skill) -PathType Container)) { throw \"manifest skill missing\" }\
        };\
        foreach ($$file in @($$verified.files)) {\
          $$candidate = Join-Path $$backup ($$file.path.Replace([char]47, [IO.Path]::DirectorySeparatorChar));\
          if (-not (Test-Path -LiteralPath $$candidate -PathType Leaf)) { throw \"manifest file missing\" };\
          if ((Get-FileHash -LiteralPath $$candidate -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $$file.sha256) { throw \"manifest hash mismatch\" }\
        };\
        $$verified.validation.status = \"verified\";\
        $$verified.validation | Add-Member -NotePropertyName verifiedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString(\"o\")) -Force;\
        $$verified | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $$manifest -Encoding UTF8 -ErrorAction Stop;\
        $$finalManifest = Get-Content -LiteralPath $$manifest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop;\
        if (($$finalManifest.attemptId -ne $$attempt) -or ($$finalManifest.validation.status -ne \"verified\")) { throw \"manifest final validation mismatch\" };\
        Write-Output (\"legacy-backup-succeeded skills=\" + $$finalManifest.statistics.skillCount + \" files=\" + $$finalManifest.statistics.fileCount + \" directories=\" + $$finalManifest.statistics.directoryCount + \" bytes=\" + $$finalManifest.statistics.totalBytes);\
        exit ${LOBSTER_SKILL_BACKUP_EXIT_VERIFIED}\
      } catch {\
        if (Test-Path -LiteralPath $$staging) { Remove-Item -LiteralPath $$staging -Recurse -Force -ErrorAction SilentlyContinue };\
        if ($$phase -eq \"inspect\") { Write-Output \"legacy-inspect-failed\"; exit ${LOBSTER_SKILL_BACKUP_EXIT_INSPECT_FAILED} };\
        if ($$phase -eq \"backup-verify\") { Write-Output \"legacy-backup-verify-failed\"; exit ${LOBSTER_SKILL_BACKUP_EXIT_VERIFY_FAILED} };\
        Write-Output \"legacy-backup-copy-failed\";\
        exit ${LOBSTER_SKILL_BACKUP_EXIT_COPY_FAILED}\
      }"'
    !insertmacro LobsterExecHiddenToStack
    Pop $0
    Pop $1
    StrCpy $R2 $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_SOURCE", t "")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_BACKUP_ROOT", t "")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ATTEMPT_ID", t "")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_OLD_VERSION", t "")i'
    System::Call 'kernel32::GetTickCount()i .r6'
    IntOp $5 $6 - $7

    StrCmp $R0 "" BackupSkipCloseLog
      !insertmacro GetTimestamp $8
      FileWrite $R0 "$8 phase=backup-end attempt_id=$lobsterInstallerAttemptId exit=$R2 elapsed_ms=$5$\r$\n"
      FileWrite $R0 "$8 phase=backup-output attempt_id=$lobsterInstallerAttemptId text=$1$\r$\n"
      FileClose $R0
    BackupSkipCloseLog:
    ; Status is derived from the helper exit code alone. stdout ($1) is
    ; logged above for diagnosis only: the launcher keeps the helper's
    ; trailing CRLF, so an exact text match here silently fails. Unknown
    ; exit codes keep the fail-closed copy-failed default.
    StrCpy $lobsterLegacySkillsStatus "legacy-backup-copy-failed"
    StrCmp $R2 "error" 0 +3
      StrCpy $lobsterLegacySkillsStatus "legacy-helper-launch-failed"
      Goto SkillBackupResultLog
    StrCmp $R2 "${LOBSTER_SKILL_BACKUP_EXIT_VERIFIED}" 0 +3
      StrCpy $lobsterLegacySkillsStatus "legacy-backup-succeeded"
      Goto SkillBackupResultLog
    StrCmp $R2 "${LOBSTER_SKILL_BACKUP_EXIT_NO_USER_SKILLS}" 0 +3
      StrCpy $lobsterLegacySkillsStatus "legacy-no-user-skills"
      Goto SkillBackupResultLog
    StrCmp $R2 "${LOBSTER_SKILL_BACKUP_EXIT_INSPECT_FAILED}" 0 +2
      StrCpy $lobsterLegacySkillsStatus "legacy-inspect-failed"
    StrCmp $R2 "${LOBSTER_SKILL_BACKUP_EXIT_COPY_FAILED}" 0 +2
      StrCpy $lobsterLegacySkillsStatus "legacy-backup-copy-failed"
    StrCmp $R2 "${LOBSTER_SKILL_BACKUP_EXIT_VERIFY_FAILED}" 0 +2
      StrCpy $lobsterLegacySkillsStatus "legacy-backup-verify-failed"

    SkillBackupResultLog:
    System::Call 'kernel32::GetTickCount()i .r6'
    IntOp $5 $6 - $7
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=skill-backup-complete attempt_id=$lobsterInstallerAttemptId status=$lobsterLegacySkillsStatus exit=$R2 elapsed_ms=$5 backup=$APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId$\r$\n"
    FileClose $9

    ; User-created skills live inside the installation tree. If their backup
    ; did not complete, stop before the directory swap so the only authoritative
    ; copy remains untouched. An update that fails closed is recoverable; a
    ; fast update that silently drops user data is not.
    StrCmp $lobsterLegacySkillsStatus "legacy-source-not-present" SkillBackupValidated
    StrCmp $lobsterLegacySkillsStatus "legacy-no-user-skills" SkillBackupValidated
    StrCmp $lobsterLegacySkillsStatus "legacy-backup-succeeded" 0 SkillBackupFailedAbort
      ; Post-condition for a verified backup: the manifest must still exist on
      ; disk immediately before any destructive step. If it vanished (e.g.
      ; antivirus quarantine), fail closed now while the old install is still
      ; intact instead of discovering the loss at restore time.
      IfFileExists "$APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId\backup-manifest.json" SkillBackupValidated
      StrCpy $lobsterLegacySkillsStatus "legacy-backup-verify-failed"
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=skill-backup-manifest-postcheck-missing attempt_id=$lobsterInstallerAttemptId manifest=$APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId\backup-manifest.json$\r$\n"
      FileClose $9
    SkillBackupFailedAbort:
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=skill-backup-failed-abort attempt_id=$lobsterInstallerAttemptId status=$lobsterLegacySkillsStatus exit=$R2 action=old-install-preserved$\r$\n"
      FileClose $9
      Call lobsterTryRelaunchOldApp
      MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI update stopped because legacy user skills could not be safely inspected or backed up (status=$lobsterLegacySkillsStatus). The previous installation was not replaced. Please retry the update. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      SetErrorLevel 2
      Quit
    SkillBackupValidated:

    ; -- Move the previous installation out of the target path --
    ;
    ; electron-builder's .onInit calls SetOutPath $INSTDIR. On Windows that
    ; makes $INSTDIR the installer's current directory, which prevents the
    ; directory itself from being renamed. Move the current directory to the
    ; plugin temp directory before attempting the update fast path.
    ;
    ; The fast path covers every install whose selected registry root owns
    ; this exact install directory: in-app updates and manual/channel
    ; overwrite installs alike. Falling back to the legacy uninstaller means
    ; stock un.atomicRMDir (--updated is always passed) moving the whole tree
    ; file-by-file into the unexcluded %TEMP% plugins dir -- 79s..31min in
    ; field logs, and one locked file aborts it wholesale after five silent
    ; retries (exit=2 dialog, 2026-09-01). Ambiguous or mismatched
    ; registrations retain electron-builder's old-uninstaller fallback. A
    ; successful backup is not deleted until customInstall runs, so
    ; extraction does not compete with a recursive old-tree deletion.
    DetailPrint "[Installer] Preparing previous installation for replacement"
    System::Call 'kernel32::GetTickCount()i .r7'
    StrCpy $lobsterOldInstallOriginalPath "$INSTDIR"
    GetFullPathName $lobsterOldInstallOriginalPathNormalized "$INSTDIR"
    StrCpy $lobsterOldInstallRegisteredPath ""
    StrCpy $lobsterOldInstallRegisteredPathNormalized ""
    StrCpy $lobsterOldInstallAlternateRegisteredPath ""
    StrCpy $lobsterOldInstallAlternateRegisteredPathNormalized ""
    StrCpy $lobsterOldInstallBackupPath ""
    StrCpy $lobsterOldInstallFailedPath ""
    StrCpy $lobsterOldInstallRenameStatus "not-applicable"
    StrCpy $lobsterOldInstallRenameReason "not-evaluated"
    StrCpy $lobsterOldInstallRenameError "0"
    StrCpy $lobsterOldInstallRenameAttempts "0"
    StrCpy $lobsterOldInstallRollbackReason ""
    StrCpy $lobsterOldInstallRollbackStatus "not-needed"
    StrCpy $lobsterOldInstallRollbackError "0"

    ClearErrors
    ReadRegStr $lobsterOldInstallRegisteredPath SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $lobsterOldInstallRegisteredPath "" OldInstallRegisteredPathReady
      GetFullPathName $lobsterOldInstallRegisteredPathNormalized "$lobsterOldInstallRegisteredPath"
    OldInstallRegisteredPathReady:

    GetFullPathName $lobsterOldInstallCurrentDirectory "."
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"

    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=old-install-rename-start attempt_id=$lobsterInstallerAttemptId instdir=$lobsterOldInstallOriginalPath registered_instdir=$lobsterOldInstallRegisteredPath current_directory=$lobsterOldInstallCurrentDirectory install_mode=$installMode$\r$\n"
    FileClose $9

    StrCpy $lobsterOldInstallRenameReason "registered-install-missing"
    StrCmp $lobsterOldInstallRegisteredPathNormalized "" OldInstallRenameComplete

    StrCpy $lobsterOldInstallRenameReason "install-location-mismatch"
    StrCmp $lobsterOldInstallRegisteredPathNormalized $lobsterOldInstallOriginalPathNormalized 0 OldInstallRenameComplete

    ; A machine install can have a stale per-user registration pointing at the
    ; same directory. Fast-path skipping both roots would preserve a duplicate
    ; Add/Remove Programs entry whose uninstaller targets the live machine
    ; install, so treat this ambiguous state as fallback-only.
    ${If} $installMode == "all"
      ClearErrors
      ReadRegStr $lobsterOldInstallAlternateRegisteredPath HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
      StrCmp $lobsterOldInstallAlternateRegisteredPath "" OldInstallAlternateRegisteredPathReady
        GetFullPathName $lobsterOldInstallAlternateRegisteredPathNormalized "$lobsterOldInstallAlternateRegisteredPath"
      OldInstallAlternateRegisteredPathReady:
      StrCpy $lobsterOldInstallRenameReason "ambiguous-dual-registration"
      StrCmp $lobsterOldInstallAlternateRegisteredPathNormalized $lobsterOldInstallOriginalPathNormalized OldInstallRenameComplete
    ${EndIf}

    StrCpy $lobsterOldInstallRenameReason "install-files-missing"
    IfFileExists "$lobsterOldInstallOriginalPath\${APP_EXECUTABLE_FILENAME}" OldInstallRenameEligible
    IfFileExists "$lobsterOldInstallOriginalPath\${UNINSTALL_FILENAME}" OldInstallRenameEligible
    Goto OldInstallRenameComplete

    OldInstallRenameEligible:
      StrCpy $lobsterOldInstallRenameStatus "failed"
      StrCpy $lobsterOldInstallRenameReason "rename-failed"
      System::Call 'kernel32::GetCurrentProcessId()i .r4'
      StrCpy $lobsterCurrentProcessPid $4
      System::Call 'kernel32::GetTickCount()i .r4'
      StrCpy $lobsterOldInstallBackupPath "$lobsterOldInstallOriginalPath.old.$lobsterCurrentProcessPid.$4"

    OldInstallRenameAttempt:
      IntOp $lobsterOldInstallRenameAttempts $lobsterOldInstallRenameAttempts + 1
      ; Capture the Win32 error in the same System plug-in invocation as the
      ; move. GetLastError after an NSIS Rename/logging call can be stale.
      System::Call 'kernel32::MoveFileW(w "$lobsterOldInstallOriginalPath", w "$lobsterOldInstallBackupPath") i .r4 ?e'
      Pop $lobsterOldInstallRenameError
      IntCmp $4 0 OldInstallRenameAttemptFailed OldInstallRenameAttemptSucceeded OldInstallRenameAttemptSucceeded

    OldInstallRenameAttemptSucceeded:
      StrCpy $lobsterOldInstallRenameStatus "success"

      ; Rename success is only accepted when the source tree is gone and the
      ; complete backup tree is visible at the unique destination.
      IfFileExists "$lobsterOldInstallOriginalPath\*.*" OldInstallRenameVerificationFailed
      IfFileExists "$lobsterOldInstallBackupPath\*.*" 0 OldInstallRenameVerificationFailed
      StrCpy $lobsterOldInstallRenameStatus "success"
      StrCpy $lobsterOldInstallRenameReason "renamed"
      StrCpy $lobsterOldInstallRenameError "0"
      Goto OldInstallRenameComplete

    OldInstallRenameAttemptFailed:
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=old-install-rename-attempt attempt_id=$lobsterInstallerAttemptId attempt=$lobsterOldInstallRenameAttempts result=failed win32_error=$lobsterOldInstallRenameError$\r$\n"
      FileClose $9
      IntCmp $lobsterOldInstallRenameAttempts 3 OldInstallRenameComplete OldInstallRenameRetry OldInstallRenameComplete

    OldInstallRenameRetry:
      Sleep 250
      Goto OldInstallRenameAttempt

    OldInstallRenameVerificationFailed:
      StrCpy $lobsterOldInstallRenameReason "verification-failed"
      StrCpy $lobsterOldInstallRenameError "verification-failed"
      !insertmacro customRollbackOldInstall "rename-verification-failed"
      StrCmp $lobsterOldInstallRollbackStatus "success" OldInstallRenameVerificationRestored

      ; The move succeeded but its postcondition could not be verified, and
      ; rollback could not restore a single authoritative old tree. Freeze the
      ; attempt with every recovery source preserved; never fall through into
      ; stock uninstall/install while filesystem ownership is ambiguous.
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=old-install-rename-verification-abort attempt_id=$lobsterInstallerAttemptId outcome=recovery-required rollback_status=$lobsterOldInstallRollbackStatus rollback_error=$lobsterOldInstallRollbackError source=$lobsterOldInstallOriginalPath backup=$lobsterOldInstallBackupPath$\r$\n"
      FileClose $9
      MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI installation stopped because the previous installation move could not be verified and automatic recovery did not complete. No recovery copy was deleted. Restart Windows before retrying. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      SetErrorLevel 3
      Quit

    OldInstallRenameVerificationRestored:
      ; lobsterRollbackOldInstall has already restored and, when its strict
      ; gates allow it, relaunched the old application. This attempt must end
      ; here instead of invoking the stock uninstaller against that live tree.
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=old-install-rename-verification-abort attempt_id=$lobsterInstallerAttemptId outcome=restored rollback_status=$lobsterOldInstallRollbackStatus relaunch_status=$lobsterOldAppRelaunchStatus source=$lobsterOldInstallOriginalPath$\r$\n"
      FileClose $9
      MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI installation stopped because the previous installation move could not be verified. The previous version was restored. Please retry the installation. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      SetErrorLevel 2
      Quit

    OldInstallRenameComplete:
    System::Call 'kernel32::GetTickCount()i .r6'
    IntOp $5 $6 - $7
    StrCpy $2 "false"
    StrCpy $3 "false"
    IfFileExists "$lobsterOldInstallOriginalPath\*.*" 0 OldInstallRenameSourceChecked
      StrCpy $2 "true"
    OldInstallRenameSourceChecked:
    StrCmp $lobsterOldInstallBackupPath "" OldInstallRenameBackupChecked
    IfFileExists "$lobsterOldInstallBackupPath\*.*" 0 OldInstallRenameBackupChecked
      StrCpy $3 "true"
    OldInstallRenameBackupChecked:
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=old-install-rename-complete attempt_id=$lobsterInstallerAttemptId status=$lobsterOldInstallRenameStatus reason=$lobsterOldInstallRenameReason attempts=$lobsterOldInstallRenameAttempts win32_error=$lobsterOldInstallRenameError elapsed_ms=$5 source_exists=$2 backup_exists=$3 backup_path=$lobsterOldInstallBackupPath cleanup_mode=deferred$\r$\n"
    FileClose $9

    ; The install-scope Defender exclusion is intentionally added by
    ; customAfterUninstallOldVersions, after every legacy uninstaller has
    ; returned. Older uninstallers remove these exclusions during --updated;
    ; adding here would let them undo the protection before payload extraction.
    Goto CustomCheckInstallerDone

    CustomCheckFreshInstall:
      StrCpy $lobsterTargetProcessesStopStatus "not-required-fresh-install"
      StrCpy $lobsterLegacySkillsStatus "legacy-not-applicable-fresh-install"
      StrCpy $lobsterOldInstallRenameStatus "not-required"
      StrCpy $lobsterOldInstallRenameReason "fresh-install"
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=fresh-install-old-flow-skipped attempt_id=$lobsterInstallerAttemptId process_stop=skipped legacy_skills=skipped old_staging=skipped$\r$\n"
      FileClose $9

    CustomCheckInstallerDone:
  !else
    ; Uninstall remains best-effort when PowerShell is unavailable. It uses the
    ; same absolute resolver but does not turn an optional process stop into an
    ; uninstall blocker.
    !insertmacro EnsureInstallerAttemptId
    !insertmacro ResolveTrustedPowerShell
    !insertmacro stopLobsterAIProcesses
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  ; electron-builder delegates each registry root to this wrapper. A successful
  ; fast-path rename is matched against that root's InstallLocation explicitly;
  ; only the matching legacy uninstaller is skipped. Every other case retains
  ; the stock uninstallOldVersion fallback and its error handling.
  !macro customUninstallOldVersion ROOT_KEY
    StrCpy $lobsterOldUninstallCandidatePath ""
    StrCpy $lobsterOldUninstallCandidatePathNormalized ""
    ClearErrors
    !insertmacro readReg $lobsterOldUninstallCandidatePath ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $lobsterOldUninstallCandidatePath "" CustomOldUninstallCandidateReady_${ROOT_KEY}
      GetFullPathName $lobsterOldUninstallCandidatePathNormalized "$lobsterOldUninstallCandidatePath"
    CustomOldUninstallCandidateReady_${ROOT_KEY}:

    ${If} $lobsterOldInstallRenameStatus == "success"
    ${AndIf} $lobsterOldUninstallCandidatePathNormalized != ""
    ${AndIf} $lobsterOldUninstallCandidatePathNormalized == $lobsterOldInstallOriginalPathNormalized
      ClearErrors
      StrCpy $R0 0
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=old-uninstaller-skipped attempt_id=$lobsterInstallerAttemptId root=${ROOT_KEY} reason=rename-success registered_instdir=$lobsterOldUninstallCandidatePath backup_path=$lobsterOldInstallBackupPath$\r$\n"
      FileClose $9
    ${Else}
      System::Call 'kernel32::GetTickCount()i .r4'
      StrCpy $lobsterOldUninstallStartTick $4
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=old-uninstaller-start attempt_id=$lobsterInstallerAttemptId root=${ROOT_KEY} registered_instdir=$lobsterOldUninstallCandidatePath rename_status=$lobsterOldInstallRenameStatus$\r$\n"
      FileClose $9

      !insertmacro uninstallOldVersion ${ROOT_KEY}
      IfErrors CustomOldUninstallerLaunchFailed_${ROOT_KEY}
      StrCpy $lobsterOldUninstallLaunchStatus "returned"
      Goto CustomOldUninstallerReturned_${ROOT_KEY}

      CustomOldUninstallerLaunchFailed_${ROOT_KEY}:
      StrCpy $lobsterOldUninstallLaunchStatus "launch-error"

      CustomOldUninstallerReturned_${ROOT_KEY}:
      System::Call 'kernel32::GetTickCount()i .r6'
      IntOp $5 $6 - $lobsterOldUninstallStartTick
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=old-uninstaller-returned attempt_id=$lobsterInstallerAttemptId root=${ROOT_KEY} status=$lobsterOldUninstallLaunchStatus exit=$R0 elapsed_ms=$5$\r$\n"
      FileClose $9

      ; handleUninstallResult calls Quit for a non-zero legacy uninstaller.
      ; Roll the fast-path directory swap back before handing it that result.
      ${If} $R0 != 0
        !insertmacro customRollbackOldInstall "old-uninstaller-nonzero"
      ${EndIf}

      ; The diagnostic writes above can change NSIS' error flag. Recreate the
      ; exact result expected by electron-builder's stock handler.
      StrCmp $lobsterOldUninstallLaunchStatus "launch-error" CustomOldUninstallerRestoreError_${ROOT_KEY}
      ClearErrors
      Goto CustomOldUninstallerHandle_${ROOT_KEY}
      CustomOldUninstallerRestoreError_${ROOT_KEY}:
      SetErrors
      CustomOldUninstallerHandle_${ROOT_KEY}:
      !insertmacro handleUninstallResult ${ROOT_KEY}

      System::Call 'kernel32::GetTickCount()i .r6'
      IntOp $5 $6 - $lobsterOldUninstallStartTick
      FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $9 0 END
      !insertmacro GetTimestamp $8
      FileWrite $9 "$8 phase=old-uninstaller-complete attempt_id=$lobsterInstallerAttemptId root=${ROOT_KEY} status=handled exit=$R0 elapsed_ms=$5$\r$\n"
      FileClose $9
    ${EndIf}
  !macroend

  ; Runs after every old-install root has either been skipped or fully
  ; uninstalled, immediately before installApplicationFiles. This ordering is
  ; important for transition upgrades: already-installed legacy uninstallers
  ; remove LobsterAI exclusions at the end of their --updated flow.
  !macro customAfterUninstallOldVersions
    DetailPrint "[Installer] Applying Windows Defender install-scope exclusion"
    !insertmacro ResolveTrustedPowerShell
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=defender-exclusion-start attempt_id=$lobsterInstallerAttemptId point=post-old-uninstaller rename_status=$lobsterOldInstallRenameStatus helper_status=$lobsterTrustedPowerShellStatus$\r$\n"
    FileClose $9
    System::Call 'kernel32::GetTickCount()i .r7'
    StrCmp $lobsterTrustedPowerShellPath "" DefenderPostUninstallHelperMissing

    ${GetParameters} $R9
    ClearErrors
    ${GetOptions} $R9 "/NoDefenderExclusion" $R8
    IfErrors 0 DefenderPostUninstallQueryOnly

    CreateDirectory "$INSTDIR"
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ROOT", t "$INSTDIR")i'
    Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "\
      $$target = $$env:LOBSTERAI_INSTALL_ROOT;\
      try { $$beforePaths = @((Get-MpPreference -ErrorAction Stop).ExclusionPath); $$before = if ($$beforePaths -contains $$target) { \"present\" } else { \"absent\" } } catch { $$before = \"query-failed\" };\
      try { Add-MpPreference -ExclusionPath $$target -ErrorAction Stop; $$add = \"added\" } catch { $$add = \"skipped:\" + $$_.Exception.Message.Trim() };\
      try { $$afterPaths = @((Get-MpPreference -ErrorAction Stop).ExclusionPath); $$after = if ($$afterPaths -contains $$target) { \"present\" } else { \"absent\" } } catch { $$after = \"query-failed\" };\
      Write-Output (\"before=\" + $$before + \" add=\" + $$add + \" after=\" + $$after)"'
    !insertmacro LobsterExecHiddenToStack
    Goto DefenderPostUninstallCommandDone

    DefenderPostUninstallQueryOnly:
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ROOT", t "$INSTDIR")i'
    Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "\
      $$root = $$env:LOBSTERAI_INSTALL_ROOT;\
      $$targets = @($$root, (Join-Path $$root \"resources\cfmind\"), (Join-Path $$root \"resources\python-win\"), (Join-Path $$root \"resources\SKILLs\"), (Join-Path $$root \"resources\app.asar.unpacked\"), (Join-Path $$root \"resources\app.asar\"), (Join-Path $$root \"resources\win-resources.tar\"));\
      try { $$beforePaths = @((Get-MpPreference -ErrorAction Stop).ExclusionPath); $$before = @($$targets | Where-Object { $$beforePaths -contains $$_ }).Count } catch { $$before = \"query-failed\" };\
      try { Remove-MpPreference -ExclusionPath $$targets -ErrorAction Stop; $$remove = \"requested\" } catch { $$remove = \"failed:\" + $$_.Exception.Message.Trim() };\
      try { $$afterPaths = @((Get-MpPreference -ErrorAction Stop).ExclusionPath); $$after = @($$targets | Where-Object { $$afterPaths -contains $$_ }).Count } catch { $$after = \"query-failed\" };\
      Write-Output (\"before_count=\" + $$before + \" add=disabled remove=\" + $$remove + \" after_count=\" + $$after)"'
    !insertmacro LobsterExecHiddenToStack

    DefenderPostUninstallCommandDone:
    Pop $0
    Pop $1
    StrCpy $R2 $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ROOT", t "")i'
    Goto DefenderPostUninstallLog

    DefenderPostUninstallHelperMissing:
    StrCpy $R2 "helper-not-found"
    StrCpy $1 "skipped:trusted-powershell-unavailable"

    DefenderPostUninstallLog:
    System::Call 'kernel32::GetTickCount()i .r6'
    IntOp $5 $6 - $7
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=defender-exclusion-complete attempt_id=$lobsterInstallerAttemptId point=post-old-uninstaller exit=$R2 elapsed_ms=$5 output=$1$\r$\n"
    FileClose $9
  !macroend

  ; The remaining hooks are invoked from the version-pinned app-builder-lib
  ; template patch. They use only built-in timing/file operations so the
  ; diagnostics do not add more security-scanned child processes.

  ; Web-installer (nsis-web) payload acquisition boundaries. Acquisition runs
  ; at the top of the install section, before anything destructive; source
  ; records how the payload was obtained (explicit/sibling/cache/download).
  ; attempt_id already exists here: customInit ensures it during .onInit.
  !macro customWebPackageAcquireStart
    Push $0
    Push $8
    Push $9
    !insertmacro EnsureInstallerAttemptId
    System::Call 'kernel32::GetTickCount()i .r0'
    StrCpy $lobsterWebAcquireStartTick $0
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=web-package-acquire-start attempt_id=$lobsterInstallerAttemptId$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $0
  !macroend

  !macro customWebPackageAcquireEnd SOURCE
    Push $0
    Push $1
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    IntOp $1 $0 - $lobsterWebAcquireStartTick
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=web-package-acquire-complete attempt_id=$lobsterInstallerAttemptId source=${SOURCE} elapsed_ms=$1 file=$packageFile$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $1
    Pop $0
  !macroend

  ; Post-download integrity check (SHA2-512 against the build-time hash).
  !macro customWebPackageVerifyStart
    Push $0
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    StrCpy $lobsterWebVerifyStartTick $0
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=web-package-verify-start attempt_id=$lobsterInstallerAttemptId attempt=$webDownloadAttempt$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $0
  !macroend

  !macro customWebPackageVerifyEnd RESULT
    Push $0
    Push $1
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    IntOp $1 $0 - $lobsterWebVerifyStartTick
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=web-package-verify-complete attempt_id=$lobsterInstallerAttemptId attempt=$webDownloadAttempt result=${RESULT} elapsed_ms=$1$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $1
    Pop $0
  !macroend

  ; Web-installer (nsis-web) download boundaries. The download is the only
  ; phase that talks to the network; a run whose last line is
  ; web-package-download-start died inside the transfer. Before these hooks
  ; that window had no logging at all.
  !macro customWebPackageDownloadStart MODE
    Push $0
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    StrCpy $lobsterWebDownloadStartTick $0
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=web-package-download-start attempt_id=$lobsterInstallerAttemptId attempt=$webDownloadAttempt mode=${MODE} arch=$packageArch url=$packageUrl dest=$PLUGINSDIR\package.7z$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $0
  !macroend

  !macro customWebPackageDownloadEnd MODE STATUS
    Push $0
    Push $1
    Push $2
    Push $8
    Push $9
    ; STATUS expands to a register at the call site; capture it before the
    ; GetTickCount call overwrites $0. Kept as the last field because inetc
    ; status strings may contain spaces ("SendRequest Error").
    StrCpy $2 "${STATUS}"
    System::Call 'kernel32::GetTickCount()i .r0'
    IntOp $1 $0 - $lobsterWebDownloadStartTick
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=web-package-download-exit attempt_id=$lobsterInstallerAttemptId attempt=$webDownloadAttempt mode=${MODE} elapsed_ms=$1 status=$2$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $2
    Pop $1
    Pop $0
  !macroend

  !macro customAppPackageMaterializeStart
    Push $0
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    StrCpy $lobsterPackageMaterializeStartTick $0
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=payload-materialize-start attempt_id=$lobsterInstallerAttemptId arch=$packageArch dest=$appPackageStagingDir\app-$packageArch.${COMPRESSION_METHOD}$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $0
  !macroend

  !macro customAppPackageMaterializeEnd
    Push $0
    Push $1
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    IntOp $1 $0 - $lobsterPackageMaterializeStartTick
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=payload-materialize-complete attempt_id=$lobsterInstallerAttemptId arch=$packageArch elapsed_ms=$1$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $1
    Pop $0
  !macroend

  !macro customAppPackageExtractStart MODE SOURCE
    Push $0
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    StrCpy $lobsterPackageExtractStartTick $0
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=payload-7z-extract-start attempt_id=$lobsterInstallerAttemptId mode=${MODE} arch=$packageArch source=${SOURCE} dest=$OUTDIR$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $0
  !macroend

  !macro customAppPackageExtractEnd MODE RESULT
    Push $0
    Push $1
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    IntOp $1 $0 - $lobsterPackageExtractStartTick
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=payload-7z-extract-complete attempt_id=$lobsterInstallerAttemptId mode=${MODE} arch=$packageArch result=${RESULT} elapsed_ms=$1$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $1
    Pop $0
    ; This hook runs right after Nsis7z::Extract and before the CopyFiles
    ; commit, so a truncated staging tree is caught while the previous
    ; installation is still restorable.
    !insertmacro LobsterValidateStagedPayload "${MODE}"
  !macroend

  !macro customAppPackageCopyStart
    Push $0
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    StrCpy $lobsterPackageCopyStartTick $0
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=payload-copy-start attempt_id=$lobsterInstallerAttemptId attempt=$R1 source=$appPackageStagingDir\7z-out dest=$OUTDIR$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $0
  !macroend

  !macro customAppPackageCopyEnd RESULT
    Push $0
    Push $1
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    IntOp $1 $0 - $lobsterPackageCopyStartTick
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=payload-copy-complete attempt_id=$lobsterInstallerAttemptId attempt=$R1 result=${RESULT} elapsed_ms=$1$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $1
    Pop $0
  !macroend

  !macro customInstallerCacheCopyStart KIND
    Push $0
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    StrCpy $lobsterInstallerCacheCopyStartTick $0
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=installer-cache-copy-start attempt_id=$lobsterInstallerAttemptId kind=${KIND}$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $0
  !macroend

  !macro customInstallerCacheCopyEnd KIND RESULT
    Push $0
    Push $1
    Push $2
    Push $3
    Push $8
    Push $9
    ; Best-effort Win32 error snapshot for the copy that just failed, taken
    ; before any other System call in this macro. NSIS built-ins running in
    ; between can overwrite the thread error, so treat it as a strong hint,
    ; not proof (112 = ERROR_DISK_FULL). Because the hint is not proof, a
    ; failed copy also records the destination volume's free space -- that
    ; pair makes disk-full unambiguous (the 2026-08-25 temp-drive-exhaustion
    ; field case surfaced here only as result=error after a 141ms
    ; SHFileOperation precheck). The copy stays non-fatal either way.
    System::Call 'kernel32::GetLastError() i .r2'
    System::Call 'kernel32::GetTickCount()i .r0'
    IntOp $1 $0 - $lobsterInstallerCacheCopyStartTick
    StrCpy $3 "-"
    ${If} "${RESULT}" == "error"
      ; Shell var context is still "current" here, so this is the same
      ; $LOCALAPPDATA the failed copy targeted.
      Push "$LOCALAPPDATA"
      Call lobsterQueryFreeMegabytes
      Pop $3
    ${EndIf}
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    ${If} "${RESULT}" == "error"
      FileWrite $9 "$8 phase=installer-cache-copy-complete attempt_id=$lobsterInstallerAttemptId kind=${KIND} result=${RESULT} win32_error=$2 dest_free_mb=$3 elapsed_ms=$1$\r$\n"
    ${Else}
      FileWrite $9 "$8 phase=installer-cache-copy-complete attempt_id=$lobsterInstallerAttemptId kind=${KIND} result=${RESULT} elapsed_ms=$1$\r$\n"
    ${EndIf}
    FileClose $9
    Pop $9
    Pop $8
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  !macroend

  !macro customEstimatedSizeKnown VALUE
    Push $8
    Push $9
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=estimated-size-scan-skipped attempt_id=$lobsterInstallerAttemptId source=build-estimate value_kb=${VALUE}$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
  !macroend

  !macro customEstimatedSizeScanStart
    Push $0
    System::Call 'kernel32::GetTickCount()i .r0'
    StrCpy $lobsterEstimatedSizeScanStartTick $0
    Pop $0
  !macroend

  !macro customEstimatedSizeScanEnd VALUE
    StrCpy $lobsterEstimatedSizeValue ${VALUE}
    Push $0
    Push $1
    Push $8
    Push $9
    System::Call 'kernel32::GetTickCount()i .r0'
    IntOp $1 $0 - $lobsterEstimatedSizeScanStartTick
    FileOpen $9 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $9 0 END
    !insertmacro GetTimestamp $8
    FileWrite $9 "$8 phase=estimated-size-scan-complete attempt_id=$lobsterInstallerAttemptId value_kb=$lobsterEstimatedSizeValue elapsed_ms=$1$\r$\n"
    FileClose $9
    Pop $9
    Pop $8
    Pop $1
    Pop $0
  !macroend
!endif

!macro customBeforeRegistryAddInstallInfo
  ; -- Install Timing Log --
  ; Write timestamps to help diagnose slow installation phases.
  ; Log file: %APPDATA%\LobsterAI\install-timing.log

  CreateDirectory "$APPDATA\LobsterAI"
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=app-files-install-complete attempt_id=$lobsterInstallerAttemptId$\r$\n"
  FileWrite $2 "$8 phase=nsis-extract-complete attempt_id=$lobsterInstallerAttemptId$\r$\n"
  FileClose $2
  DetailPrint "[Installer] Preparing installation steps"

  ; The payload copy into $INSTDIR is committed, so a staging tree relocated
  ; onto the install drive has served its purpose. Remove it before the tar
  ; extraction below needs that space back.
  Call lobsterCleanupRelocatedPayloadStaging

  ; -- Extract combined resource archive (win-resources.tar) --
  ; All large resource directories (cfmind/, SKILLs/, python-win/) are packed
  ; into a single tar file. NSIS 7z extracts one large file almost instantly;
  ; we then unpack the tar here using Electron's Node runtime.
  ;
  ; The install-scope Defender exclusion was added after every legacy
  ; uninstaller returned and immediately before the NSIS payload extraction;
  ; temporary/legacy entries are trimmed at the end of this macro.

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'

  DetailPrint "[Installer] Extracting bundled resources"
  ; $R2 = current extractor exit code, $R3 = extractor id for logs.
  ; ($R2 survives GetTimestamp, which clobbers $0 -- see the macro note.)
  StrCpy $R2 ""
  StrCpy $R3 "none"
  StrCpy $R4 "none"
  !insertmacro ResolveTrustedTar
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=system-tool-resolved attempt_id=$lobsterInstallerAttemptId tool=tar status=$lobsterTrustedTarStatus source=$lobsterTrustedTarSource path=$lobsterTrustedTarPath$\r$\n"
  FileClose $2

  ; -- Attempt 1: Windows built-in bsdtar (Win10 1803+) --
  ; Runs a trusted system binary instead of the freshly written app exe,
  ; which security software tends to freeze for cloud analysis on its first
  ; execution (the root cause of installers hanging at this phase).
  StrCmp $lobsterTrustedTarPath "" TarExtractElectron
  StrCpy $R3 "system-tar"
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=tar-extract-start attempt_id=$lobsterInstallerAttemptId extractor=system-tar helper=$lobsterTrustedTarPath tar=$INSTDIR\resources\win-resources.tar dest=$INSTDIR\resources$\r$\n"
  FileClose $2
  System::Call 'kernel32::GetTickCount()i .r7'
  ; The output is captured: bsdtar reports its fatal reason only on stderr
  ; ("Truncated tar archive detected while reading data" in the 2026-08-25
  ; field case), and the details pane this installer never shows was the
  ; only place the old ExecToLog delivered it. The exit code contract below
  ; is unchanged; on success tar -xf prints nothing and the output is
  ; discarded.
  Push '"$lobsterTrustedTarPath" -xf "$INSTDIR\resources\win-resources.tar" -C "$INSTDIR\resources"'
  !insertmacro LobsterExecHiddenToStack
  Pop $0
  Pop $R6
  StrCpy $R2 $0
  System::Call 'kernel32::GetTickCount()i .r6'
  IntOp $5 $6 - $7
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=tar-extract-exit attempt_id=$lobsterInstallerAttemptId extractor=system-tar raw_kind=numeric-or-adapter-exit exit=$R2 elapsed_ms=$5$\r$\n"
  FileClose $2
  ; On any non-success exit, preserve a bounded single-line tail of the
  ; combined stdout+stderr before the electron fallback overwrites $R2. The
  ; condition mirrors the dispatch below exactly.
  StrCmp $R2 "error" TarExtractCaptureOutput
  IntCmp $R2 0 TarExtractOutputCaptured TarExtractCaptureOutput TarExtractCaptureOutput
  TarExtractCaptureOutput:
    Push $R6
    Call lobsterBuildSingleLineTail
    Pop $R6
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=tar-extract-output attempt_id=$lobsterInstallerAttemptId extractor=system-tar exit=$R2 text=$R6$\r$\n"
    FileClose $2
  TarExtractOutputCaptured:
  StrCmp $R2 "error" TarExtractElectron
  IntCmp $R2 0 TarExtractVerify TarExtractElectron TarExtractElectron

  TarExtractElectron:
  ; -- Attempt 2: bundled Electron Node runtime --
  ; Wrapped in a 10-minute watchdog: if security software freezes the child
  ; before it can run, the installer must fail visibly instead of hanging
  ; forever (a killed installer leaves a half-installed app behind).
  ;
  ; Some security tooling permanently breaks the .NET exit-code query inside
  ; PowerShell ($p.ExitCode stays $null after a successful wait) while the
  ; child itself completes fine. The child therefore publishes a post-verify
  ; sentinel file (.unpack-cfmind-ok); a null exit code with the sentinel
  ; present is treated as success, still gated by TarExtractVerify.
  StrCpy $R3 "electron"
  DetailPrint "[Installer] Launching bundled extractor"
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=tar-extract-start attempt_id=$lobsterInstallerAttemptId extractor=electron tar=$INSTDIR\resources\win-resources.tar dest=$INSTDIR\resources$\r$\n"
  FileClose $2
  System::Call 'kernel32::GetTickCount()i .r7'

  !insertmacro ResolveTrustedPowerShell
  StrCmp $lobsterTrustedPowerShellPath "" TarExtractHelperNotFound
  Delete "$PLUGINSDIR\lobster-watchdog-$lobsterInstallerAttemptId.marker"
  ; A stale sentinel from an earlier run must never vouch for this attempt.
  Delete "$INSTDIR\resources\.unpack-cfmind-ok"
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_WATCHDOG_MARKER_PATH", t "$PLUGINSDIR\lobster-watchdog-$lobsterInstallerAttemptId.marker")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_EXE", t "$INSTDIR\${APP_EXECUTABLE_FILENAME}")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_SCRIPT", t "$INSTDIR\resources\unpack-cfmind.cjs")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_ARCHIVE", t "$INSTDIR\resources\win-resources.tar")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_DESTINATION", t "$INSTDIR\resources")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_LOG", t "$APPDATA\LobsterAI\install-timing.log")i'
  Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "\
    $$ErrorActionPreference = \"Stop\";\
    $$marker = $$env:LOBSTERAI_WATCHDOG_MARKER_PATH;\
    function Write-LobsterWatchdogMarker {\
      param([string] $$value);\
      try {\
        Set-Content -LiteralPath $$marker -Value $$value -NoNewline -ErrorAction Stop\
      } catch {\
        Write-Output (\"LOBSTERAI_WATCHDOG_MARKER_WRITE_FAILED:\" + $$value)\
      }\
    };\
    try {\
      $$extractorArgs = \"`\"\" + $$env:LOBSTERAI_EXTRACTOR_SCRIPT + \"`\" `\"\" + $$env:LOBSTERAI_EXTRACTOR_ARCHIVE + \"`\" `\"\" + $$env:LOBSTERAI_EXTRACTOR_DESTINATION + \"`\" `\"\" + $$env:LOBSTERAI_EXTRACTOR_LOG + \"`\"\";\
      $$p = Start-Process -FilePath $$env:LOBSTERAI_EXTRACTOR_EXE -ArgumentList $$extractorArgs -NoNewWindow -PassThru\
    } catch {\
      Write-LobsterWatchdogMarker \"process-start-blocked\";\
      Write-Output \"LOBSTERAI_WATCHDOG_START_BLOCKED\";\
      exit 125\
    };\
    if ($$p.WaitForExit(600000)) {\
      $$p.WaitForExit();\
      if ($$p.ExitCode -eq $$null) {\
        $$sentinelOk = $$false;\
        try {\
          $$sentinel = Join-Path $$env:LOBSTERAI_EXTRACTOR_DESTINATION \".unpack-cfmind-ok\";\
          $$sentinelOk = Test-Path -LiteralPath $$sentinel\
        } catch { $$sentinelOk = $$false };\
        if ($$sentinelOk) {\
          Write-LobsterWatchdogMarker \"exit-code-null-sentinel-ok\";\
          exit 0\
        };\
        Write-LobsterWatchdogMarker \"output-validation-failed\";\
        exit 127\
      };\
      exit $$p.ExitCode\
    };\
    try {\
      Stop-Process -Id $$p.Id -Force -ErrorAction Stop;\
      if (-not $$p.WaitForExit(30000)) {\
        Write-LobsterWatchdogMarker \"process-termination-failed\";\
        Write-Output \"LOBSTERAI_WATCHDOG_TERMINATION_FAILED\";\
        exit 126\
      }\
    } catch {\
      Write-LobsterWatchdogMarker \"process-termination-failed\";\
      Write-Output \"LOBSTERAI_WATCHDOG_TERMINATION_FAILED\";\
      exit 126\
    };\
    Write-LobsterWatchdogMarker \"process-timeout\";\
    Write-Output \"LOBSTERAI_WATCHDOG_TIMEOUT\";\
    exit 124"'
  !insertmacro LobsterExecHiddenExitCode
  Pop $0
  StrCpy $R2 $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_WATCHDOG_MARKER_PATH", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_EXE", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_SCRIPT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_ARCHIVE", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_DESTINATION", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_EXTRACTOR_LOG", t "")i'
  StrCpy $R4 "none"
  ClearErrors
  FileOpen $3 "$PLUGINSDIR\lobster-watchdog-$lobsterInstallerAttemptId.marker" r
  IfErrors TarExtractMarkerReadDone
    FileRead $3 $R4
    FileClose $3
  TarExtractMarkerReadDone:
  Delete "$PLUGINSDIR\lobster-watchdog-$lobsterInstallerAttemptId.marker"
  Goto TarExtractWatchdogReturned

  TarExtractHelperNotFound:
  StrCpy $R2 "helper-not-found"
  StrCpy $R4 "helper-not-found"

  TarExtractWatchdogReturned:
  System::Call 'kernel32::GetTickCount()i .r6'
  IntOp $5 $6 - $7
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=tar-extract-exit attempt_id=$lobsterInstallerAttemptId extractor=electron raw_marker=$R4 exit=$R2 elapsed_ms=$5$\r$\n"
  FileClose $2

  ; "error" = the launcher couldn't start PowerShell (check before IntCmp, which
  ; converts non-numeric strings to 0 and would misidentify "error" as success)
  StrCmp $R2 "error" TarExtractProcessFailed
  StrCmp $R2 "helper-not-found" TarExtractProcessFailed
  ; Marker persistence is diagnostic only. A frozen child can also block or
  ; deny writes to $PLUGINSDIR, so the dedicated wrapper exit must independently
  ; select the no-concurrent-rollback path.
  StrCmp $R2 "126" TarExtractTerminationFailed
  StrCmp $R4 "process-start-blocked" TarExtractProcessFailed
  StrCmp $R4 "process-termination-failed" TarExtractTerminationFailed
  StrCmp $R4 "output-validation-failed" TarExtractOutputValidationFailed
  StrCmp $R4 "process-timeout" 0 TarExtractNumericResult
  StrCmp $R2 "124" TarExtractTimeout TarExtractOutputValidationFailed
  TarExtractNumericResult:
  ; IntCmp tolerates trailing whitespace/CR that StrCmp would reject
  IntCmp $R2 0 TarExtractVerify TarExtractNonZero TarExtractNonZero

  TarExtractVerify:
  ; Success requires every large bundled resource to be usable -- an exit code
  ; alone must never trigger deletion of the only recovery source.
  IfFileExists "$INSTDIR\resources\cfmind\gateway-bundle.mjs" TarExtractVerifySkills
  IfFileExists "$INSTDIR\resources\cfmind\openclaw.mjs" TarExtractVerifySkills
  StrCpy $R5 "runtime-entry-missing"
  Goto TarExtractRequiredResourceMissing

  TarExtractVerifySkills:
  IfFileExists "$INSTDIR\resources\SKILLs\*.*" TarExtractVerifyPython
  StrCpy $R5 "skills-content-missing"
  Goto TarExtractRequiredResourceMissing

  TarExtractVerifyPython:
  IfFileExists "$INSTDIR\resources\python-win\python.exe" TarExtractSucceeded
  IfFileExists "$INSTDIR\resources\python-win\python3.exe" TarExtractSucceeded
  StrCpy $R5 "python-entry-missing"

  TarExtractRequiredResourceMissing:
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=tar-extract-error attempt_id=$lobsterInstallerAttemptId extractor=$R3 exit=$R2 reason=$R5-after-extract$\r$\n"
  FileClose $2
  ; A bogus system-tar success still gets a shot at the bundled extractor.
  ;
  ; /SD IDOK on this and the failure boxes below: NSIS shows MessageBox even
  ; in /S installs unless a silent default is declared, and the in-app update
  ; must never block on an orphan dialog.
  StrCmp $R3 "system-tar" TarExtractElectron
  MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI installation stopped because resource extraction completed without all required runtime resources ($R5). The installer will not commit a partial application. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
  Goto TarExtractFailed

  TarExtractProcessFailed:
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=tar-extract-error attempt_id=$lobsterInstallerAttemptId extractor=$R3 exit=$R2 raw_marker=$R4 elapsed_ms=$5 reason=process-start-failed$\r$\n"
    FileClose $2
    MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI installation stopped because the resource extractor could not be started (exit=$R2). The installer will not commit a partial application. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
    Goto TarExtractFailed

  TarExtractTimeout:
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=tar-extract-error attempt_id=$lobsterInstallerAttemptId extractor=$R3 exit=$R2 raw_marker=$R4 elapsed_ms=$5 reason=timeout$\r$\n"
    FileClose $2
    MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI installation stopped because resource extraction timed out after 10 minutes. The blocked extractor was terminated and the installer will not commit a partial application. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
    Goto TarExtractFailed

  TarExtractTerminationFailed:
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=tar-extract-error attempt_id=$lobsterInstallerAttemptId extractor=$R3 exit=$R2 raw_marker=$R4 elapsed_ms=$5 reason=process-termination-failed action=preserve-all-no-concurrent-rollback$\r$\n"
    FileClose $2
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
    MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI installation stopped because the extractor process could not be confirmed terminated. No automatic rollback or cleanup was attempted while that process may still be writing files. Restart Windows before retrying. Recovery files (if any): $lobsterOldInstallBackupPath. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
    SetErrorLevel 3
    Quit

  TarExtractOutputValidationFailed:
    ; The watchdog waited out the child but could not read its exit code. On
    ; machines where security tooling permanently breaks that query the child
    ; may still have succeeded, so consult its post-verify sentinel before
    ; declaring failure; TarExtractVerify still makes the final on-disk call.
    ; (Dual of the TarExtractVerify principle: just as an exit code alone must
    ; never trigger deletion, an unreadable exit code alone must never abort
    ; an installation whose payload verifiably exists.)
    IfFileExists "$INSTDIR\resources\.unpack-cfmind-ok" 0 TarExtractOutputValidationFatal
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=tar-extract-sentinel-rescue attempt_id=$lobsterInstallerAttemptId extractor=$R3 exit=$R2 raw_marker=$R4 elapsed_ms=$5 sentinel=present$\r$\n"
    FileClose $2
    Goto TarExtractVerify

  TarExtractOutputValidationFatal:
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=tar-extract-error attempt_id=$lobsterInstallerAttemptId extractor=$R3 exit=$R2 raw_marker=$R4 elapsed_ms=$5 reason=watchdog-output-validation-failed$\r$\n"
    FileClose $2
    MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI installation stopped because the resource extractor watchdog returned an invalid result. The installer will not commit a partial application. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
    Goto TarExtractFailed

  TarExtractNonZero:
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=tar-extract-error attempt_id=$lobsterInstallerAttemptId extractor=$R3 exit=$R2 raw_marker=$R4 elapsed_ms=$5 reason=numeric-child-exit$\r$\n"
    FileClose $2
    MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI installation stopped because resource extraction failed (child exit code $R2). The installer will not commit a partial application. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
    Goto TarExtractFailed

  TarExtractSucceeded:
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=tar-extract-complete attempt_id=$lobsterInstallerAttemptId extractor=$R3 exit=$R2$\r$\n"
  FileClose $2
  ; Completion marker, read by the app for install-integrity diagnostics.
  FileOpen $2 "$INSTDIR\resources\.win-resources-extracted" w
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 source=installer extractor=$R3$\r$\n"
  FileClose $2
  DetailPrint "[Installer] Bundled resources extraction complete"
  ; Only a verified success may delete these: the preserved archive is what
  ; lets the app finish an interrupted extraction at first launch. The
  ; sentinel has served its purpose once the install commits.
  Delete "$INSTDIR\resources\win-resources.tar"
  Delete "$INSTDIR\resources\unpack-cfmind.cjs"
  Delete "$INSTDIR\resources\.unpack-cfmind-ok"
  Goto TarExtractDone

  TarExtractFailed:
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=tar-extract-failed-archive-preserved attempt_id=$lobsterInstallerAttemptId extractor=$R3 exit=$R2 raw_marker=$R4 action=abort-install$\r$\n"
  FileClose $2
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
  !insertmacro customRollbackOldInstall "resource-extraction-failed"
  StrCmp $lobsterOldInstallRollbackStatus "failed" 0 TarExtractAbort
    MessageBox MB_OK|MB_ICONEXCLAMATION "The installation failed and automatic rollback did not complete. No recovery copy was deleted. Previous files: $lobsterOldInstallBackupPath. Partial update: $lobsterOldInstallFailedPath. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
  TarExtractAbort:
  SetErrorLevel 3
  Quit
  TarExtractDone:

  ; -- Restore user-created skills from AppData backup --
  ; The backup was created in customCheckAppRunning before extraction began.
  ; Restore any skills not already present in the new install, then clean up
  ; only this attempt's backup. A later attempt never consumes a historical
  ; fixed skills-backup directory.
  StrCmp $lobsterLegacySkillsStatus "legacy-backup-succeeded" 0 SkipSkillRestore
  System::Call 'kernel32::GetTickCount()i .r7'
  IfFileExists "$APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId\backup-manifest.json" SkillRestoreAttemptBackupReady
    StrCpy $R2 "backup-missing"
    StrCpy $1 "current-attempt-backup-manifest-missing"
    StrCpy $lobsterLegacySkillsRestoreStatus "legacy-restore-backup-missing"
    Goto SkillRestoreCommandDone

  SkillRestoreAttemptBackupReady:
    DetailPrint "[Installer] Restoring user-created skills"
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=skill-restore-start attempt_id=$lobsterInstallerAttemptId backup=$APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId$\r$\n"
    FileClose $2

    StrCmp $lobsterTrustedPowerShellPath "" SkillRestoreHelperMissing
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_SOURCE", t "$lobsterOldInstallOriginalPath\resources\SKILLs")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_BACKUP_ROOT", t "$APPDATA\LobsterAI\skills-backup")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_DESTINATION", t "$INSTDIR\resources\SKILLs")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ATTEMPT_ID", t "$lobsterInstallerAttemptId")i'
    Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "\
      $$ErrorActionPreference = \"Stop\";\
      $$attempt   = $$env:LOBSTERAI_INSTALL_ATTEMPT_ID;\
      $$root      = $$env:LOBSTERAI_SKILL_BACKUP_ROOT;\
      $$source    = $$env:LOBSTERAI_SKILL_SOURCE;\
      $$backup    = Join-Path $$root $$attempt;\
      $$newSkills = $$env:LOBSTERAI_SKILL_DESTINATION;\
      try {\
        if ([string]::IsNullOrWhiteSpace($$attempt)) { throw \"attempt id missing\" };\
        $$manifestPath = Join-Path $$backup \"backup-manifest.json\";\
        $$manifest = Get-Content -LiteralPath $$manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop;\
        if ($$manifest.schemaVersion -ne 1) { throw \"manifest schema mismatch\" };\
        if ($$manifest.attemptId -ne $$attempt) { throw \"manifest attempt mismatch\" };\
        if ($$manifest.source -ne $$source) { throw \"manifest source mismatch\" };\
        if ($$manifest.validation.status -ne \"verified\") { throw \"manifest not verified\" };\
        if ((Get-Content -LiteralPath (Join-Path $$backup \".attempt-id\") -Raw -ErrorAction Stop) -ne $$attempt) { throw \"attempt marker mismatch\" };\
        $$skills = @($$manifest.skills);\
        if ($$skills.Count -ne [int]$$manifest.statistics.skillCount) { throw \"manifest skill count mismatch\" };\
        if (@($$manifest.files).Count -ne [int]$$manifest.statistics.fileCount) { throw \"manifest file count mismatch\" };\
        if (@($$manifest.directories).Count -ne [int]$$manifest.statistics.directoryCount) { throw \"manifest directory count mismatch\" };\
        $$backupPrefix = [IO.Path]::GetFullPath($$backup).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar;\
        foreach ($$skill in $$skills) {\
          if ([string]::IsNullOrWhiteSpace($$skill) -or ([IO.Path]::GetFileName($$skill) -ne $$skill) -or ($$skill -eq \".\") -or ($$skill -eq \"..\")) { throw \"unsafe manifest skill name\" };\
          if (-not (Test-Path -LiteralPath (Join-Path $$backup $$skill) -PathType Container)) { throw \"manifest skill missing\" }\
        };\
        foreach ($$file in @($$manifest.files)) {\
          if ([IO.Path]::IsPathRooted($$file.path)) { throw \"rooted manifest path\" };\
          $$relative = $$file.path.Replace([char]47, [IO.Path]::DirectorySeparatorChar);\
          $$candidate = [IO.Path]::GetFullPath((Join-Path $$backup $$relative));\
          if (-not $$candidate.StartsWith($$backupPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw \"manifest path escaped backup\" };\
          $$top = @($$file.path.Split([char]47))[0];\
          if (($$file.path -ne \".attempt-id\") -and ($$skills -notcontains $$top)) { throw \"manifest file outside skill\" };\
          if (-not (Test-Path -LiteralPath $$candidate -PathType Leaf)) { throw \"manifest file missing\" };\
          if ((Get-FileHash -LiteralPath $$candidate -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $$file.sha256) { throw \"manifest hash mismatch\" }\
        };\
        New-Item -ItemType Directory -Path $$newSkills -Force -ErrorAction Stop | Out-Null;\
        $$conflicts = @($$skills | Where-Object { Test-Path -LiteralPath (Join-Path $$newSkills $$_) });\
        if ($$conflicts.Count -gt 0) {\
          Write-Output (\"name-conflict:\" + (($$conflicts | Sort-Object) -join \",\"));\
          exit 20\
        };\
        $$restored = 0;\
        $$restoredNames = @();\
        foreach ($$skill in $$skills) {\
          $$target = Join-Path $$newSkills $$skill;\
          if (-not (Test-Path -LiteralPath $$target)) {\
            Copy-Item -LiteralPath (Join-Path $$backup $$skill) -Destination $$target -Recurse -Force -ErrorAction Stop;\
            $$restoredNames += $$skill;\
            $$restored++\
          }\
        };\
        foreach ($$file in @($$manifest.files)) {\
          $$top = @($$file.path.Split([char]47))[0];\
          if ($$restoredNames -contains $$top) {\
            $$destinationFile = Join-Path $$newSkills ($$file.path.Replace([char]47, [IO.Path]::DirectorySeparatorChar));\
            if ((Get-FileHash -LiteralPath $$destinationFile -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $$file.sha256) { throw \"restored hash mismatch\" }\
          }\
        };\
        Remove-Item -LiteralPath $$backup -Recurse -Force -ErrorAction Stop;\
        Write-Output (\"restored:\" + $$restored + \" manifest-files:\" + $$manifest.statistics.fileCount);\
        exit 0\
      } catch {\
        exit 1\
      }"'
    !insertmacro LobsterExecHiddenToStack
    Pop $0
    Pop $1
    StrCpy $R2 $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_SOURCE", t "")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_BACKUP_ROOT", t "")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_SKILL_DESTINATION", t "")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ATTEMPT_ID", t "")i'
    Goto SkillRestoreCommandDone

    SkillRestoreHelperMissing:
    StrCpy $R2 "helper-not-found"
    StrCpy $1 "trusted-powershell-unavailable"
    StrCpy $lobsterLegacySkillsRestoreStatus "legacy-restore-helper-launch-failed"

    SkillRestoreCommandDone:
    StrCmp $R2 "0" 0 +2
      StrCpy $lobsterLegacySkillsRestoreStatus "legacy-restore-succeeded"
    StrCmp $R2 "20" 0 +2
      StrCpy $lobsterLegacySkillsRestoreStatus "legacy-restore-name-conflict"
    StrCmp $lobsterLegacySkillsRestoreStatus "not-required" 0 +2
      StrCpy $lobsterLegacySkillsRestoreStatus "legacy-restore-failed"
    System::Call 'kernel32::GetTickCount()i .r6'
    IntOp $5 $6 - $7
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=skill-restore-complete attempt_id=$lobsterInstallerAttemptId status=$lobsterLegacySkillsRestoreStatus exit=$R2 elapsed_ms=$5 backup=$APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId$\r$\n"
    FileWrite $2 "$8 phase=skill-restore-output attempt_id=$lobsterInstallerAttemptId status=$lobsterLegacySkillsRestoreStatus text=$1$\r$\n"
    FileClose $2

    StrCmp $R2 "0" SkillRestoreValidated
    StrCmp $R2 "20" SkillRestoreConflictPreserved
      FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $2 0 END
      !insertmacro GetTimestamp $8
      FileWrite $2 "$8 phase=skill-restore-failed attempt_id=$lobsterInstallerAttemptId status=legacy-restore-failed action=attempt-backup-preserved rename_status=$lobsterOldInstallRenameStatus$\r$\n"
      FileClose $2

      ; On the directory-swap path, restoring the previous application also
      ; restores its original in-place skills. The AppData copy remains as an
      ; additional recovery source because the PowerShell transaction deletes
      ; it only after every skill copy succeeds.
      StrCmp $lobsterOldInstallRenameStatus "success" 0 SkillRestoreFailurePreserved
      System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
      !insertmacro customRollbackOldInstall "skill-restore-failed"
      StrCmp $lobsterOldInstallRollbackStatus "success" SkillRestoreRollbackSucceeded
        MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI update could not restore user skills, and automatic rollback did not complete. No recovery copy was deleted. Previous files: $lobsterOldInstallBackupPath. Partial update: $lobsterOldInstallFailedPath. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
        Goto SkillRestoreAbort
      SkillRestoreRollbackSucceeded:
        MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI update could not restore user skills, so the previous version was restored. Please retry the update. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      SkillRestoreAbort:
      SetErrorLevel 2
      Quit

    SkillRestoreFailurePreserved:
      ; The stock-uninstaller fallback has no intact directory to roll back.
      ; Preserve P0 compatibility: keep the usable new payload and continue to
      ; registration, but record an explicit degraded state for retry/manual
      ; recovery. The dialog must state exactly what survives: when no backup
      ; exists for this attempt, do not claim one was preserved.
      StrCmp $lobsterLegacySkillsRestoreStatus "legacy-restore-backup-missing" SkillRestoreDegradedBackupMissing
      FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $2 0 END
      !insertmacro GetTimestamp $8
      FileWrite $2 "$8 phase=skill-restore-degraded attempt_id=$lobsterInstallerAttemptId status=$lobsterLegacySkillsRestoreStatus action=continue-with-attempt-backup-preserved backup=$APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId$\r$\n"
      FileClose $2
      MessageBox MB_OK|MB_ICONEXCLAMATION "LobsterAI will finish installing, but legacy user skills could not be restored automatically ($lobsterLegacySkillsRestoreStatus). The recovery backup was preserved at $APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      Goto SkillRestoreValidated

    SkillRestoreDegradedBackupMissing:
      ; No backup exists for this attempt, so nothing could be restored and
      ; there is no preserved copy to point the user at.
      FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $2 0 END
      !insertmacro GetTimestamp $8
      FileWrite $2 "$8 phase=skill-restore-degraded attempt_id=$lobsterInstallerAttemptId status=$lobsterLegacySkillsRestoreStatus action=continue-no-backup-found backup=$APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId$\r$\n"
      FileClose $2
      MessageBox MB_OK|MB_ICONEXCLAMATION "LobsterAI will finish installing, but the recovery backup for legacy user skills was not found, so no skills were restored ($lobsterLegacySkillsRestoreStatus). Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      Goto SkillRestoreValidated

    SkillRestoreConflictPreserved:
      ; A same-name entry in the new tree must never cause the user's only
      ; copy to be overwritten or deleted. Finish installing the verified new
      ; app, retain the entire attempt backup, and expose a typed state for
      ; user-context import/manual recovery.
      FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
      FileSeek $2 0 END
      !insertmacro GetTimestamp $8
      FileWrite $2 "$8 phase=skill-restore-conflict-preserved attempt_id=$lobsterInstallerAttemptId status=name-conflict action=attempt-backup-preserved backup=$APPDATA\LobsterAI\skills-backup\$lobsterInstallerAttemptId$\r$\n"
      FileClose $2
    SkillRestoreValidated:
  SkipSkillRestore:

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'

  ; The unpack script is deleted in TarExtractSucceeded above; after a failed
  ; extraction it is intentionally kept alongside win-resources.tar.

  ; -- Rebalance Defender exclusions now that extraction is done --
  ; One helper launch does both halves. First, unconditionally remove the
  ; install-scope whole-directory entry (also the leftover of an interrupted
  ; install -- the entry path is always $INSTDIR, so this step self-heals it)
  ; and the SKILLs entry older installers added. Then, unless the
  ; /NoDefenderExclusion opt-out is present (the removals never are), re-add
  ; the permanent entries.
  ;
  ; Besides the three runtime trees, the permanent set PRE-PROVISIONS the two
  ; biggest single files of the NEXT upgrade: win-resources.tar and app.asar.
  ; Field finding (EICAR-verified on a machine where install-time exclusions
  ; never worked): Defender applies newly added exclusions asynchronously,
  ; minutes later -- entries added mid-install protect nothing, while entries
  ; that have been sitting since the previous install are fully honored.
  ; Risk: the tar path points at a file that only exists during an install,
  ; and app.asar is the same trust class as the already-excluded
  ; app.asar.unpacked. SKILLs stays scannable (user-writable, agent-executed).
  !insertmacro ResolveTrustedPowerShell
  StrCpy $R7 "1"
  ${GetParameters} $R9
  ClearErrors
  ${GetOptions} $R9 "/NoDefenderExclusion" $R8
  IfErrors +2
    StrCpy $R7 "0"
  StrCmp $lobsterTrustedPowerShellPath "" DefenderRebalanceHelperMissing
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ROOT", t "$INSTDIR")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_DEFENDER_ADD_PERMANENT", t "$R7")i'
  Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "\
    $$root = $$env:LOBSTERAI_INSTALL_ROOT;\
    try { $$trimTargets = @($$root, (Join-Path $$root \"resources\SKILLs\")); Remove-MpPreference -ExclusionPath $$trimTargets -ErrorAction SilentlyContinue; $$trim = \"removed\" } catch { $$trim = \"failed:\" + $$_.Exception.Message.Trim() };\
    if ($$env:LOBSTERAI_DEFENDER_ADD_PERMANENT -ne \"1\") { $$permanent = \"skipped:opt-out\" } else {\
      try { $$addTargets = @((Join-Path $$root \"resources\cfmind\"), (Join-Path $$root \"resources\python-win\"), (Join-Path $$root \"resources\app.asar.unpacked\"), (Join-Path $$root \"resources\app.asar\"), (Join-Path $$root \"resources\win-resources.tar\")); Add-MpPreference -ExclusionPath $$addTargets -ErrorAction Stop; $$permanent = \"added\" } catch { $$permanent = \"skipped:\" + $$_.Exception.Message.Trim() }\
    };\
    Write-Output (\"trim=\" + $$trim + \" permanent=\" + $$permanent)"'
  !insertmacro LobsterExecHiddenToStack
  Pop $0
  Pop $1
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_DEFENDER_ADD_PERMANENT", t "")i'
  Goto DefenderRebalanceLog
  DefenderRebalanceHelperMissing:
  StrCpy $0 "helper-not-found"
  StrCpy $1 "skipped:trusted-powershell-unavailable"
  DefenderRebalanceLog:
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=defender-exclusion-rebalance-complete attempt_id=$lobsterInstallerAttemptId permanent_requested=$R7 exit=$0 output=$1$\r$\n"
  FileClose $2

  ; Validate every scenario before electron-builder writes new registration
  ; or shortcuts. The archive and unpack script are diagnostic recovery
  ; material, never a successful validation condition.
  StrCpy $lobsterNewInstallValidationStatus "failed"
  StrCpy $lobsterNewInstallValidationReason "app-executable-missing"
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 NewInstallPrevalidateFailed
  StrCpy $lobsterNewInstallValidationReason "uninstaller-missing"
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" 0 NewInstallPrevalidateFailed
  StrCpy $lobsterNewInstallValidationReason "app-asar-missing"
  IfFileExists "$INSTDIR\resources\app.asar" 0 NewInstallPrevalidateFailed

  IfFileExists "$INSTDIR\resources\cfmind\gateway-bundle.mjs" NewInstallPrevalidateSkills
  IfFileExists "$INSTDIR\resources\cfmind\openclaw.mjs" NewInstallPrevalidateSkills
  StrCpy $lobsterNewInstallValidationReason "runtime-entry-missing"
  Goto NewInstallPrevalidateFailed

  NewInstallPrevalidateSkills:
    StrCpy $lobsterNewInstallValidationReason "skills-content-missing"
    IfFileExists "$INSTDIR\resources\SKILLs\*.*" 0 NewInstallPrevalidateFailed
    StrCpy $lobsterNewInstallValidationReason "python-entry-missing"
    IfFileExists "$INSTDIR\resources\python-win\python.exe" NewInstallPrevalidateSucceeded
    IfFileExists "$INSTDIR\resources\python-win\python3.exe" NewInstallPrevalidateSucceeded
    Goto NewInstallPrevalidateFailed

  NewInstallPrevalidateSucceeded:
    StrCpy $lobsterNewInstallValidationStatus "success"
    StrCpy $lobsterNewInstallValidationReason "new-install-runtime-ready"
    StrCmp $lobsterOldInstallRenameStatus "success" 0 NewInstallPrevalidateLog
      StrCpy $lobsterOldInstallRenameStatus "prevalidated"
    NewInstallPrevalidateLog:
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=new-install-prevalidated attempt_id=$lobsterInstallerAttemptId status=$lobsterNewInstallValidationStatus reason=$lobsterNewInstallValidationReason rename_status=$lobsterOldInstallRenameStatus registration=pending backup_path=$lobsterOldInstallBackupPath$\r$\n"
    FileClose $2
    Goto NewInstallPrevalidateDone

  NewInstallPrevalidateFailed:
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=new-install-prevalidation-failed attempt_id=$lobsterInstallerAttemptId status=$lobsterNewInstallValidationStatus reason=$lobsterNewInstallValidationReason rename_status=$lobsterOldInstallRenameStatus registration=not-written backup_path=$lobsterOldInstallBackupPath$\r$\n"
    FileClose $2
    StrCmp $lobsterOldInstallRenameStatus "success" 0 NewInstallPrevalidateAbort
    !insertmacro customRollbackOldInstall "new-install-validation-failed"
    StrCmp $lobsterOldInstallRollbackStatus "success" NewInstallPrevalidateRollbackSucceeded
      MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI update could not be validated, and automatic rollback did not complete. No recovery copy was deleted. Previous files: $lobsterOldInstallBackupPath. Partial update: $lobsterOldInstallFailedPath. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      Goto NewInstallPrevalidateAbortAfterMessage
    NewInstallPrevalidateRollbackSucceeded:
      MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI update could not be validated, so the previous version was restored. Please retry the update. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
      Goto NewInstallPrevalidateAbortAfterMessage
    NewInstallPrevalidateAbort:
      MessageBox MB_OK|MB_ICONEXCLAMATION "The LobsterAI installation stopped because the new application could not be validated ($lobsterNewInstallValidationReason). New registration and shortcuts were not written. Details: $APPDATA\LobsterAI\install-timing.log" /SD IDOK
    NewInstallPrevalidateAbortAfterMessage:
    SetErrorLevel 2
    Quit

  NewInstallPrevalidateDone:
!macroend

; Standard post-registry electron-builder hook. All fallible extraction,
; restoration, Defender rebalancing and validation completed in
; customBeforeRegistryAddInstallInfo. This hook only commits the already
; prevalidated directory swap and schedules exact-current-backup cleanup.
!macro customInstall
  StrCmp $lobsterNewInstallValidationStatus "success" 0 InstallFinalizeInvariantFailed
  StrCmp $lobsterOldInstallRenameStatus "prevalidated" 0 InstallFinalizeNoRename
    StrCpy $lobsterOldInstallRenameStatus "committed"
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=old-install-commit-complete attempt_id=$lobsterInstallerAttemptId status=$lobsterNewInstallValidationStatus reason=$lobsterNewInstallValidationReason registration=written backup_path=$lobsterOldInstallBackupPath$\r$\n"
    FileClose $2
  InstallFinalizeNoRename:

  ; A successful rename keeps the old tree intact during extraction. Only a
  ; validated commit may schedule deletion, and only for this run's exact
  ; backup path. Older interrupted backups remain untouched for recovery.
  ; Pass the path through the environment to avoid shell interpretation of a
  ; user-selected install directory. The detached launch is asynchronous (and,
  ; unlike NSIS Exec, creates no console window), so this phase is
  ; "scheduled", not complete.
  ${If} $lobsterOldInstallRenameStatus == "committed"
    StrCpy $0 "success"
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_OLD_CLEANUP_PATH", t "$lobsterOldInstallBackupPath")i'
    ClearErrors
    StrCmp $lobsterTrustedPowerShellPath "" OldInstallCleanupHelperMissing
    Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath $$env:LOBSTERAI_OLD_CLEANUP_PATH -Recurse -Force -ErrorAction SilentlyContinue"'
    !insertmacro LobsterExecHiddenDetached
    IfErrors 0 +2
      StrCpy $0 "launch-failed"
    Goto OldInstallCleanupDispatchDone
    OldInstallCleanupHelperMissing:
      StrCpy $0 "helper-not-found"
    OldInstallCleanupDispatchDone:
    System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_OLD_CLEANUP_PATH", t "")i'
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=old-install-cleanup-scheduled attempt_id=$lobsterInstallerAttemptId dispatch=$0 backup_path=$lobsterOldInstallBackupPath target=exact-current-backup cleanup_mode=async-exec-after-commit$\r$\n"
    FileClose $2
  ${EndIf}
  Goto InstallFinalizeComplete

  InstallFinalizeInvariantFailed:
    ; The version-pinned template contract guarantees the pre-registry hook.
    ; Fail visibly if that contract is ever broken instead of silently
    ; finalizing an unvalidated tree.
    FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
    FileSeek $2 0 END
    !insertmacro GetTimestamp $8
    FileWrite $2 "$8 phase=install-finalize-invariant-failed attempt_id=$lobsterInstallerAttemptId validation_status=$lobsterNewInstallValidationStatus rename_status=$lobsterOldInstallRenameStatus$\r$\n"
    FileClose $2
    SetErrorLevel 2
    Quit

  InstallFinalizeComplete:
  FileOpen $2 "$APPDATA\LobsterAI\install-timing.log" a
  FileSeek $2 0 END
  !insertmacro GetTimestamp $8
  FileWrite $2 "$8 phase=install-complete attempt_id=$lobsterInstallerAttemptId scenario=$lobsterInstallScenario$\r$\n"
  FileClose $2
  DetailPrint "[Installer] Installation complete"

!macroend

; customUnInit intentionally not defined: the uninstaller stops app processes
; through customCheckAppRunning above, which the template invokes after the
; user confirms the uninstall (assisted mode) or immediately for silent /S
; uninstalls. Merely opening the uninstaller no longer kills the running app.

!macro customUnInstall
  ; -- Remove Windows Defender Exclusion on uninstall --
  ; Clean up every exclusion any installer version may have added: the
  ; current permanent set, the SKILLs entry from older versions, the
  ; single-file entries from the path-list era, and the install-scope
  ; whole-directory entry in case an install was interrupted before its
  ; rebalance step ran.
  !insertmacro ResolveTrustedPowerShell
  StrCmp $lobsterTrustedPowerShellPath "" DefenderUninstallCleanupDone
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ROOT", t "$INSTDIR")i'
  Push '"$lobsterTrustedPowerShellPath" -NoProfile -NonInteractive -Command "try { $$root = $$env:LOBSTERAI_INSTALL_ROOT; $$targets = @($$root, (Join-Path $$root \"resources\cfmind\"), (Join-Path $$root \"resources\python-win\"), (Join-Path $$root \"resources\SKILLs\"), (Join-Path $$root \"resources\app.asar.unpacked\"), (Join-Path $$root \"resources\win-resources.tar\"), (Join-Path $$root \"resources\app.asar\")); Remove-MpPreference -ExclusionPath $$targets -ErrorAction SilentlyContinue } catch {}"'
  !insertmacro LobsterExecHiddenToStack
  Pop $0
  Pop $1
  System::Call 'Kernel32::SetEnvironmentVariable(t "LOBSTERAI_INSTALL_ROOT", t "")i'
  DefenderUninstallCleanupDone:
!macroend
