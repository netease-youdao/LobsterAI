import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { LogReporterAction, LogReporterEndpoint, LogReporterStoreKey } from '../../shared/analytics/constants';
import { UninstallAnalytics, UninstallAnalyticsKey } from '../../shared/analytics/uninstall';
import { KeyfromStoreKey } from '../../shared/keyfrom';
import { MainLogReporter, type MainLogUrlContext } from './mainLogReporter';
import { buildUninstallAnalyticsMetadata, startUninstallAnalytics } from './uninstallAnalytics';

const executablePath = 'C:\\用户 数据\\LobsterAI\\LobsterAI.exe';
const context: MainLogUrlContext = {
  appVersion: '2026.11.13',
  arch: 'x64',
  environment: 'production',
  firstKeyfrom: 'official',
  installationId: 'installation-uuid',
  language: 'zh',
  latestKeyfrom: 'campaign',
  platform: 'win32',
  timestamp: 1234,
  userId: 'user-1',
};

const readQuery = (metadata: string): URLSearchParams => {
  const query = metadata.split('\r\n')
    .find(line => line.startsWith(`${UninstallAnalyticsKey.Query}=`))!
    .slice(UninstallAnalyticsKey.Query.length + 1);
  return new URLSearchParams(query);
};

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const createFixture = () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-uninstall-analytics-'));
  temporaryDirectories.push(userDataPath);
  const values = new Map<string, unknown>([
    [LogReporterStoreKey.AuthUser, { yid: context.userId, accessToken: 'never-persist-this' }],
    [LogReporterStoreKey.InstallationUuid, context.installationId],
  ]);
  const listeners = new Map<string, () => void>();
  const store = {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    set: (key: string, value: unknown): void => { values.set(key, value); listeners.get(key)?.(); },
    onDidChange: (key: string, callback: () => void) => {
      listeners.set(key, callback);
      return () => { listeners.delete(key); };
    },
  };
  const fetch = vi.fn();
  const reporter = new MainLogReporter({ store, fetch, appVersion: context.appVersion, platform: context.platform });
  const options = {
    isPackaged: true,
    platform: 'win32' as NodeJS.Platform,
    executablePath,
    userDataPath,
    store,
    captureContext: () => reporter.captureContext(),
  };
  const metadataPath = path.join(userDataPath, UninstallAnalytics.Filename);
  const read = () => fs.readFileSync(metadataPath, 'utf16le');
  return { options, metadataPath, values, listeners, fetch, read, store };
};

describe('uninstall analytics snapshot', () => {
  test('reuses analytics identity and attribution but leaves version/time/event ID to the uninstaller', () => {
    const metadata = buildUninstallAnalyticsMetadata(context, executablePath)!;
    const query = readQuery(metadata);
    expect(query.get('action')).toBe(LogReporterAction.AppUninstalled);
    expect(query.get('uuid')).toBe(context.installationId);
    expect(query.get('user_id')).toBe(context.userId);
    expect(query.get('os_platform')).toBe(context.platform);
    expect(query.get('os_arch')).toBe(context.arch);
    expect(query.get('firstKeyfrom')).toBe(context.firstKeyfrom);
    expect(query.get('latestKeyfrom')).toBe(context.latestKeyfrom);
    expect(query.get('uninstall_source')).toBe(UninstallAnalytics.Source);
    expect(query.has('app_version')).toBe(false);
    expect(query.has('uts')).toBe(false);
    expect(query.has('eventId')).toBe(false);
    expect(metadata).toContain(`${UninstallAnalyticsKey.InstallDirectory}=C:\\用户 数据\\LobsterAI\r\n`);
    expect(metadata).not.toContain(LogReporterEndpoint.YoudaoAnalyzer);
    expect(query.toString()).not.toContain('C%3A');
  });

  test('URL-encodes data so newlines, ampersands and quotes cannot add INI keys or parameters', () => {
    const userId = 'a&app_version=fake\r\nquery=bad " 用户';
    const metadata = buildUninstallAnalyticsMetadata({ ...context, userId }, executablePath)!;
    expect(readQuery(metadata).get('user_id')).toBe(userId);
    expect(readQuery(metadata).has('app_version')).toBe(false);
    expect(metadata.split('\r\n')).toHaveLength(5);
  });

  test('rejects missing identities, invalid paths and oversized query data', () => {
    expect(buildUninstallAnalyticsMetadata(null, executablePath)).toBeNull();
    expect(buildUninstallAnalyticsMetadata({ ...context, installationId: '' }, executablePath)).toBeNull();
    expect(buildUninstallAnalyticsMetadata(context, 'relative\\LobsterAI.exe')).toBeNull();
    expect(buildUninstallAnalyticsMetadata(context, 'C:\\bad\npath\\LobsterAI.exe')).toBeNull();
    expect(buildUninstallAnalyticsMetadata({ ...context, userId: 'x'.repeat(6_000) }, executablePath)).toBeNull();
  });

  test('writes a Unicode INI without uploading anything and updates account, UUID and channel changes', () => {
    const fixture = createFixture();
    const stop = startUninstallAnalytics(fixture.options);
    expect(fs.readFileSync(fixture.metadataPath).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.read()).not.toContain('never-persist-this');
    fixture.store.set(LogReporterStoreKey.AuthUser, { yid: 'user-2' });
    expect(readQuery(fixture.read()).get('user_id')).toBe('user-2');
    fixture.store.set(LogReporterStoreKey.AuthUser, undefined);
    expect(readQuery(fixture.read()).has('user_id')).toBe(false);
    expect(readQuery(fixture.read()).get('is_logged_in')).toBe('false');
    fixture.store.set(LogReporterStoreKey.InstallationUuid, 'new-installation');
    expect(readQuery(fixture.read()).get('uuid')).toBe('new-installation');
    fixture.store.set(KeyfromStoreKey.Attribution, { firstKeyfrom: 'official', latestKeyfrom: 'channel', updatedAt: 1 });
    expect(readQuery(fixture.read()).get('keyfrom')).toBe('channel');
    stop();
    expect(fixture.listeners.size).toBe(0);
  });

  test('removes stale opt-in metadata when disabled and restores it when enabled without UUID recursion', () => {
    const fixture = createFixture();
    startUninstallAnalytics(fixture.options);
    fixture.store.set(LogReporterStoreKey.AppConfig, { usageAnalyticsEnabled: false });
    expect(fs.existsSync(fixture.metadataPath)).toBe(false);
    fixture.values.delete(LogReporterStoreKey.InstallationUuid);
    fixture.store.set(LogReporterStoreKey.AppConfig, { usageAnalyticsEnabled: true, app: { testMode: true } });
    const query = readQuery(fixture.read());
    expect(query.get('uuid')).toMatch(/^[\da-f-]{36}$/i);
    expect(query.get('uuid')).toBe(fixture.values.get(LogReporterStoreKey.InstallationUuid));
    expect(query.get('environment')).toBe('test');
  });

  test('clears an earlier snapshot on disabled startup or a context read failure', () => {
    const fixture = createFixture();
    startUninstallAnalytics(fixture.options)();
    fixture.values.set(LogReporterStoreKey.AppConfig, { usageAnalyticsEnabled: false });
    startUninstallAnalytics(fixture.options)();
    expect(fs.existsSync(fixture.metadataPath)).toBe(false);
    fixture.values.delete(LogReporterStoreKey.AppConfig);
    startUninstallAnalytics(fixture.options)();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startUninstallAnalytics({ ...fixture.options, captureContext: () => { throw new Error('read failed'); } })();
    expect(fs.existsSync(fixture.metadataPath)).toBe(false);
    expect(warning).toHaveBeenCalledOnce();
  });

  test('metadata write failures do not escape and remove the old account snapshot', () => {
    const fixture = createFixture();
    startUninstallAnalytics(fixture.options);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk unavailable'); });
    expect(() => fixture.store.set(LogReporterStoreKey.AuthUser, { yid: 'user-2' })).not.toThrow();
    expect(fs.existsSync(fixture.metadataPath)).toBe(false);
    expect(fs.existsSync(`${fixture.metadataPath}.tmp`)).toBe(false);
  });

  test.each([
    { isPackaged: false, platform: 'win32' },
    { isPackaged: true, platform: 'darwin' },
    { isPackaged: true, platform: 'linux' },
  ])('does not touch the installed snapshot for $platform packaged=$isPackaged', overrides => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.metadataPath, 'existing snapshot');
    const captureContext = vi.fn();
    startUninstallAnalytics({ ...fixture.options, ...overrides, platform: overrides.platform as NodeJS.Platform, captureContext })();
    expect(captureContext).not.toHaveBeenCalled();
    expect(fixture.listeners.size).toBe(0);
    expect(fs.readFileSync(fixture.metadataPath, 'utf8')).toBe('existing snapshot');
  });
});
