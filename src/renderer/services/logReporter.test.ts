import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../store', () => ({
  store: {
    getState: () => ({
      auth: {
        user: {
          yid: 'stored-user',
        },
      },
    }),
  },
}));

vi.mock('./config', () => ({
  configService: {
    getConfig: vi.fn(() => ({
      language: 'zh',
      usageAnalyticsEnabled: true,
    })),
  },
}));

vi.mock('./installationId', () => ({
  getInstallationId: vi.fn(() => Promise.resolve('installation-uuid')),
}));

import { configService } from './config';
import {
  buildLogUrl,
  LogReporterAction,
  LogReporterActionPrefix,
  LogReporterCategory,
  LogReporterEndpoint,
  LogReporterEntry,
  LogReporterProduct,
  reportYdAnalyzer,
} from './logReporter';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('builds a Youdao Analyzer URL with common action parameters', () => {
  const result = new URL(buildLogUrl(
    {
      action: `${LogReporterActionPrefix.LobsterAI}skill_enabled`,
      skillId: 'xlsx',
      enabled: true,
    },
    {
      appVersion: '2026.6.18',
      arch: 'arm64',
      firstKeyfrom: 'bilibili',
      installationId: 'installation-uuid',
      language: 'en',
      latestKeyfrom: 'partner_a',
      platform: 'darwin',
      userId: 'test-user',
      timestamp: 123456789,
    },
  ));

  expect(result.origin + result.pathname).toBe(LogReporterEndpoint.YoudaoAnalyzer);
  expect(result.searchParams.get('_npid')).toBe(LogReporterProduct.LobsterAI);
  expect(result.searchParams.get('_ncat')).toBe(LogReporterCategory.Actions);
  expect(result.searchParams.get('app_version')).toBe('2026.6.18');
  expect(result.searchParams.get('os_platform')).toBe('darwin');
  expect(result.searchParams.get('os_arch')).toBe('arm64');
  expect(result.searchParams.get('language')).toBe('en');
  expect(result.searchParams.get('uuid')).toBe('installation-uuid');
  expect(result.searchParams.get('firstKeyfrom')).toBe('bilibili');
  expect(result.searchParams.get('latestKeyfrom')).toBe('partner_a');
  expect(result.searchParams.get('is_logged_in')).toBe('true');
  expect(result.searchParams.get('action')).toBe('lobsterai_skill_enabled');
  expect(result.searchParams.get('skillId')).toBe('xlsx');
  expect(result.searchParams.get('enabled')).toBe('true');
  expect(result.searchParams.get('log_Usid')).toBe('test-user');
  expect(result.searchParams.get('uts')).toBe('123456789');
});

test('does not allow event parameters to override common parameters', () => {
  const result = new URL(buildLogUrl(
    {
      action: 'lobsterai_app_started',
      _npid: 'unexpected-product',
      _ncat: 'unexpected-category',
      app_version: 'unexpected-version',
      os_platform: 'unexpected-platform',
      os_arch: 'unexpected-arch',
      language: 'unexpected-language',
      uuid: 'unexpected-uuid',
      firstKeyfrom: 'unexpected-first-keyfrom',
      latestKeyfrom: 'unexpected-latest-keyfrom',
      is_logged_in: false,
      log_Usid: 'unexpected-user',
      uts: 1,
    },
    {
      appVersion: 'trusted-version',
      arch: 'trusted-arch',
      firstKeyfrom: 'trusted-first-keyfrom',
      installationId: 'trusted-uuid',
      language: 'trusted-language',
      latestKeyfrom: 'trusted-latest-keyfrom',
      platform: 'trusted-platform',
      userId: 'trusted-user',
      timestamp: 2,
    },
  ));

  expect(result.searchParams.get('_npid')).toBe(LogReporterProduct.LobsterAI);
  expect(result.searchParams.get('_ncat')).toBe(LogReporterCategory.Actions);
  expect(result.searchParams.get('app_version')).toBe('trusted-version');
  expect(result.searchParams.get('os_platform')).toBe('trusted-platform');
  expect(result.searchParams.get('os_arch')).toBe('trusted-arch');
  expect(result.searchParams.get('language')).toBe('trusted-language');
  expect(result.searchParams.get('uuid')).toBe('trusted-uuid');
  expect(result.searchParams.get('firstKeyfrom')).toBe('trusted-first-keyfrom');
  expect(result.searchParams.get('latestKeyfrom')).toBe('trusted-latest-keyfrom');
  expect(result.searchParams.get('is_logged_in')).toBe('true');
  expect(result.searchParams.get('log_Usid')).toBe('trusted-user');
  expect(result.searchParams.get('uts')).toBe('2');
});

test('uses the logged-in user and omits empty optional parameters', () => {
  const result = new URL(buildLogUrl(
    {
      action: `${LogReporterActionPrefix.LobsterAI}app_started`,
      optionalValue: undefined,
      nullableValue: null,
    },
    {
      timestamp: 987654321,
    },
  ));

  expect(result.searchParams.get('log_Usid')).toBe('stored-user');
  expect(result.searchParams.get('language')).toBe('zh');
  expect(result.searchParams.get('is_logged_in')).toBe('true');
  expect(result.searchParams.has('optionalValue')).toBe(false);
  expect(result.searchParams.has('nullableValue')).toBe(false);
});

test('marks anonymous events when no user is logged in', () => {
  vi.mocked(configService.getConfig).mockReturnValue({
    language: 'zh',
    usageAnalyticsEnabled: true,
  } as ReturnType<typeof configService.getConfig>);
  const result = new URL(buildLogUrl(
    {
      action: `${LogReporterActionPrefix.LobsterAI}app_started`,
    },
    {
      userId: '',
      timestamp: 987654321,
    },
  ));

  expect(result.searchParams.get('log_Usid')).toBe('');
  expect(result.searchParams.get('is_logged_in')).toBe('false');
});

test('reports an event through the Electron API bridge', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('window', {
    electron: {
      platform: 'darwin',
      arch: 'arm64',
      appInfo: {
        getVersion: vi.fn().mockResolvedValue('2026.6.18'),
        getKeyfromAttribution: vi.fn().mockResolvedValue({
          firstKeyfrom: 'bilibili',
          latestKeyfrom: 'partner_a',
          updatedAt: 123456789,
        }),
      },
      api: {
        fetch: fetchMock,
      },
    },
  });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  await expect(reportYdAnalyzer({
    action: LogReporterAction.PlanModeEnabled,
    entry: LogReporterEntry.PromptToolsMenu,
  })).resolves.toBe(true);

  expect(fetchMock).toHaveBeenCalledOnce();
  const request = fetchMock.mock.calls[0][0];
  const requestUrl = new URL(request.url);
  expect(request.method).toBe('GET');
  expect(requestUrl.searchParams.get('action')).toBe('lobsterai_plan_mode_enabled');
  expect(requestUrl.searchParams.get('entry')).toBe('prompt_tools_menu');
  expect(requestUrl.searchParams.get('app_version')).toBe('2026.6.18');
  expect(requestUrl.searchParams.get('os_platform')).toBe('darwin');
  expect(requestUrl.searchParams.get('os_arch')).toBe('arm64');
  expect(requestUrl.searchParams.get('uuid')).toBe('installation-uuid');
  expect(requestUrl.searchParams.get('firstKeyfrom')).toBe('bilibili');
  expect(requestUrl.searchParams.get('latestKeyfrom')).toBe('partner_a');
});

test('returns false when the event request is rejected', async () => {
  vi.stubGlobal('window', {
    electron: {
      api: {
        fetch: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
      },
    },
  });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await expect(reportYdAnalyzer({
    action: LogReporterAction.PlanModeEnabled,
  })).resolves.toBe(false);
});

test('returns false when the Electron API bridge throws', async () => {
  vi.stubGlobal('window', {
    electron: {
      api: {
        fetch: vi.fn().mockRejectedValue(new Error('network unavailable')),
      },
    },
  });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await expect(reportYdAnalyzer({
    action: LogReporterAction.PlanModeEnabled,
  })).resolves.toBe(false);
});

test('skips sending when usage analytics is disabled', async () => {
  vi.mocked(configService.getConfig).mockReturnValue({
    usageAnalyticsEnabled: false,
  } as ReturnType<typeof configService.getConfig>);
  const fetchMock = vi.fn();
  vi.stubGlobal('window', {
    electron: {
      api: {
        fetch: fetchMock,
      },
    },
  });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  await expect(reportYdAnalyzer({
    action: LogReporterAction.PlanModeEnabled,
  })).resolves.toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('rejects an event without the LobsterAI action prefix before sending', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('window', {
    electron: {
      api: {
        fetch: fetchMock,
      },
    },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await expect(reportYdAnalyzer({
    action: 'plan_mode_enabled',
  } as unknown as Parameters<typeof reportYdAnalyzer>[0])).resolves.toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});
