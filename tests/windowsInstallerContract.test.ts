import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const repoFile = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const installerInclude = repoFile('scripts/nsis-installer.nsh');
const unpackScript = repoFile('scripts/unpack-cfmind.cjs');
const installSection = repoFile(
  'node_modules/app-builder-lib/templates/nsis/installSection.nsh',
);
const extractTemplate = repoFile(
  'node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh',
);
const installerTemplate = repoFile(
  'node_modules/app-builder-lib/templates/nsis/include/installer.nsh',
);
const rootInstallerTemplate = repoFile(
  'node_modules/app-builder-lib/templates/nsis/installer.nsi',
);
const webPackageTemplate = repoFile(
  'node_modules/app-builder-lib/templates/nsis/include/webPackage.nsh',
);
const multiUserTemplate = repoFile(
  'node_modules/app-builder-lib/templates/nsis/multiUser.nsh',
);
const differentialUpdateInfoBuilder = repoFile(
  'node_modules/app-builder-lib/out/targets/differentialUpdateInfoBuilder.js',
);
const appBuilderPatch = repoFile('patches/app-builder-lib+24.13.3.patch');
const gateScript = repoFile('scripts/verify-installer-patches.cjs');
const webBuildScript = repoFile('scripts/dist-win-web.cjs');
const builderHooks = repoFile('scripts/electron-builder-hooks.cjs');
const packageScripts = (JSON.parse(repoFile('package.json')) as { scripts: Record<string, string> })
  .scripts;
const electronBuilderConfig = JSON.parse(repoFile('electron-builder.json')) as {
  nsis?: { deleteAppDataOnUninstall?: boolean };
};

const classifyFreshTarget = ({
  hasRegistrationEvidence,
  entries,
  enumerationError,
}: {
  hasRegistrationEvidence: boolean;
  entries?: string[];
  enumerationError?: number;
}): 'fresh-install' | 'possible-existing' => {
  if (hasRegistrationEvidence) {
    return 'possible-existing';
  }
  if (enumerationError !== undefined) {
    return enumerationError === 2 || enumerationError === 18
      ? 'fresh-install'
      : 'possible-existing';
  }
  return entries?.some((entry) => entry !== '.' && entry !== '..')
    ? 'possible-existing'
    : 'fresh-install';
};

describe('Windows installer hardening contracts', () => {
  test('can force channel double-click installs into silent mode before init logging', () => {
    const start = installerInclude.indexOf('!macro customInit');
    const end = installerInclude.indexOf('!macroend', start);
    const init = installerInclude.slice(start, end);
    const setSilent = init.indexOf('SetSilent silent');
    const initLog = init.indexOf('phase=custom-init-start');

    expect(installerInclude).toContain('Var lobsterSilentSource');
    expect(init).toContain('$%LOBSTERAI_CHANNEL_BUILD%');
    expect(init).toContain('$%LOBSTERAI_SILENT_ON_DOUBLE_CLICK%');
    expect(init).toContain('StrCpy $lobsterSilentSource "argv"');
    expect(init).toContain('StrCpy $lobsterSilentSource "build-flag"');
    expect(init).toContain('${If} ${isUpdated}');
    expect(init).toContain('silent_source=$lobsterSilentSource');
    expect(setSilent).toBeGreaterThan(-1);
    expect(initLog).toBeGreaterThan(setSilent);
  });

  test('keeps silent installs free of installer-owned UI', () => {
    // /S is a zero-UI contract: app stores and IT deployment drive silent
    // installs with their own progress experience, so the installer may not
    // own any window and every dialog needs a silent default.
    expect(installerInclude).not.toContain('Banner::');
    expect(installerInclude).not.toContain('LOBSTERAI_HIDE_SILENT_BANNER');

    const messageBoxLines = installerInclude
      .split('\n')
      .filter((line) => line.includes('MessageBox'));
    expect(messageBoxLines.length).toBeGreaterThan(0);
    for (const line of messageBoxLines) {
      expect(line).toContain('/SD');
    }
  });

  test('releases the installer current-directory lock before the update rename', () => {
    const switchOutPath = installerInclude.indexOf('SetOutPath "$PLUGINSDIR"');
    const rename = installerInclude.indexOf(
      'MoveFileW(w "$lobsterOldInstallOriginalPath", w "$lobsterOldInstallBackupPath")',
    );

    expect(switchOutPath).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(switchOutPath);
    expect(installerInclude).toContain('${IfNot} ${isUpdated}');
    expect(installerInclude).toContain('"install-location-mismatch"');
    expect(installerInclude).toContain('"ambiguous-dual-registration"');
    expect(installerInclude).toContain('phase=old-install-rename-attempt');
    expect(installerInclude).toContain('phase=old-install-rename-complete attempt_id=');
    expect(installerInclude).toContain('status=$lobsterOldInstallRenameStatus');
    expect(installerInclude).not.toContain('phase=old-install-cleanup-complete');
  });

  test('captures shortcut state before rename and explicitly controls old uninstallers', () => {
    const shortcutProbe = installSection.indexOf('Var /GLOBAL keepShortcuts');
    const checkAppRunning = installSection.indexOf('!insertmacro CHECK_APP_RUNNING');
    const oldUninstaller = installSection.indexOf(
      '!insertmacro customUninstallOldVersion SHELL_CONTEXT',
    );
    const postUninstallHook = installSection.indexOf(
      '!insertmacro customAfterUninstallOldVersions',
    );
    const installFiles = installSection.indexOf('!insertmacro installApplicationFiles');

    expect(shortcutProbe).toBeGreaterThan(-1);
    expect(shortcutProbe).toBeLessThan(checkAppRunning);
    expect(oldUninstaller).toBeGreaterThan(checkAppRunning);
    expect(postUninstallHook).toBeGreaterThan(oldUninstaller);
    expect(postUninstallHook).toBeLessThan(installFiles);
    expect(installerInclude).toContain('phase=old-uninstaller-skipped');
    expect(installerInclude).toContain('phase=old-uninstaller-start');
    expect(installerInclude).toContain('phase=old-uninstaller-returned');
    expect(installerInclude).toContain('phase=old-uninstaller-complete');
  });

  test('applies and verifies Defender exclusion only after legacy uninstallers', () => {
    expect(installerInclude).toContain('!macro customAfterUninstallOldVersions');
    expect(installerInclude).toContain('point=post-old-uninstaller');
    expect(installerInclude).toContain(
      String.raw`$$target = $$env:LOBSTERAI_INSTALL_ROOT;`,
    );
    expect(installerInclude).toContain('before_count=');
    expect(installerInclude).toContain('remove=');
    expect(installerInclude).toContain('after_count=');
    expect(installerInclude).toContain('Remove-MpPreference -ExclusionPath $$targets');
    expect(installerInclude).toContain('phase=old-install-cleanup-scheduled');
    expect(installerInclude).toContain(
      '${If} $lobsterOldInstallRenameStatus == "committed"',
    );
    expect(installerInclude).toContain('target=exact-current-backup');
    expect(installerInclude).not.toContain('target_pattern=$INSTDIR.old');
    expect(installerInclude.indexOf('phase=old-install-cleanup-scheduled')).toBeGreaterThan(
      installerInclude.indexOf('phase=defender-exclusion-permanent-complete'),
    );
  });

  test('splits embedded package extraction, copying, cache, and size phases', () => {
    expect(extractTemplate).toContain('customAppPackageMaterializeStart');
    expect(extractTemplate).toContain('customAppPackageMaterializeEnd');
    expect(extractTemplate).toContain('customAppPackageExtractStart "staging" "${FILE}"');
    expect(extractTemplate).toContain('customAppPackageExtractEnd "staging" "unchecked"');
    expect(extractTemplate).toContain('customAppPackageCopyStart');
    expect(extractTemplate).toContain('customAppPackageCopyEnd "success"');
    expect(extractTemplate).toContain('customAppPackageCopyEnd "error"');
    expect(installerTemplate).toContain('customInstallerCacheCopyStart "installer"');
    expect(installerTemplate).toContain('customInstallerCacheCopyEnd "installer" "success"');
    expect(installerTemplate).toContain('customEstimatedSizeKnown');
    expect(installerTemplate).toContain('customEstimatedSizeScanStart');
    expect(installerTemplate).toContain('customEstimatedSizeScanEnd "$0"');

    const copyStart = extractTemplate.indexOf('customAppPackageCopyStart');
    const clearErrors = extractTemplate.indexOf('ClearErrors', copyStart);
    const copyFiles = extractTemplate.indexOf('CopyFiles /SILENT', copyStart);
    const copyErrorCheck = extractTemplate.indexOf('IfErrors CopyExtract7zaFailed', copyStart);
    expect(clearErrors).toBeGreaterThan(copyStart);
    expect(clearErrors).toBeLessThan(copyFiles);
    expect(copyFiles).toBeLessThan(copyErrorCheck);
  });

  test('rolls a renamed installation back before every controlled failure exit', () => {
    expect(installerInclude).toContain('Function lobsterRollbackOldInstall');
    expect(installerInclude).toContain('phase=old-install-rollback-start');
    expect(installerInclude).toContain('phase=old-install-rollback-complete');
    expect(installerInclude).toContain('phase=old-install-commit-complete');
    expect(installerInclude).toContain('phase=skill-backup-failed-abort');
    expect(installerInclude).toContain('phase=skill-restore-failed');
    expect(installerInclude).toContain(
      'StrCmp $lobsterOldInstallRollbackStatus "success"',
    );
    expect(installerInclude).toContain('!macro customBeforeInstallerQuit REASON');
    expect(rootInstallerTemplate).toContain('!define MUI_CUSTOMFUNCTION_ABORT');
    expect(rootInstallerTemplate).toContain('Function .onInstFailed');
    expect(extractTemplate).toContain(
      '!insertmacro customBeforeInstallerQuit "payload-copy-aborted"',
    );
    expect(webPackageTemplate).toContain(
      '!insertmacro customBeforeInstallerQuit "web-package-download-cancelled"',
    );

    const commit = installerInclude.indexOf('phase=old-install-commit-complete');
    const cleanup = installerInclude.indexOf('phase=old-install-cleanup-scheduled');
    expect(commit).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(commit);
  });

  test('gates every Windows installer build on applied patches and these contracts', () => {
    // The NSIS fixes live in patches/ and only reach node_modules via
    // patch-package (postinstall). A build machine that pulled a newer patch
    // without reinstalling would ship an installer without the fixes, so
    // dist:win and the web stub-only pass both run the gate first.
    expect(packageScripts['verify:installer-patches']).toBe(
      'node scripts/verify-installer-patches.cjs',
    );
    expect(packageScripts['dist:win'].startsWith('npm run verify:installer-patches && ')).toBe(
      true,
    );
    expect(gateScript).toContain("'--error-on-fail'");
    expect(gateScript).toContain("path.join('tests', 'windowsInstallerContract.test.ts')");
    expect(gateScript).toContain('process.exit(1)');

    const gateCall = webBuildScript.indexOf("'verify-installer-patches.cjs'");
    const builderSpawn = webBuildScript.indexOf('const result = spawnSync(command, args, {');
    expect(gateCall).toBeGreaterThan(-1);
    expect(builderSpawn).toBeGreaterThan(gateCall);
    expect(webBuildScript.slice(gateCall, builderSpawn)).toContain('process.exit(gate.status ?? 1)');
  });

  test('resolves the per-user install dir without a fixed-size struct read', () => {
    // electron-builder#7921: setInstallModePerUser used to fetch
    // SHGetKnownFolderPath(FOLDERID_UserProgramFiles) and read the returned
    // ~100-byte CoTaskMem string as an NSIS_MAX_STRLEN-wide struct (16KB with
    // the 8192-char build), faulting in System.dll+0x1581 on fresh per-user
    // installs whenever the following page was unmapped. The value was
    // discarded anyway (System::Store L restored $0), so the block is gone.
    const macroStart = multiUserTemplate.indexOf('!macro setInstallModePerUser');
    const macroEnd = multiUserTemplate.indexOf('!macroend', macroStart);
    expect(macroStart).toBeGreaterThan(-1);
    const stripComments = (text: string): string =>
      text
        .split(/\r?\n/)
        .filter((line) => !/^\s*[#;]/.test(line))
        .join('\n');
    const macroCode = stripComments(multiUserTemplate.slice(macroStart, macroEnd));
    expect(macroCode).not.toContain('SHGetKnownFolderPath');
    expect(macroCode).not.toContain('System::Store');
    expect(macroCode).not.toContain("System::Call '*");
    expect(macroCode).toContain('StrCpy $0 "$LocalAppData\\Programs"');
    expect(macroCode).toContain('StrCpy $INSTDIR "$0\\${APP_FILENAME}"');

    // No fixed-size struct read of a foreign pointer anywhere in the template.
    expect(stripComments(multiUserTemplate)).not.toContain('(&w${NSIS_MAX_STRLEN}');

    expect(appBuilderPatch).toContain('templates/nsis/multiUser.nsh');
    expect(appBuilderPatch).toContain('-      System::Store S');
    expect(appBuilderPatch).toContain("-        System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'");
  });

  test('does not block silent web installs on a download failure prompt', () => {
    const failureMessage = webPackageTemplate
      .split(/\r?\n/)
      .find((line) => line.includes('Messagebox MB_RETRYCANCEL|MB_ICONEXCLAMATION'));

    expect(failureMessage).toContain('/SD IDCANCEL IDRETRY download');
    expect(appBuilderPatch).toContain('/SD IDCANCEL IDRETRY download');
  });

  test('hardens the web download against hangs and fake success', () => {
    // Every inetc transfer carries explicit WinINet timeouts; without them a
    // half-open connection blocks the transfer thread forever and the
    // installer sits at 0% CPU with no way to finish.
    const inetcCalls = webPackageTemplate
      .split(/\r?\n/)
      .filter((line) => line.includes('inetc::get'));
    expect(inetcCalls).toHaveLength(2);
    for (const call of inetcCalls) {
      expect(call).toContain('/CONNECTTIMEOUT 30 /RECEIVETIMEOUT 60');
    }

    // Silent installs must never reach the retry dialog: the failure branch
    // retries a bounded number of times under ${Silent} and keeps the dialog
    // in the non-silent branch only.
    const failureBranch = webPackageTemplate.slice(
      webPackageTemplate.indexOf('${elseif} $0 != "OK"'),
      webPackageTemplate.indexOf('ShowWindow $R9 5'),
    );
    const silentGuard = failureBranch.indexOf('${if} ${Silent}');
    const boundedRetry = failureBranch.indexOf('$webDownloadAttempt < 3');
    const interactiveBranch = failureBranch.indexOf('${else}');
    const retryDialog = failureBranch.indexOf('Messagebox MB_RETRYCANCEL');
    expect(silentGuard).toBeGreaterThan(-1);
    expect(boundedRetry).toBeGreaterThan(silentGuard);
    expect(interactiveBranch).toBeGreaterThan(boundedRetry);
    expect(retryDialog).toBeGreaterThan(interactiveBranch);

    // A failed download exits with code 4 (set after the dialog, before the
    // quit hook) so the invoking channel can tell failure from the default
    // Quit code 0; a user cancel exits with the NSIS convention 1.
    const failureExitCode = failureBranch.indexOf('SetErrorLevel 4');
    const failureQuitHook = failureBranch.indexOf(
      '!insertmacro customBeforeInstallerQuit "web-package-download-failed"',
    );
    expect(failureExitCode).toBeGreaterThan(retryDialog);
    expect(failureQuitHook).toBeGreaterThan(failureExitCode);
    const cancelledBranches = webPackageTemplate
      .split('${if} $0 == "Cancelled"')
      .slice(1);
    expect(cancelledBranches).toHaveLength(2);
    for (const branch of cancelledBranches) {
      expect(branch.indexOf('SetErrorLevel 1')).toBeGreaterThan(-1);
    }

    expect(appBuilderPatch).toContain('/CONNECTTIMEOUT 30 /RECEIVETIMEOUT 60');
    expect(appBuilderPatch).toContain('$webDownloadAttempt < 3');
  });

  test('acquires the web payload before anything destructive runs', () => {
    // Download-first ordering: the payload must be resolved (and verified)
    // before CHECK_APP_RUNNING stops processes and before the old version is
    // uninstalled — a failed download then leaves the previous install
    // intact instead of stranding the user with no app.
    const acquireCall = installSection.indexOf('!insertmacro acquireWebPackage');
    const checkAppRunning = installSection.indexOf('!insertmacro CHECK_APP_RUNNING');
    const uninstallOld = installSection.indexOf('customUninstallOldVersion');
    expect(acquireCall).toBeGreaterThan(-1);
    expect(checkAppRunning).toBeGreaterThan(acquireCall);
    expect(uninstallOld).toBeGreaterThan(acquireCall);

    // The acquire call exists only for web builds.
    const guardIdx = installSection.lastIndexOf('!ifdef APP_PACKAGE_URL', acquireCall);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(installSection.indexOf('!endif', guardIdx)).toBeGreaterThan(acquireCall);

    // installApplicationFiles no longer downloads anything: the only
    // downloadApplicationFiles call site lives inside acquireWebPackage.
    const installFilesStart = installerTemplate.indexOf('!macro installApplicationFiles');
    const installFilesEnd = installerTemplate.indexOf('!macroend', installFilesStart);
    const installFilesBody = installerTemplate.slice(installFilesStart, installFilesEnd);
    expect(installFilesBody).not.toContain('downloadApplicationFiles');
    expect(installFilesBody).not.toContain('StdUtils.GetParameter');
    const acquireMacroStart = webPackageTemplate.indexOf('!macro acquireWebPackage');
    const acquireMacroEnd = webPackageTemplate.indexOf('!macroend', acquireMacroStart);
    const acquireBody = webPackageTemplate.slice(acquireMacroStart, acquireMacroEnd);
    expect(acquireBody).toContain('!insertmacro downloadApplicationFiles');

    expect(appBuilderPatch).toContain('!insertmacro acquireWebPackage');
  });

  test('reuses cached payloads and verifies downloads before extraction', () => {
    const acquireMacroStart = webPackageTemplate.indexOf('!macro acquireWebPackage');
    const acquireMacroEnd = webPackageTemplate.indexOf('!macroend', acquireMacroStart);
    const acquireBody = webPackageTemplate.slice(acquireMacroStart, acquireMacroEnd);

    // Resolution order: sibling package (next to the installer), then the
    // cached payload from a previous install, then the network download.
    const siblingCheck = acquireBody.indexOf('${StdUtils.HashFile} $3 "SHA2-512" "$packageFile"');
    const cacheCheck = acquireBody.indexOf(
      '${StdUtils.HashFile} $3 "SHA2-512" "$LOCALAPPDATA\\${APP_PACKAGE_STORE_FILE}"',
    );
    const download = acquireBody.indexOf('!insertmacro downloadApplicationFiles');
    expect(siblingCheck).toBeGreaterThan(-1);
    expect(cacheCheck).toBeGreaterThan(siblingCheck);
    expect(download).toBeGreaterThan(cacheCheck);

    // The cache probe only runs with a known expected hash — the hash is the
    // version gate, since the store file name is version-less.
    const cacheGuard = acquireBody.indexOf('${if} $webPackageExpectedHash != ""');
    expect(cacheGuard).toBeGreaterThan(-1);
    expect(cacheGuard).toBeLessThan(cacheCheck);

    // A stale sibling package must not block silent installs on a dialog.
    const siblingMismatchDialog = acquireBody
      .split(/\r?\n/)
      .find((line) => line.includes('found locally, but checksum'));
    expect(siblingMismatchDialog).toContain('/SD IDOK');

    // Downloaded payloads are hash-verified; a mismatch is fed back into the
    // bounded retry dispatch as a failed attempt and never reaches extraction.
    const downloadMacroStart = webPackageTemplate.indexOf('!macro downloadApplicationFiles');
    const downloadMacroEnd = webPackageTemplate.indexOf('!macroend', downloadMacroStart);
    const downloadBody = webPackageTemplate.slice(downloadMacroStart, downloadMacroEnd);
    const noProxyCall = downloadBody.indexOf('inetc::get /NOPROXY');
    const verify = downloadBody.indexOf('${StdUtils.HashFile} $3 "SHA2-512" "$PLUGINSDIR\\package.7z"');
    const mismatchStatus = downloadBody.indexOf('StrCpy $0 "Checksum Mismatch"');
    const failureDispatch = downloadBody.indexOf('${elseif} $0 != "OK"');
    expect(verify).toBeGreaterThan(noProxyCall);
    expect(mismatchStatus).toBeGreaterThan(verify);
    expect(failureDispatch).toBeGreaterThan(mismatchStatus);
    expect(downloadBody.slice(verify, mismatchStatus)).toContain('Delete "$PLUGINSDIR\\package.7z"');

    // A cache hit must not be moved onto itself — the moveFile copy+delete
    // fallback would destroy the cached payload.
    const installFilesStart = installerTemplate.indexOf('!macro installApplicationFiles');
    const installFilesEnd = installerTemplate.indexOf('!macroend', installFilesStart);
    const installFilesBody = installerTemplate.slice(installFilesStart, installFilesEnd);
    const moveGuard = installFilesBody.indexOf(
      '${if} $packageFile != "$LOCALAPPDATA\\${APP_PACKAGE_STORE_FILE}"',
    );
    const moveCall = installFilesBody.indexOf('!insertmacro moveFile "$packageFile"');
    expect(moveGuard).toBeGreaterThan(-1);
    expect(moveCall).toBeGreaterThan(moveGuard);
    expect(installFilesBody).toContain(
      '!insertmacro customInstallerCacheCopyEnd "package" "reused"',
    );

    // Acquisition and verification are visible in install-timing.log.
    expect(installerInclude).toContain('!macro customWebPackageAcquireStart');
    expect(installerInclude).toContain('!macro customWebPackageAcquireEnd SOURCE');
    expect(installerInclude).toContain('!macro customWebPackageVerifyStart');
    expect(installerInclude).toContain('!macro customWebPackageVerifyEnd RESULT');
    expect(installerInclude).toContain('phase=web-package-acquire-start');
    expect(installerInclude).toContain('phase=web-package-acquire-complete');
    expect(installerInclude).toContain('phase=web-package-verify-complete');
    for (const source of ['"explicit"', '"sibling"', '"cache"', '"download"']) {
      expect(acquireBody).toContain(`!insertmacro customWebPackageAcquireEnd ${source}`);
    }

    expect(appBuilderPatch).toContain('Checksum Mismatch');
    expect(appBuilderPatch).toContain('"package" "reused"');
  });

  test('logs web download boundaries and every installer quit', () => {
    // Both inetc transfers are bracketed by timing hooks, so a timing log
    // whose last line is web-package-download-start means the process died
    // inside the transfer. Before these hooks that window had no logging.
    const proxyStart = webPackageTemplate.indexOf(
      '!insertmacro customWebPackageDownloadStart "proxy"',
    );
    const proxyEnd = webPackageTemplate.indexOf(
      '!insertmacro customWebPackageDownloadEnd "proxy" "$0"',
    );
    const noproxyStart = webPackageTemplate.indexOf(
      '!insertmacro customWebPackageDownloadStart "noproxy"',
    );
    const noproxyEnd = webPackageTemplate.indexOf(
      '!insertmacro customWebPackageDownloadEnd "noproxy" "$0"',
    );
    expect(proxyStart).toBeGreaterThan(-1);
    expect(proxyEnd).toBeGreaterThan(proxyStart);
    expect(noproxyStart).toBeGreaterThan(proxyEnd);
    expect(noproxyEnd).toBeGreaterThan(noproxyStart);

    expect(installerInclude).toContain('!macro customWebPackageDownloadStart MODE');
    expect(installerInclude).toContain('!macro customWebPackageDownloadEnd MODE STATUS');
    expect(installerInclude).toContain('phase=web-package-download-start');
    expect(installerInclude).toContain('phase=web-package-download-exit');

    // customBeforeInstallerQuit writes its own line before the rollback: the
    // rollback returns without logging when no fast-path rename happened,
    // which previously let a silent web-download failure quit without a trace.
    const quitMacroStart = installerInclude.indexOf(
      '!macro customBeforeInstallerQuit REASON',
    );
    const quitMacroEnd = installerInclude.indexOf('!macroend', quitMacroStart);
    const quitMacro = installerInclude.slice(quitMacroStart, quitMacroEnd);
    const quitLog = quitMacro.indexOf('!insertmacro LobsterLogInstallerQuit "${REASON}"');
    const quitRollback = quitMacro.indexOf('customRollbackOldInstall');
    expect(quitLog).toBeGreaterThan(-1);
    expect(quitRollback).toBeGreaterThan(quitLog);
    expect(installerInclude).toContain('phase=installer-quit');
  });

  test('reuses an uploaded web payload without appending another block map', () => {
    expect(differentialUpdateInfoBuilder).toContain(
      'process.env.LOBSTERAI_REUSE_NSIS_WEB_PACKAGE === "1"',
    );
    expect(differentialUpdateInfoBuilder).toContain('footer.readUInt32BE(0)');
    expect(differentialUpdateInfoBuilder).toContain(
      '"reusing existing embedded block map"',
    );
    expect(differentialUpdateInfoBuilder).toContain('hash_1.hashFile)(file)');
    expect(appBuilderPatch).toContain('LOBSTERAI_REUSE_NSIS_WEB_PACKAGE');
  });

  test('terminates the attempt after rename verification rollback', () => {
    const start = installerInclude.indexOf('OldInstallRenameVerificationFailed:');
    const end = installerInclude.indexOf('OldInstallRenameComplete:', start);
    const failure = installerInclude.slice(start, end);

    expect(failure).toContain(
      '!insertmacro customRollbackOldInstall "rename-verification-failed"',
    );
    expect(failure).toContain(
      'StrCmp $lobsterOldInstallRollbackStatus "success" OldInstallRenameVerificationRestored',
    );
    expect(failure).toContain('outcome=recovery-required');
    expect(failure).toContain('outcome=restored');
    expect(failure).toContain('SetErrorLevel 3');
    expect(failure).toContain('SetErrorLevel 2');
    expect(failure.match(/^\s+Quit$/gm)).toHaveLength(2);
    expect(failure).not.toContain('Goto OldInstallRenameComplete');
  });

  test('classifies fresh installs before helpers and keeps existing-install fallbacks', () => {
    const checkStart = installerInclude.indexOf('!macro customCheckAppRunning');
    const checkEnd = installerInclude.indexOf('!macro customUninstallOldVersion', checkStart);
    const check = installerInclude.slice(checkStart, checkEnd);
    const preflight = check.indexOf('!insertmacro DetectFreshOrPossibleExisting');
    const sourceProbe = check.indexOf('phase=legacy-skills-source-preflight');
    const resolver = check.indexOf('!insertmacro ResolveTrustedPowerShell');
    const stop = check.indexOf('!insertmacro stopLobsterAIProcesses');
    const backup = check.indexOf('phase=skill-backup-complete');

    expect(preflight).toBeGreaterThan(-1);
    expect(sourceProbe).toBeGreaterThan(preflight);
    expect(resolver).toBeGreaterThan(sourceProbe);
    expect(stop).toBeGreaterThan(resolver);
    expect(backup).toBeGreaterThan(stop);
    expect(check).toContain(
      'StrCmp $lobsterInstallScenario "fresh-install" CustomCheckFreshInstall',
    );
    expect(check).toContain('phase=fresh-install-old-flow-skipped');
    expect(check).toContain('"legacy-not-applicable-fresh-install"');
    expect(check).toContain('"registered-install-missing"');
    expect(check).toContain('"install-location-mismatch"');
    expect(check).toContain('"ambiguous-dual-registration"');
  });

  test('re-kills processes on every stop round and logs survivors on failure', () => {
    const start = installerInclude.indexOf('!macro stopLobsterAIProcesses');
    const end = installerInclude.indexOf('!macroend', start);
    const stopMacro = installerInclude.slice(start, end);

    // The kill must live inside the poll loop: a kill-once-then-observe gate
    // loses against slow teardown and respawned processes.
    const loop = stopMacro.indexOf('for ($$i = 0; $$i -lt 30; $$i++)');
    const emptyCheck = stopMacro.indexOf('if ($$procs.Count -eq 0) { exit 0 }');
    const rekill = stopMacro.indexOf(
      '$$procs | Stop-Process -Force -ErrorAction SilentlyContinue',
    );
    const sleep = stopMacro.indexOf('Start-Sleep -Milliseconds 500');
    expect(loop).toBeGreaterThan(-1);
    expect(emptyCheck).toBeGreaterThan(loop);
    expect(rekill).toBeGreaterThan(emptyCheck);
    expect(sleep).toBeGreaterThan(rekill);
    expect(stopMacro).toContain('exit 3');

    // Survivor dump runs only on the exit-3 verdict, receives its inputs via
    // the child environment, and always clears them afterwards.
    expect(stopMacro).toContain('StrCmp $R2 "3" 0 StopLobsterAIProcessesLog');
    expect(stopMacro).toContain(
      String.raw`SetEnvironmentVariable(t "LOBSTERAI_STOP_LOG_PATH", t "$APPDATA\LobsterAI\install-timing.log")`,
    );
    expect(stopMacro).toContain(
      'SetEnvironmentVariable(t "LOBSTERAI_STOP_ATTEMPT_ID", t "$lobsterInstallerAttemptId")',
    );
    expect(stopMacro).toContain('SetEnvironmentVariable(t "LOBSTERAI_STOP_LOG_PATH", t "")');
    expect(stopMacro).toContain('SetEnvironmentVariable(t "LOBSTERAI_STOP_ATTEMPT_ID", t "")');
    expect(stopMacro).toContain(
      'phase=process-stop-survivor attempt_id=$$env:LOBSTERAI_STOP_ATTEMPT_ID',
    );
    expect(stopMacro).toContain('name=$$($$p.ProcessName) pid=$$($$p.Id) path=$$fp');
    expect(stopMacro).toContain('phase=process-stop-survivors-logged');
    expect(stopMacro).toContain('exit $$procs.Count');
  });

  test('treats only an enumerably empty target as fresh', () => {
    expect(
      classifyFreshTarget({ hasRegistrationEvidence: false, entries: [] }),
    ).toBe('fresh-install');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        entries: ['.', '..'],
      }),
    ).toBe('fresh-install');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        entries: ['.', '..', 'leftover'],
      }),
    ).toBe('possible-existing');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: true,
        entries: [],
      }),
    ).toBe('possible-existing');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        enumerationError: 2,
      }),
    ).toBe('fresh-install');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        enumerationError: 18,
      }),
    ).toBe('fresh-install');
    expect(
      classifyFreshTarget({
        hasRegistrationEvidence: false,
        enumerationError: 5,
      }),
    ).toBe('possible-existing');

    const start = installerInclude.indexOf('!macro DetectFreshOrPossibleExisting');
    const end = installerInclude.indexOf('!macroend', start);
    const detector = installerInclude.slice(start, end);
    expect(detector).toContain('FindFirst $4 $5 "$INSTDIR\\*"');
    expect(detector).toContain('FindNext $4 $5');
    expect(detector).toContain('StrCmp $5 "."');
    expect(detector).toContain('StrCmp $5 ".."');
    expect(detector).toContain('IntCmp $6 2 LobsterInstallPreflightFresh');
    expect(detector).toContain('IntCmp $6 18 LobsterInstallPreflightFresh');
    expect(detector).not.toContain('IfFileExists "$INSTDIR\\*"');
    expect(detector).not.toContain('IfFileExists "$INSTDIR\\*.*"');
  });

  test('resolves PowerShell and tar only from trusted absolute system paths', () => {
    expect(installerInclude).toContain(
      String.raw`$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(installerInclude).toContain(
      String.raw`$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(installerInclude).toContain(String.raw`$WINDIR\Sysnative\tar.exe`);
    expect(installerInclude).toContain(String.raw`$WINDIR\System32\tar.exe`);
    expect(installerInclude).toContain(
      String.raw`nsExec::ExecToStack '"$lobsterTrustedTarPath"`,
    );
    expect(installerInclude).not.toMatch(
      /(?:nsExec::\w+|Exec)\s+['"][^'"\n]*\bpowershell(?:\.exe)?\b/i,
    );
    expect(installerInclude).not.toContain(String.raw`$SYSDIR\tar.exe`);

    const interpretedCommands = installerInclude
      .split('\n')
      .filter((line) => /(?:nsExec::\w+|Exec).*-Command/.test(line));
    expect(interpretedCommands.length).toBeGreaterThan(0);
    for (const command of interpretedCommands) {
      expect(command).toContain('$lobsterTrustedPowerShellPath');
      expect(command).not.toMatch(/\$(?:INSTDIR|APPDATA|lobsterOldInstall\w*)/);
    }
  });

  test('uses typed helper outcomes and a marker-backed ten-minute watchdog', () => {
    const watchdogStart = installerInclude.indexOf('LOBSTERAI_WATCHDOG_MARKER_PATH');
    const watchdogEnd = installerInclude.indexOf('TarExtractVerify:', watchdogStart);
    const watchdog = installerInclude.slice(watchdogStart, watchdogEnd);

    expect(installerInclude).toContain('"process-start-blocked"');
    expect(installerInclude).toContain('"numeric-exit-code"');
    expect(installerInclude).toContain('"legacy-helper-launch-failed"');
    expect(watchdog).toContain('WaitForExit(600000)');
    expect(watchdog).toContain('WaitForExit(30000)');
    expect(watchdog).toContain('"process-timeout"');
    expect(watchdog).toContain('"process-termination-failed"');
    expect(watchdog).toContain('LOBSTERAI_WATCHDOG_TIMEOUT');
    expect(watchdog).toContain('LOBSTERAI_WATCHDOG_TERMINATION_FAILED');
    expect(watchdog).toContain('function Write-LobsterWatchdogMarker');
    expect(watchdog).toContain(
      'LOBSTERAI_WATCHDOG_MARKER_WRITE_FAILED:',
    );
    expect(
      watchdog.match(/Set-Content -LiteralPath \$\$marker/g),
    ).toHaveLength(1);
    expect(watchdog.indexOf('StrCmp $R2 "error"')).toBeLessThan(
      watchdog.indexOf('IntCmp $R2 0'),
    );
    expect(watchdog).toContain(
      'StrCmp $R2 "126" TarExtractTerminationFailed',
    );
    expect(
      watchdog.indexOf('StrCmp $R2 "126" TarExtractTerminationFailed'),
    ).toBeLessThan(
      watchdog.indexOf(
        'StrCmp $R4 "process-termination-failed" TarExtractTerminationFailed',
      ),
    );
    expect(watchdog).toContain(
      'StrCmp $R4 "process-timeout" 0 TarExtractNumericResult',
    );
    expect(watchdog).toContain('StrCmp $R2 "124" TarExtractTimeout');

    // A null exit code consults the child's success sentinel before being
    // classified as invalid output (exit-code query is permanently broken by
    // some security tooling while the child itself succeeds). The marker
    // values below are PowerShell-escaped because the sentinel verdict is
    // deliberately absent from the NSIS StrCmp dispatch (exit 0 flows through
    // the numeric branch into TarExtractVerify).
    expect(watchdog).toContain(String.raw`\"exit-code-null-sentinel-ok\"`);
    expect(watchdog).toContain('Test-Path -LiteralPath $$sentinel');
    expect(
      watchdog.indexOf(String.raw`\"exit-code-null-sentinel-ok\"`),
    ).toBeLessThan(watchdog.indexOf(String.raw`\"output-validation-failed\"`));
  });

  test('rescues a null watchdog exit code with the extractor success sentinel', () => {
    // The Node extractor publishes the sentinel only after every expected
    // root directory verified, keeping it strictly stronger than exit 0.
    expect(unpackScript).toContain("'.unpack-cfmind-ok'");
    expect(unpackScript).toContain('missingDirs === 0');
    expect(unpackScript).toContain('required resources missing after extraction');
    expect(unpackScript).toContain("name: 'cfmind-entry'");
    expect(unpackScript).toContain("name: 'cfmind-bundle-assets'");
    expect(unpackScript).toContain("name: 'skills-content'");
    expect(unpackScript).toContain("name: 'python-entry'");
    expect(unpackScript).toContain('phase=sentinel-written');
    expect(unpackScript).toContain('phase=sentinel-write-failed');
    expect(unpackScript.indexOf('phase=verify-missing')).toBeLessThan(
      unpackScript.indexOf("'.unpack-cfmind-ok'"),
    );

    // A stale sentinel must never vouch for a new attempt, and a committed
    // install leaves no sentinel behind (pre-launch delete + success delete).
    const sentinelDelete = String.raw`Delete "$INSTDIR\resources\.unpack-cfmind-ok"`;
    const preLaunchDelete = installerInclude.indexOf(sentinelDelete);
    expect(preLaunchDelete).toBeGreaterThan(-1);
    expect(preLaunchDelete).toBeLessThan(
      installerInclude.indexOf('LOBSTERAI_WATCHDOG_MARKER_PATH'),
    );
    expect(
      installerInclude.match(/Delete "\$INSTDIR\\resources\\\.unpack-cfmind-ok"/g),
    ).toHaveLength(2);

    // Exit 127 re-enters the on-disk verification when the sentinel exists
    // instead of aborting outright; the fatal path stays intact.
    const branchStart = installerInclude.indexOf('TarExtractOutputValidationFailed:');
    const branchEnd = installerInclude.indexOf('TarExtractNonZero:', branchStart);
    const branch = installerInclude.slice(branchStart, branchEnd);
    expect(branch).toContain(
      String.raw`IfFileExists "$INSTDIR\resources\.unpack-cfmind-ok" 0 TarExtractOutputValidationFatal`,
    );
    expect(branch).toContain('phase=tar-extract-sentinel-rescue');
    expect(branch).toContain('Goto TarExtractVerify');
    expect(branch).toContain('reason=watchdog-output-validation-failed');
    expect(branch).toContain('will not commit a partial application');
  });

  test('requires complete OpenClaw bundle assets, Skills, and Python before committing an installation', () => {
    const extractVerifyStart = installerInclude.indexOf('TarExtractVerify:');
    const extractVerifyEnd = installerInclude.indexOf('TarExtractProcessFailed:', extractVerifyStart);
    const extractVerify = installerInclude.slice(extractVerifyStart, extractVerifyEnd);
    expect(extractVerify).toContain('TarExtractVerifyBundleAssets:');
    expect(extractVerify).toContain(String.raw`resources\cfmind\web-tree-sitter.wasm`);
    expect(extractVerify).toContain('TarExtractVerifySkills:');
    expect(extractVerify).toContain(String.raw`resources\SKILLs\*.*`);
    expect(extractVerify).toContain(String.raw`resources\python-win\python.exe`);
    expect(extractVerify).toContain(String.raw`resources\python-win\python3.exe`);
    expect(extractVerify).toContain('TarExtractRequiredResourceMissing:');

    const prevalidateStart = installerInclude.indexOf('NewInstallPrevalidateBundleAssets:');
    const prevalidateEnd = installerInclude.indexOf('NewInstallPrevalidateSucceeded:', prevalidateStart);
    const prevalidate = installerInclude.slice(prevalidateStart, prevalidateEnd);
    expect(prevalidate).toContain('NewInstallPrevalidateBundleAssets:');
    expect(prevalidate).toContain(String.raw`resources\cfmind\web-tree-sitter.wasm`);
    expect(prevalidate).toContain(String.raw`resources\SKILLs\*.*`);
    expect(prevalidate).toContain(String.raw`resources\python-win\python.exe`);
    expect(prevalidate).toContain(String.raw`resources\python-win\python3.exe`);
  });

  test('binds Skills backup and restore to the current attempt manifest', () => {
    expect(installerInclude).toContain('backup-manifest.json');
    expect(installerInclude).toContain('schemaVersion = 1');
    expect(installerInclude).toContain('attemptId = $$attempt');
    expect(installerInclude).toContain('source = $$src');
    expect(installerInclude).toContain('oldVersion = $$oldVer');
    expect(installerInclude).toContain('skills = @($$userSkills.Name');
    expect(installerInclude).toContain('directories = $$directories');
    expect(installerInclude).toContain('files = $$files');
    expect(installerInclude).toContain('statistics = [ordered]@{');
    expect(installerInclude).toContain('Get-FileHash -LiteralPath');
    expect(installerInclude).toContain('$$verified.validation.status = \\"verified\\"');
    expect(installerInclude).toContain(
      'StrCmp $lobsterLegacySkillsStatus "legacy-backup-succeeded" 0 SkipSkillRestore',
    );
    expect(installerInclude).toContain('if ($$manifest.attemptId -ne $$attempt)');
    expect(installerInclude).toContain('if ($$manifest.source -ne $$source)');
    expect(installerInclude).toContain(
      String.raw`skills-backup\$lobsterInstallerAttemptId`,
    );
    expect(installerInclude).not.toContain(String.raw`skills-backup\*.*`);

    const restoreStart = installerInclude.indexOf(
      'StrCmp $lobsterLegacySkillsStatus "legacy-backup-succeeded" 0 SkipSkillRestore',
    );
    const restoreEnd = installerInclude.indexOf('SkipSkillRestore:', restoreStart);
    const restore = installerInclude.slice(restoreStart, restoreEnd);
    expect(restore).toContain(
      'IfFileExists "$APPDATA\\LobsterAI\\skills-backup\\$lobsterInstallerAttemptId\\backup-manifest.json" SkillRestoreAttemptBackupReady',
    );
    expect(restore).toContain('"legacy-restore-backup-missing"');
    expect(restore).toContain('Write-Output (\\"name-conflict:\\"');
    expect(restore).toContain('exit 20');
    expect(restore).toContain('"legacy-restore-name-conflict"');
    expect(restore).toContain('phase=skill-restore-conflict-preserved');
    expect(restore).toContain('phase=skill-restore-degraded');
    expect(restore.indexOf('$$conflicts = @(')).toBeLessThan(
      restore.indexOf('Remove-Item -LiteralPath $$backup'),
    );
  });

  test('drives Skills backup state from helper exit codes, never stdout text', () => {
    const defines: Record<string, string> = {};
    for (const match of installerInclude.matchAll(
      /!define (LOBSTER_SKILL_BACKUP_EXIT_\w+) "(\d+)"/g,
    )) {
      defines[match[1]] = match[2];
    }
    expect(defines).toEqual({
      LOBSTER_SKILL_BACKUP_EXIT_VERIFIED: '0',
      LOBSTER_SKILL_BACKUP_EXIT_INSPECT_FAILED: '10',
      LOBSTER_SKILL_BACKUP_EXIT_COPY_FAILED: '11',
      LOBSTER_SKILL_BACKUP_EXIT_VERIFY_FAILED: '12',
      LOBSTER_SKILL_BACKUP_EXIT_NO_USER_SKILLS: '13',
    });
    expect(new Set(Object.values(defines)).size).toBe(Object.keys(defines).length);

    // The helper exits and the NSIS status mapping both use the named codes,
    // so the protocol has a single source of truth.
    for (const name of Object.keys(defines)) {
      expect(installerInclude).toContain(`exit \${${name}}`);
      expect(installerInclude).toContain(`StrCmp $R2 "\${${name}}"`);
    }

    // stdout must never drive control flow: ExecToStack returns the helper
    // output with its trailing CRLF, so an exact text comparison silently
    // fails (the 2026.7.23 spurious legacy-restore-backup-missing bug).
    expect(installerInclude).not.toMatch(/StrCmp \$1 "legacy-/);
  });

  test('re-checks the attempt manifest after a verified backup before replacing the old install', () => {
    const backupComplete = installerInclude.indexOf('phase=skill-backup-complete');
    const postcheck = installerInclude.indexOf(
      'IfFileExists "$APPDATA\\LobsterAI\\skills-backup\\$lobsterInstallerAttemptId\\backup-manifest.json" SkillBackupValidated',
    );
    const postcheckLog = installerInclude.indexOf(
      'phase=skill-backup-manifest-postcheck-missing',
    );
    const failedAbort = installerInclude.indexOf('SkillBackupFailedAbort:');
    const swapStart = installerInclude.indexOf('phase=old-install-rename-start');

    expect(backupComplete).toBeGreaterThan(-1);
    expect(postcheck).toBeGreaterThan(backupComplete);
    expect(postcheck).toBeLessThan(swapStart);
    expect(postcheckLog).toBeGreaterThan(postcheck);
    expect(postcheckLog).toBeLessThan(failedAbort);
    // A missing manifest downgrades to the existing fail-closed abort path
    // while the old install is still intact.
    expect(installerInclude.slice(postcheck, failedAbort)).toContain(
      'StrCpy $lobsterLegacySkillsStatus "legacy-backup-verify-failed"',
    );
  });

  test('isolates degraded restore outcomes from the name-conflict branch', () => {
    const failurePreserved = installerInclude.indexOf('SkillRestoreFailurePreserved:');
    const conflictLabel = installerInclude.indexOf(
      'SkillRestoreConflictPreserved:',
      failurePreserved,
    );
    expect(failurePreserved).toBeGreaterThan(-1);
    expect(conflictLabel).toBeGreaterThan(failurePreserved);
    const degraded = installerInclude.slice(failurePreserved, conflictLabel);

    // Both degraded paths end at the shared terminal label instead of
    // falling through into the conflict branch.
    expect(degraded.match(/Goto SkillRestoreValidated/g)).toHaveLength(2);
    const instructions = degraded
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith(';'));
    expect(instructions[instructions.length - 1]).toBe('Goto SkillRestoreValidated');

    // Only restore exit code 20 may enter the conflict branch.
    expect(installerInclude).toContain('StrCmp $R2 "20" SkillRestoreConflictPreserved');
    expect(installerInclude.match(/SkillRestoreConflictPreserved/g)).toHaveLength(2);

    // The degraded dialog states exactly what survives: a missing backup is
    // reported as missing, a preserved backup with its on-disk path.
    expect(degraded).toContain('action=continue-with-attempt-backup-preserved');
    expect(degraded).toContain('action=continue-no-backup-found');
    expect(degraded).toContain(
      'The recovery backup was preserved at $APPDATA\\LobsterAI\\skills-backup\\$lobsterInstallerAttemptId',
    );
    expect(degraded).not.toContain('was not deleted');
  });

  test('appends attempt-correlated logs and records conservative provenance', () => {
    const initStart = installerInclude.indexOf('!macro customInit');
    const initEnd = installerInclude.indexOf('!macroend', initStart);
    const init = installerInclude.slice(initStart, initEnd);
    expect(installerInclude).toContain(
      "System::Call 'ole32::CoCreateGuid(g .s)'",
    );
    expect(installerInclude).toContain('RequestExecutionLevel admin');
    expect(init).toContain('!insertmacro EnsureInstallerAttemptId');
    expect(init.indexOf('!insertmacro EnsureInstallerAttemptId')).toBeLessThan(
      init.indexOf('FileOpen $9'),
    );
    expect(init).toContain(
      'FileOpen $9 "$APPDATA\\LobsterAI\\install-timing.log" a',
    );
    expect(init).toContain('FileSeek $9 0 END');
    expect(init).not.toContain(
      'FileOpen $9 "$APPDATA\\LobsterAI\\install-timing.log" w',
    );
    expect(init).toContain('StrCpy $lobsterInvocationSource "unknown"');
    expect(init).toContain('${If} ${isUpdated}');
    expect(init).toContain('${AndIf} ${isForceRun}');
    expect(init).toContain('StrCpy $lobsterInvocationSource "app-update"');
    expect(init).toContain('launcher_fallback=$lobsterLauncherFallback');

    const phaseWrites = installerInclude
      .split('\n')
      .filter((line) => /FileWrite .*phase=/.test(line));
    expect(phaseWrites.length).toBeGreaterThan(0);
    for (const phaseWrite of phaseWrites) {
      expect(phaseWrite).toContain('attempt_id=');
    }
  });

  test('prevalidates before registration and commits only in the standard finalize hook', () => {
    const installFiles = installSection.indexOf('!insertmacro installApplicationFiles');
    const prepare = installSection.indexOf(
      '!insertmacro customBeforeRegistryAddInstallInfo',
    );
    const registry = installSection.indexOf('!insertmacro registryAddInstallInfo');
    const shortcuts = installSection.indexOf('!insertmacro addStartMenuLink');
    const finalize = installSection.indexOf('!insertmacro customInstall', prepare + 1);
    const prepareMacro = installerInclude.indexOf(
      '!macro customBeforeRegistryAddInstallInfo',
    );
    const prevalidated = installerInclude.indexOf(
      'phase=new-install-prevalidated',
      prepareMacro,
    );
    const finalizeMacro = installerInclude.indexOf('!macro customInstall', prepareMacro + 1);
    const committed = installerInclude.indexOf(
      'phase=old-install-commit-complete',
      finalizeMacro,
    );

    expect(prepare).toBeGreaterThan(installFiles);
    expect(registry).toBeGreaterThan(prepare);
    expect(shortcuts).toBeGreaterThan(registry);
    expect(finalize).toBeGreaterThan(shortcuts);
    expect(prevalidated).toBeGreaterThan(prepareMacro);
    expect(prevalidated).toBeLessThan(finalizeMacro);
    expect(committed).toBeGreaterThan(finalizeMacro);
    expect(installerInclude).toContain(
      'StrCmp $lobsterOldInstallRenameStatus "prevalidated" 0 LobsterRollbackDone',
    );
    expect(installerInclude).toContain('registration=not-written');
  });

  test('aborts failed extraction and never treats recovery artifacts as success', () => {
    const failure = installerInclude.slice(
      installerInclude.indexOf('TarExtractFailed:'),
      installerInclude.indexOf('TarExtractDone:'),
    );

    expect(failure).toContain(
      '!insertmacro customRollbackOldInstall "resource-extraction-failed"',
    );
    expect(failure).toContain('SetErrorLevel 3');
    expect(failure).toContain('Quit');
    expect(installerInclude).toContain(
      'IfFileExists "$INSTDIR\\resources\\cfmind\\gateway-bundle.mjs"',
    );
    expect(installerInclude).not.toContain('runtime-and-recovery-artifacts-missing');
    expect(installerInclude).not.toContain('retry the extraction automatically');
    expect(installerInclude.indexOf('TarExtractSucceeded:')).toBeLessThan(
      installerInclude.indexOf('Delete "$INSTDIR\\resources\\win-resources.tar"'),
    );
    expect(installerInclude).toContain('Recovery files (if any):');
    expect(installerInclude).not.toContain('Previous files (if staged):');
  });

  test('relaunches a verified old app only for interactive update intent', () => {
    const start = installerInclude.indexOf('Function lobsterTryRelaunchOldApp');
    const end = installerInclude.indexOf('FunctionEnd', start);
    const relaunch = installerInclude.slice(start, end);

    expect(relaunch).toContain('${StdUtils.TestParameter} $0 "updated"');
    expect(relaunch).toContain('${StdUtils.TestParameter} $0 "force-run"');
    expect(relaunch).toContain('IfSilent 0 LobsterOldAppRelaunchInteractive');
    expect(relaunch).toContain(
      'StrCmp $lobsterTargetProcessesStopStatus "success"',
    );
    expect(installerInclude).toContain(
      'StrCpy $lobsterOldAppAsarPath "$INSTDIR\\resources\\app.asar"',
    );
    expect(relaunch).toContain('$lobsterOldAppAsarPath');
    expect(relaunch).toContain('IntOp $1 $0 & 0x410');
    expect(relaunch).toContain(
      '${StdUtils.ExecShellAsUser} $0 "$lobsterOldAppExecutablePath" "open" ""',
    );
    expect(relaunch).toContain('StrCmp $0 "0" LobsterOldAppRelaunchSucceeded');
    expect(relaunch).toContain('"old-app-relaunch-failed"');
    expect(installerInclude).toContain(
      'StrCmp $lobsterOldInstallRollbackStatus "success" 0 LobsterRollbackDone',
    );
  });

  test('preserves userData on uninstall by default', () => {
    expect(electronBuilderConfig.nsis?.deleteAppDataOnUninstall).toBe(false);
  });

  test('stages the embedded package through a selectable staging directory', () => {
    // Template contract: default init -> selection hook -> materialize hook ->
    // File materialize, all against $appPackageStagingDir, so the preflight
    // runs before any payload byte is written.
    const x64 = extractTemplate.slice(
      extractTemplate.indexOf('!macro x64_app_files'),
      extractTemplate.indexOf('!macro ia32_app_files'),
    );
    const defaultInit = x64.indexOf('StrCpy $appPackageStagingDir "$PLUGINSDIR"');
    const selectHook = x64.indexOf('!insertmacro customSelectAppPackageStagingDir');
    const materializeHook = x64.indexOf('!insertmacro customAppPackageMaterializeStart');
    const materialize = x64.indexOf(
      'File /oname=$appPackageStagingDir\\app-64.${COMPRESSION_METHOD}',
    );
    expect(defaultInit).toBeGreaterThan(-1);
    expect(selectHook).toBeGreaterThan(defaultInit);
    expect(materializeHook).toBeGreaterThan(selectHook);
    expect(materialize).toBeGreaterThan(materializeHook);

    // The variable is declared at installer.nsi file scope so both the
    // custom include's functions and every template site can reference it.
    expect(rootInstallerTemplate).toContain('Var appPackageStagingDir');

    // Every staging-path usage goes through the variable; the web-installer
    // path (which skips the embedded materialize step) falls back to
    // $PLUGINSDIR before first use.
    expect(extractTemplate).toContain('StrCmp $appPackageStagingDir "" 0 +2');
    expect(extractTemplate).toContain('CreateDirectory "$appPackageStagingDir\\7z-out"');
    expect(extractTemplate).toContain('SetOutPath "$appPackageStagingDir\\7z-out"');
    expect(extractTemplate).toContain(
      'CopyFiles /SILENT "$appPackageStagingDir\\7z-out\\*" $OUTDIR',
    );
    expect(extractTemplate).toContain('RMDir /r "$appPackageStagingDir\\7z-out"');
    expect(extractTemplate).toContain(
      '!insertmacro extractUsing7za "$appPackageStagingDir\\app-$packageArch.7z"',
    );
    expect(extractTemplate).not.toContain(String.raw`$PLUGINSDIR\7z-out`);
    expect(extractTemplate).not.toContain(String.raw`/oname=$PLUGINSDIR\app-`);
  });

  test('preflights staging drive space and relocates or aborts before materialize', () => {
    const start = installerInclude.indexOf('Function lobsterSelectPayloadStagingDir');
    const end = installerInclude.indexOf('FunctionEnd', start);
    const select = installerInclude.slice(start, end);

    // All space math is in MB (NSIS integers are 32-bit signed; the staged
    // tree exceeds 2 GB in bytes), with 64-bit probes for the raw counts.
    expect(installerInclude).toContain(
      "System::Call 'kernel32::GetDiskFreeSpaceExW(w r0, *l .r1, p 0, p 0) i .r2'",
    );
    expect(select).toContain('System::Int64Op $0 / 1048576');
    expect(select).toContain('IntOp $1 $0 + ${LOBSTER_PAYLOAD_UNPACKED_MB}');
    expect(select).toContain('IntOp $1 $1 + ${LOBSTER_STAGING_MARGIN_MB}');
    expect(select).toContain('IntOp $6 $6 + ${LOBSTER_WIN_RESOURCES_TAR_MB}');

    // Decision phases: healthy default, relocation, probe failure (fail-open),
    // and the only abort -- when no drive has room.
    expect(select).toContain('phase=staging-drive-selected');
    expect(select).toContain('mode=plugins-dir');
    expect(select).toContain('mode=install-dir');
    expect(select).toContain('result=query-failed');
    expect(select).toContain('result=relocate-create-failed');
    expect(select).toContain('free_mb=');
    expect(select).toContain('needed_mb=');
    expect(select).toContain('CreateDirectory "$INSTDIR\\.lobsterai-staging"');
    expect(select).toContain('phase=staging-preflight-insufficient');
    expect(select).toContain(
      '!insertmacro customBeforeInstallerQuit "staging-space-insufficient"',
    );
    expect(select).toContain('SetErrorLevel 2');

    // Relocated staging is removed on the success path (before tar
    // extraction needs the space) and from every controlled failure exit.
    expect(installerInclude).toContain('Function lobsterCleanupRelocatedPayloadStaging');
    expect(installerInclude).toContain('phase=staging-relocated-cleanup');
    expect(
      installerInclude.match(/Call lobsterCleanupRelocatedPayloadStaging/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    const quitMacro = installerInclude.slice(
      installerInclude.indexOf('!macro customBeforeInstallerQuit REASON'),
      installerInclude.indexOf('!macro customInstallerFailed'),
    );
    expect(quitMacro).toContain('Call lobsterCleanupRelocatedPayloadStaging');
    const beforeRegistry = installerInclude.slice(
      installerInclude.indexOf('!macro customBeforeRegistryAddInstallInfo'),
      installerInclude.indexOf('phase=tar-extract-start'),
    );
    expect(beforeRegistry).toContain('Call lobsterCleanupRelocatedPayloadStaging');

    // The staging functions reference the installer.nsi-declared variable, so
    // they must be emitted from customHeader, not at include parse time.
    const header = installerInclude.slice(
      installerInclude.indexOf('!macro customHeader'),
      installerInclude.indexOf('!macro stopLobsterAIProcesses'),
    );
    expect(header).toContain('!insertmacro DefineLobsterPayloadStagingFunctions');
  });

  test('validates the staged payload against build-time sizes before CopyFiles', () => {
    // Template ordering: the extract-end hook (which validates) sits between
    // Nsis7z::Extract and the CopyFiles commit loop.
    const extractCall = extractTemplate.indexOf('Nsis7z::Extract');
    const extractEndHook = extractTemplate.indexOf(
      'customAppPackageExtractEnd "staging" "unchecked"',
    );
    const copyFiles = extractTemplate.indexOf('CopyFiles /SILENT');
    expect(extractCall).toBeGreaterThan(-1);
    expect(extractEndHook).toBeGreaterThan(extractCall);
    expect(extractEndHook).toBeLessThan(copyFiles);

    // The nsh wires validation into the extract-end hook for both the staged
    // and the fallback-direct trees.
    expect(installerInclude).toContain('!macro LobsterValidateStagedPayload MODE');
    expect(installerInclude).toContain(
      '!insertmacro LobsterValidateStagedPayload "${MODE}"',
    );

    const validate = installerInclude.slice(
      installerInclude.indexOf('!macro LobsterValidateStagedPayload MODE'),
      installerInclude.indexOf('!macroend', installerInclude.indexOf('!macro LobsterValidateStagedPayload MODE')),
    );
    expect(validate).toContain(String.raw`"$0\${APP_EXECUTABLE_FILENAME}"`);
    expect(validate).toContain(String.raw`"$0\resources\win-resources.tar"`);
    expect(validate).toContain('"app-executable-missing"');
    expect(validate).toContain('"resources-tar-missing"');
    expect(validate).toContain('"resources-tar-size-mismatch"');
    // The exact byte compare stays 64-bit safe: a decimal string comparison
    // against the build-time size, never 32-bit IntCmp arithmetic.
    expect(validate).toContain('${ElseIf} $2 != "${LOBSTER_WIN_RESOURCES_TAR_BYTES}"');
    expect(validate).toContain('phase=payload-staging-validation-failed');
    expect(validate).toContain('found_bytes=$2 expected_bytes=$3');
    expect(validate).toContain('action=abort-install');
    expect(validate).toContain(
      '!insertmacro customBeforeInstallerQuit "payload-staging-validation-failed"',
    );
    expect(validate).toContain('SetErrorLevel 2');
    expect(validate).toContain('phase=payload-staging-validated');
    // A failed size probe on an existing file logs but does not abort.
    expect(validate).toContain('"size-query-failed"');

    // 64-bit file size probe used for the compare.
    expect(installerInclude).toContain('Function lobsterQueryFileSizeBytes');
    expect(installerInclude).toContain('kernel32::GetFileSizeEx');

    // The expected size comes from the generated build fragment; packaging
    // builds fail loudly when it is missing.
    expect(installerInclude).toContain(
      '!include "${PROJECT_DIR}\\build-tar\\win-installer-payload-size.nsh"',
    );
  });

  test('generates the payload size fragment during Windows packaging', () => {
    expect(builderHooks).toContain('function writeWindowsPayloadSizeFragment');
    expect(builderHooks).toContain('LOBSTER_WIN_RESOURCES_TAR_BYTES');
    expect(builderHooks).toContain('LOBSTER_WIN_RESOURCES_TAR_MB');
    expect(builderHooks).toContain('LOBSTER_PAYLOAD_UNPACKED_MB');
    expect(builderHooks).toContain("'win-installer-payload-size.nsh'");

    // afterPack is the generation point: extraResources are in place and the
    // NSIS targets have not archived appOutDir yet.
    const afterPack = builderHooks.slice(builderHooks.indexOf('async function afterPack'));
    expect(afterPack).toContain('writeWindowsPayloadSizeFragment(context)');

    // A build machine that itself truncated the extraResources copy must
    // fail the build instead of baking the wrong "expected" size in.
    expect(builderHooks).toContain('packagedTarBytes !== tarBytes');
    expect(builderHooks).toContain("path.join(context.appOutDir, 'resources', 'win-resources.tar')");
  });

  test('captures a bounded tar failure tail without changing exit semantics', () => {
    expect(installerInclude).not.toContain(
      String.raw`nsExec::ExecToLog '"$lobsterTrustedTarPath"`,
    );
    const tarStart = installerInclude.indexOf(
      String.raw`nsExec::ExecToStack '"$lobsterTrustedTarPath"`,
    );
    const tarEnd = installerInclude.indexOf('TarExtractElectron:', tarStart);
    const tar = installerInclude.slice(tarStart, tarEnd);

    // Exit code and output are always both popped (stack balance), and the
    // original exit-code dispatch survives verbatim.
    expect(tar).toContain('Pop $0');
    expect(tar).toContain('Pop $R6');
    expect(tar).toContain('IntCmp $R2 0 TarExtractVerify TarExtractElectron TarExtractElectron');

    // The failure tail is captured before the dispatch can leave for the
    // electron fallback, from the same non-success condition.
    const capture = tar.indexOf('phase=tar-extract-output');
    expect(capture).toBeGreaterThan(-1);
    expect(tar.slice(0, capture)).toContain('Call lobsterBuildSingleLineTail');
    expect(capture).toBeLessThan(
      tar.indexOf('IntCmp $R2 0 TarExtractVerify TarExtractElectron TarExtractElectron'),
    );
    expect(tar).toContain('text=$R6');

    // The sanitizer bounds the text and collapses it to one line.
    const sanitizer = installerInclude.slice(
      installerInclude.indexOf('Function lobsterBuildSingleLineTail'),
      installerInclude.indexOf('FunctionEnd', installerInclude.indexOf('Function lobsterBuildSingleLineTail')),
    );
    expect(sanitizer).toContain('StrCpy $0 $0 512 $1');
    expect(sanitizer).toContain('StrCmp $2 "$\\r" LobsterTailBlank');
    expect(sanitizer).toContain('StrCmp $2 "$\\n" LobsterTailBlank');
  });

  test('records Win32 error and destination free space for failed cache copies', () => {
    const start = installerInclude.indexOf('!macro customInstallerCacheCopyEnd');
    const end = installerInclude.indexOf('!macroend', start);
    const macro = installerInclude.slice(start, end);

    expect(macro).toContain("System::Call 'kernel32::GetLastError() i .r2'");
    expect(macro).toContain('win32_error=$2 dest_free_mb=$3');
    expect(macro).toContain('Call lobsterQueryFreeMegabytes');
    // The success line keeps its original shape; only the error line grows
    // the diagnostic keys, and the failure stays non-fatal (no Quit/abort).
    expect(macro).toContain('result=${RESULT} elapsed_ms=$1');
    expect(macro).not.toContain('Quit');
    expect(macro).not.toContain('Abort');
  });

  test('persists every template hook in the version-pinned patch', () => {
    expect(appBuilderPatch).toContain('templates/nsis/installSection.nsh');
    expect(appBuilderPatch).toContain('templates/nsis/installer.nsi');
    expect(appBuilderPatch).toContain('templates/nsis/include/extractAppPackage.nsh');
    expect(appBuilderPatch).toContain('templates/nsis/include/installer.nsh');
    expect(appBuilderPatch).toContain('templates/nsis/include/webPackage.nsh');
    expect(appBuilderPatch).toContain('customAfterUninstallOldVersions');
    expect(appBuilderPatch).toContain('customBeforeRegistryAddInstallInfo');
    expect(appBuilderPatch).toContain('customAppPackageExtractStart');
    expect(appBuilderPatch).toContain('customInstallerCacheCopyStart');
    expect(appBuilderPatch).toContain('customSelectAppPackageStagingDir');
    expect(appBuilderPatch).toContain('Var appPackageStagingDir');

    // Preserve the existing explicit web-package URL behavior while updating
    // the larger patch file.
    expect(appBuilderPatch).toContain('Computed URLs point at a directory');
    expect(appBuilderPatch).toContain('defines.APP_PACKAGE_URL_IS_INCOMPLETE = null;');
  });
});
