; Paired with src/shared/analytics/uninstall.ts. Only query data is read from
; the user's profile: the HTTPS destination is fixed in the signed uninstaller.
!define LOBSTER_UNINSTALL_ANALYTICS_FILE "uninstall-analytics.ini"
!define LOBSTER_UNINSTALL_ANALYTICS_SECTION "uninstall"
!define LOBSTER_UNINSTALL_ANALYTICS_SCHEMA "1"
!define LOBSTER_UNINSTALL_ANALYTICS_ENDPOINT "https://rlogs.youdao.com/rlog.php"

!ifdef BUILD_UNINSTALLER
  Var lobsterUninstallAnalyticsQuery
  Var lobsterUninstallAnalyticsPath
!endif

; Called after confirmation/process shutdown and before files or --delete-app-data
; are removed. Keep the snapshot in memory, including for all-users installs
; (Electron data is still per-user). A different Windows account has no snapshot
; and is deliberately not assigned the original user's UUID.
!macro LobsterPrepareUninstallAnalytics
  Push $0
  Push $1
  StrCpy $lobsterUninstallAnalyticsQuery ""
  StrCpy $lobsterUninstallAnalyticsPath ""
  ${IfNot} ${isUpdated}
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 LobsterUninstallAnalyticsPrepared
    SetShellVarContext current
    StrCpy $lobsterUninstallAnalyticsPath "$APPDATA\LobsterAI\${LOBSTER_UNINSTALL_ANALYTICS_FILE}"
    ReadINIStr $0 "$lobsterUninstallAnalyticsPath" "${LOBSTER_UNINSTALL_ANALYTICS_SECTION}" "schema_version"
    StrCmp $0 "${LOBSTER_UNINSTALL_ANALYTICS_SCHEMA}" 0 LobsterUninstallAnalyticsRestoreContext
    ReadINIStr $0 "$lobsterUninstallAnalyticsPath" "${LOBSTER_UNINSTALL_ANALYTICS_SECTION}" "install_directory"
    GetFullPathName $1 "$INSTDIR"
    StrCmp $0 $1 0 LobsterUninstallAnalyticsRestoreContext
    ReadINIStr $lobsterUninstallAnalyticsQuery "$lobsterUninstallAnalyticsPath" "${LOBSTER_UNINSTALL_ANALYTICS_SECTION}" "query"
    ; Fail closed on a truncated ReadINIStr; reserve space for the dynamic suffix.
    StrLen $0 $lobsterUninstallAnalyticsQuery
    IntOp $1 ${NSIS_MAX_STRLEN} - 512
    ${If} $0 > $1
      StrCpy $lobsterUninstallAnalyticsQuery ""
    ${EndIf}
    LobsterUninstallAnalyticsRestoreContext:
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
  LobsterUninstallAnalyticsPrepared:
  ClearErrors
  Pop $1
  Pop $0
!macroend

; Runs at the end of customUnInstall, after the stock file/registry removal.
; Opening/cancelling, --updated, and a failed removal of the executable/asar
; cannot emit a completed uninstall. No application process is started here.
!macro LobsterReportUninstallAnalytics
  Push $0
  Push $1
  Push $2
  Push $3
  ${If} ${isUpdated}
    Goto LobsterUninstallAnalyticsDone
  ${EndIf}
  StrCmp $lobsterUninstallAnalyticsQuery "" LobsterUninstallAnalyticsDone
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" LobsterUninstallAnalyticsDone
  IfFileExists "$INSTDIR\resources\app.asar" LobsterUninstallAnalyticsDone
  InitPluginsDir
  ; FILETIME is UTC, in 100ns since 1601. Convert to Unix milliseconds using
  ; 64-bit math so daily counts use the same uts contract as app analytics.
  System::Call 'kernel32::GetSystemTimeAsFileTime(*l .r0)'
  System::Int64Op $0 / 10000
  Pop $0
  System::Int64Op $0 - 11644473600000
  Pop $0
  System::Call 'ole32::CoCreateGuid(g .s)'
  Pop $1
  ; System's GUID representation includes braces; the reporter uses bare UUIDs.
  StrCpy $1 $1 36 1
  StrCpy $2 "false"
  IfSilent 0 +2
    StrCpy $2 "true"
  StrCpy $3 "${LOBSTER_UNINSTALL_ANALYTICS_ENDPOINT}?$lobsterUninstallAnalyticsQuery&app_version=${VERSION}&eventId=$1&uts=$0&silent=$2"
  ; Use the already-bundled HTTPS client. No UI, cookies, retries or relaxed
  ; certificate checks. Network failure never changes the uninstall result.
  inetc::get /SILENT /NOCOOKIES /CONNECTTIMEOUT 3 /RECEIVETIMEOUT 3 "$3" "$PLUGINSDIR\uninstall-analytics-response" /END
  Pop $0
  Delete "$PLUGINSDIR\uninstall-analytics-response"
  ; A second invocation of a copied uninstaller must not reuse this snapshot.
  Delete "$lobsterUninstallAnalyticsPath"
  StrCpy $lobsterUninstallAnalyticsQuery ""
  LobsterUninstallAnalyticsDone:
  ClearErrors
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
