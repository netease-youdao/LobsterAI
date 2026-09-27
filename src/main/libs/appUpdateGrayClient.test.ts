import { afterEach, describe, expect, test, vi } from 'vitest';

import { AppUpdateChannel, type AppUpdateInfo, AppUpdateSource } from '../../shared/appUpdate/constants';
import {
  APP_UPDATE_GRAY_TIMEOUT_MS, AppUpdateGrayClient, AppUpdateGrayPlatform,
  type AppUpdateGraySession, canReuseUpdatePackage,
} from './appUpdateGrayClient';

const stable: AppUpdateInfo = {
  latestVersion: '2.0.0', date: '', url: 'https://cdn.example/stable.exe',
  changeLog: { zh: { title: '', content: [] }, en: { title: '', content: [] } },
};
function payload(version = '3.0.0', url = 'https://cdn.example/gray.exe') {
  return { code: 0, data: { updateAvailable: true, channel: AppUpdateChannel.Gray,
    rolloutId: 'test-cohort', policyRevision: 1, release: { version, date: '2026-09-18', url,
      changeLog: { ch: { title: '更新', content: ['修复'] }, en: { title: 'Update', content: ['Fix'] } } } } };
}
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
function fixture(platform: string = AppUpdateGrayPlatform.Windows, arch = 'x64') {
  let session: AppUpdateGraySession | null = { sessionKey: 'account-a:1', accessToken: 'secret-token' };
  let base = 'https://server.example';
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
    .mockImplementation(async () => response(payload()));
  const client = new AppUpdateGrayClient({ getSession: () => session, getServerBaseUrl: () => base,
    fetch, platform, arch });
  return { client, fetch, logout: () => { session = null; },
    switchAccount: () => { session = { sessionKey: 'account-b:2', accessToken: 'other-token' }; },
    switchEnvironment: () => { base = 'https://other.example'; } };
}

afterEach(() => vi.useRealTimers());

describe('optional gray overlay', () => {
  test.each(Object.values(AppUpdateSource))('keeps the original request and maps the gray result for %s', async source => {
    const { client, fetch } = fixture();
    const loadStable = vi.fn(async () => stable);
    const selected = await client.select(loadStable, '1.0.0', source);
    expect(loadStable).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).searchParams.get('source')).toBe(source);
    expect(new URL(url).searchParams.get('version')).toBe('1.0.0');
    expect(new URL(url).searchParams.get('platform')).toBe(AppUpdateGrayPlatform.Windows);
    expect(init.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer secret-token' });
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(selected?.latestVersion).toBe('3.0.0');
    expect(selected?.changeLog.zh.content).toEqual(['修复']);
    expect(JSON.stringify(selected)).not.toContain('secret-token');
  });

  test('anonymous users do not call the additional endpoint', async () => {
    const { client, fetch, logout } = fixture();
    logout();
    expect(await client.select(async () => stable, '1.0.0', AppUpdateSource.Auto)).toBe(stable);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([401, 403, 404, 500, 503])('HTTP %s preserves the original stable result', async status => {
    const { client, fetch } = fixture();
    fetch.mockResolvedValue(response({}, status));
    expect(await client.select(async () => stable, '1.0.0', AppUpdateSource.Auto)).toBe(stable);
  });

  test.each([
    null, {}, { code: 1 }, { code: 0, data: { updateAvailable: false } },
    { code: 0, data: { ...payload().data, channel: 'stable' } },
    { code: 0, data: { ...payload().data, policyRevision: 0 } },
    { code: 0, data: { ...payload().data, rolloutId: '' } },
    payload('1.0.0'), payload('0.9.0'), payload('3.0.0-fix'), payload('99999999999.1'),
    payload('3.0.0', 'http://cdn.example/a.exe'), payload('3.0.0', 'https://user:pass@cdn.example/a.exe'),
    payload('3.0.0', 'https://cdn.example:444/a.exe'), payload('3.0.0', 'https://cdn.example/a.exe#download'),
    payload('3.0.0', 'https://cdn.example/a.dmg'),
    { code: 0, data: { ...payload().data, release: { ...payload().data.release, changeLog: {} } } },
  ])('declined or invalid payload %# never replaces stable', async value => {
    const { client, fetch } = fixture();
    fetch.mockResolvedValue(response(value));
    expect(await client.select(async () => stable, '1.0.0', AppUpdateSource.Auto)).toBe(stable);
  });

  test.each(['network', 'invalid-json'])('%s does not fail a successful stable check', async failure => {
    const { client, fetch } = fixture();
    if (failure === 'network') fetch.mockRejectedValue(new Error('offline'));
    else fetch.mockResolvedValue(new Response('broken json'));
    expect(await client.select(async () => stable, '1.0.0', AppUpdateSource.Manual)).toBe(stable);
  });

  test('a valid gray release works when stable has no new version or fails', async () => {
    const { client } = fixture();
    expect((await client.select(async () => null, '1.0.0', AppUpdateSource.Auto))?.latestVersion).toBe('3.0.0');
    expect((await client.select(async () => { throw new Error('stable offline'); }, '1.0.0', AppUpdateSource.Auto))?.latestVersion)
      .toBe('3.0.0');
  });

  test('the original error survives when neither source supplies a release', async () => {
    const { client, fetch } = fixture();
    fetch.mockRejectedValue(new Error('gray offline'));
    const error = new Error('original stable failure');
    await expect(client.select(async () => { throw error; }, '1.0.0', AppUpdateSource.Auto)).rejects.toBe(error);
  });

  test.each(['3.0.0', '3.0.0.0', '4.0.0'])('stable wins when its version is %s', async version => {
    const { client } = fixture();
    const approved = { ...stable, latestVersion: version };
    expect(await client.select(async () => approved, '1.0.0', AppUpdateSource.Auto)).toBe(approved);
  });

  test.each(['fetch', 'body'])('bounds a stalled %s without accepting its late response', async stage => {
    vi.useFakeTimers();
    const { client, fetch } = fixture();
    let finish!: (value: any) => void;
    const stalled = new Promise<any>(resolve => { finish = resolve; });
    if (stage === 'fetch') fetch.mockReturnValue(stalled);
    else fetch.mockResolvedValue({ ok: true, json: () => stalled } as Response);
    const result = client.select(async () => stable, '1.0.0', AppUpdateSource.Auto);
    await vi.advanceTimersByTimeAsync(APP_UPDATE_GRAY_TIMEOUT_MS);
    expect(await result).toBe(stable);
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    finish(stage === 'fetch' ? response(payload()) : payload());
    await vi.runAllTimersAsync();
    expect(await result).toBe(stable);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['logout', 'switchAccount', 'switchEnvironment'] as const)('drops a response after %s', async action => {
    const f = fixture();
    let finish!: (response: Response) => void;
    f.fetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const selected = f.client.select(async () => stable, '1.0.0', AppUpdateSource.Auto);
    f[action]();
    finish(response(payload()));
    expect(await selected).toBe(stable);
  });

  test('does not cancel stable when gray completes first; rechecks account after both finish', async () => {
    const f = fixture();
    let finish!: (info: AppUpdateInfo) => void;
    const pendingStable = new Promise<AppUpdateInfo>(resolve => { finish = resolve; });
    const loadStable = vi.fn(() => pendingStable);
    const selected = f.client.select(loadStable, '1.0.0', AppUpdateSource.Auto);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalled());
    f.switchAccount();
    finish(stable);
    expect(await selected).toBe(stable);
    expect(loadStable).toHaveBeenCalledTimes(1);
  });

  test.each(['x64', 'arm64'])('validates macOS %s DMGs independently of Windows', async arch => {
    const { client, fetch } = fixture(AppUpdateGrayPlatform.MacOS, arch);
    fetch.mockResolvedValue(response(payload('3.0.0', 'https://cdn.example/app.dmg')));
    expect((await client.query('1.0.0', AppUpdateSource.Auto))?.url).toContain('.dmg');
  });

  test('unsupported platforms leave their existing fallback untouched', async () => {
    const { client, fetch } = fixture('linux');
    expect(await client.select(async () => stable, '1.0.0', AppUpdateSource.Auto)).toBe(stable);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('fresh authorization rejects removal, a replacement package or a newer fix', async () => {
    const { client, fetch } = fixture();
    const selected = (await client.query('1.0.0', AppUpdateSource.Auto))!;
    expect(await client.authorize(selected, '1.0.0', AppUpdateSource.Auto)).toBe(true);
    for (const value of [{ code: 0, data: { updateAvailable: false } }, payload('3.0.0', 'https://cdn.example/replaced.exe'), payload('3.0.1')]) {
      fetch.mockResolvedValue(response(value));
      expect(await client.authorize(selected, '1.0.0', AppUpdateSource.Auto)).toBe(false);
    }
  });

  test('legacy cache matching stays unchanged, but gray bytes cannot cross accounts or channels', async () => {
    const { client } = fixture();
    const gray = (await client.query('1.0.0', AppUpdateSource.Auto))!;
    expect(canReuseUpdatePackage(undefined, stable)).toBe(true);
    expect(canReuseUpdatePackage(stable, gray)).toBe(false);
    expect(canReuseUpdatePackage(gray, stable)).toBe(false);
    expect(canReuseUpdatePackage(gray, { ...gray, gray: { ...gray.gray!, sessionKey: 'other' } })).toBe(false);
    expect(canReuseUpdatePackage(gray, gray)).toBe(true);
  });
});
