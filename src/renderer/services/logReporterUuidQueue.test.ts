import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  getInstallationId: vi.fn<() => Promise<string | null>>(),
  userId: 'first-user',
}));

vi.mock('../store', () => ({
  store: {
    getState: () => ({
      auth: {
        isLoggedIn: true,
        user: { yid: testState.userId },
        quota: { subscriptionStatus: 'active' },
      },
    }),
  },
}));

vi.mock('./config', () => ({
  configService: {
    getConfig: () => ({
      language: 'zh',
      usageAnalyticsEnabled: true,
      app: { isDevelopment: false, testMode: false },
    }),
  },
}));

vi.mock('./installationId', () => ({
  getInstallationId: testState.getInstallationId,
}));

import { LogReporterAction, reportYdAnalyzer } from './logReporter';

beforeEach(() => {
  vi.useFakeTimers();
  testState.userId = 'first-user';
  testState.getInstallationId
    .mockReset()
    .mockResolvedValueOnce(null)
    .mockResolvedValue('installation-uuid');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('queues an event until uuid is ready without losing the event-time user identity', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('window', {
    electron: {
      platform: 'darwin',
      arch: 'arm64',
      api: { fetch: fetchMock },
    },
  });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  await expect(reportYdAnalyzer({
    action: LogReporterAction.PublishingEntryAction,
  })).resolves.toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();

  testState.userId = 'second-user';
  await vi.advanceTimersByTimeAsync(1_000);

  expect(fetchMock).toHaveBeenCalledOnce();
  const requestUrl = new URL(fetchMock.mock.calls[0][0].url);
  expect(requestUrl.searchParams.get('uuid')).toBe('installation-uuid');
  expect(requestUrl.searchParams.get('log_Usid')).toBe('first-user');
  expect(requestUrl.searchParams.get('is_logged_in')).toBe('true');
  expect(requestUrl.searchParams.get('identityType')).toBe('subscription');
  expect(requestUrl.searchParams.get('is_subscriber')).toBe('true');
  expect(requestUrl.searchParams.get('eventId')).not.toBe('');
});
