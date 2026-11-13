import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { LogReporterEndpoint } from '../src/shared/analytics/constants';
import { UninstallAnalytics, UninstallAnalyticsKey } from '../src/shared/analytics/uninstall';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const analytics = read('scripts/nsis-uninstall-analytics.nsh');
const installer = read('scripts/nsis-installer.nsh');
const uninstaller = read('node_modules/app-builder-lib/templates/nsis/uninstaller.nsh');
const macro = (source: string, name: string) => {
  const start = source.indexOf(`!macro ${name}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('!macroend', start));
};

describe('Windows uninstall analytics integration contracts', () => {
  test('keeps the app snapshot and NSIS reader on the same schema and fixed HTTPS destination', () => {
    expect(analytics).toContain(`!define LOBSTER_UNINSTALL_ANALYTICS_FILE "${UninstallAnalytics.Filename}"`);
    expect(analytics).toContain(`!define LOBSTER_UNINSTALL_ANALYTICS_SECTION "${UninstallAnalytics.Section}"`);
    expect(analytics).toContain(`!define LOBSTER_UNINSTALL_ANALYTICS_SCHEMA "${UninstallAnalytics.SchemaVersion}"`);
    expect(analytics).toContain(`!define LOBSTER_UNINSTALL_ANALYTICS_ENDPOINT "${LogReporterEndpoint.YoudaoAnalyzer}"`);
    for (const key of Object.values(UninstallAnalyticsKey)) expect(analytics).toContain(`"${key}"`);
    expect(installer).toContain('!include "${__FILEDIR__}/nsis-uninstall-analytics.nsh"');
  });

  test('captures only after confirmation/process stop, before file and optional user-data removal', () => {
    const check = macro(installer, 'customCheckAppRunning');
    expect(check.indexOf('!insertmacro LobsterPrepareUninstallAnalytics'))
      .toBeGreaterThan(check.lastIndexOf('!insertmacro stopLobsterAIProcesses'));
    const section = uninstaller.slice(uninstaller.indexOf('Section "un.install"'));
    expect(section.indexOf('call un.checkAppRunning')).toBeGreaterThanOrEqual(0);
    expect(section.indexOf('RMDir /r $INSTDIR')).toBeGreaterThanOrEqual(0);
    expect(section.indexOf('call un.checkAppRunning')).toBeLessThan(section.indexOf('RMDir /r $INSTDIR'));
    expect(section.indexOf('RMDir /r "$APPDATA\\${APP_FILENAME}"'))
      .toBeLessThan(section.indexOf('!insertmacro customUnInstall'));
    expect(macro(installer, 'customUnInstall')).toContain('!insertmacro LobsterReportUninstallAnalytics');
    const prepare = macro(analytics, 'LobsterPrepareUninstallAnalytics');
    expect(prepare).toContain('${IfNot} ${isUpdated}');
    expect(prepare).toContain('SetShellVarContext current');
    expect(prepare).toContain('SetShellVarContext all');
    expect(prepare).toContain('StrCmp $0 $1 0 LobsterUninstallAnalyticsRestoreContext');
    expect(prepare).not.toContain('inetc::');
    expect(prepare).toContain('IfFileExists "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
  });

  test('excludes upgrades and failed removals, stamps removal time/version and consumes the snapshot', () => {
    const report = macro(analytics, 'LobsterReportUninstallAnalytics');
    const send = report.indexOf('inetc::get');
    for (const guard of [
      '${If} ${isUpdated}',
      'StrCmp $lobsterUninstallAnalyticsQuery "" LobsterUninstallAnalyticsDone',
      'IfFileExists "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" LobsterUninstallAnalyticsDone',
      'IfFileExists "$INSTDIR\\resources\\app.asar" LobsterUninstallAnalyticsDone',
    ]) {
      expect(report.indexOf(guard)).toBeGreaterThanOrEqual(0);
      expect(report.indexOf(guard)).toBeLessThan(send);
    }
    expect(report).toContain('GetSystemTimeAsFileTime');
    expect(report).toContain('System::Int64Op $0 - 11644473600000');
    expect(report).toContain('ole32::CoCreateGuid');
    expect(report).toContain('app_version=${VERSION}&eventId=$1&uts=$0&silent=$2');
    expect(report.indexOf('Delete "$lobsterUninstallAnalyticsPath"')).toBeGreaterThan(send);
    expect(report).toContain('/SILENT /NOCOOKIES /CONNECTTIMEOUT 3 /RECEIVETIMEOUT 3');
    expect(report).not.toMatch(/\/WEAKSECURITY|\/RESUME|MessageBox|Abort|SetErrorLevel/);
  });

  test('includes uninstall contracts in the Windows packaging gate', () => {
    expect(read('scripts/verify-installer-patches.cjs')).toContain('windowsUninstallAnalytics.test.ts');
  });
});
