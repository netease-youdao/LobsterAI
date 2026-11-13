import fs from 'node:fs';
import path from 'node:path';

import { LogReporterAction, LogReporterStoreKey } from '../../shared/analytics/constants';
import { UninstallAnalytics, UninstallAnalyticsKey } from '../../shared/analytics/uninstall';
import { KeyfromStoreKey } from '../../shared/keyfrom';
import type { SqliteStore } from '../sqliteStore';
import { buildMainLogUrl, type MainLogUrlContext } from './mainLogReporter';

interface UninstallAnalyticsOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  executablePath: string;
  userDataPath: string;
  store: Pick<SqliteStore, 'onDidChange'>;
  captureContext: () => MainLogUrlContext | null;
}

export function buildUninstallAnalyticsMetadata(
  context: MainLogUrlContext | null,
  executablePath: string,
): string | null {
  if (!context?.installationId?.trim()) return null;

  const url = new URL(buildMainLogUrl({
    action: LogReporterAction.AppUninstalled,
    uninstall_source: UninstallAnalytics.Source,
  }, context));
  // The uninstaller supplies its own version, event ID and time. A user can
  // install an update and remove it without ever starting that new version.
  for (const key of ['app_version', 'eventId', 'uts']) url.searchParams.delete(key);
  const query = url.searchParams.toString();
  if (query.length > UninstallAnalytics.MaxQueryLength) return null;

  const directory = path.win32.dirname(executablePath);
  if (!path.win32.isAbsolute(directory) || /[\r\n]/.test(directory)) return null;
  return [
    `[${UninstallAnalytics.Section}]`,
    `${UninstallAnalyticsKey.SchemaVersion}=${UninstallAnalytics.SchemaVersion}`,
    `${UninstallAnalyticsKey.InstallDirectory}=${directory}`,
    `${UninstallAnalyticsKey.Query}=${query}`,
    '',
  ].join('\r\n');
}

/** Keep only the existing analytics fields readable after the app is removed. */
export function startUninstallAnalytics(options: UninstallAnalyticsOptions): () => void {
  // Development runs must not overwrite the installed application's snapshot.
  if (!options.isPackaged || options.platform !== 'win32') return () => {};

  const metadataPath = path.join(options.userDataPath, UninstallAnalytics.Filename);
  const temporaryPath = `${metadataPath}.tmp`;
  let previousMetadata: string | null | undefined;
  let syncing = false;

  const removeMetadata = (): void => {
    fs.rmSync(metadataPath, { force: true });
    fs.rmSync(temporaryPath, { force: true });
  };
  const sync = (): void => {
    // captureContext may create installation_uuid and synchronously notify us.
    if (syncing) return;
    syncing = true;
    try {
      const metadata = buildUninstallAnalyticsMetadata(options.captureContext(), options.executablePath);
      if (metadata === previousMetadata) return;
      if (metadata === null) {
        removeMetadata();
      } else {
        fs.mkdirSync(options.userDataPath, { recursive: true });
        // GetPrivateProfileString (NSIS ReadINIStr) requires the UTF-16 BOM for
        // non-ASCII Windows user names and installation directories.
        fs.writeFileSync(temporaryPath, `\uFEFF${metadata}`, { encoding: 'utf16le', mode: 0o600 });
        fs.renameSync(temporaryPath, metadataPath);
      }
      previousMetadata = metadata;
    } catch (error) {
      // Never leave a previous account/opt-in snapshot after a failed refresh.
      previousMetadata = undefined;
      try {
        removeMetadata();
      } catch {
        // A read-only/unavailable profile must not break settings or startup.
      }
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.warn(`[UninstallAnalytics] failed to refresh metadata (${errorName})`);
    } finally {
      syncing = false;
    }
  };

  sync();
  const unsubscribe = [
    LogReporterStoreKey.AppConfig,
    LogReporterStoreKey.AuthUser,
    LogReporterStoreKey.InstallationUuid,
    KeyfromStoreKey.Attribution,
  ].map(key => options.store.onDidChange(key, sync));
  return () => unsubscribe.forEach(stop => stop());
}
