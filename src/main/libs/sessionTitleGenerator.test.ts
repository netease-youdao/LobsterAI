import { afterEach, describe, expect, test, vi } from 'vitest';

import { SessionTitleGenerator } from './sessionTitleGenerator';

const sessionId = '11111111-1111-4111-8111-111111111111';
const request = { sessionId, text: '帮我修复登录失败', expectedTitle: '帮我修复登录失败' };
const success = () => Response.json({ code: 0, data: { title: '修复登录失败' } });

function setup() {
  let auth: { sessionKey: string; accessToken: string; headers: Record<string, string> } | null = {
    sessionKey: 'account:1', accessToken: 'test-token', headers: {},
  };
  let session: { title: string } | null = { title: request.expectedTitle };
  const fetch = vi.fn<(url: string, options: RequestInit) => Promise<Response>>().mockResolvedValue(success());
  const setTitle = vi.fn((_id: string, title: string) => { if (session) session.title = title; });
  const generator = new SessionTitleGenerator({
    getAuth: () => auth,
    getBaseUrl: () => 'https://example.test',
    getSession: () => session,
    fetch,
    setTitle,
  });
  return {
    generator, fetch, setTitle,
    setSession: (value: typeof session) => { session = value; },
    setAuth: (value: typeof auth) => { auth = value; },
  };
}

afterEach(() => vi.useRealTimers());

describe('optional session titles', () => {
  test('sends one authenticated bounded request and persists a successful title', async () => {
    const { generator, fetch, setTitle } = setup();
    expect(await generator.generate(request)).toBe('修复登录失败');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://example.test/api/desktop-tools/session-title');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(JSON.parse(options.body as string)).toEqual({ requestId: sessionId, text: request.text });
    expect(options.redirect).toBe('error');
    expect(setTitle).toHaveBeenCalledWith(sessionId, '修复登录失败');
  });

  test('skips logged out, empty, too-long, deleted and already renamed sessions', async () => {
    const fixture = setup();
    expect(await fixture.generator.generate({ ...request, text: '' })).toBeNull();
    expect(await fixture.generator.generate({ ...request, text: '😀'.repeat(1001) })).toBeNull();
    fixture.setSession({ title: 'custom title' });
    expect(await fixture.generator.generate(request)).toBeNull();
    fixture.setSession(null);
    expect(await fixture.generator.generate(request)).toBeNull();
    fixture.setAuth(null);
    expect(await fixture.generator.generate(request)).toBeNull();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  test.each([401, 429, 500])('silently keeps the existing title on HTTP %i without retry', async (status) => {
    const { generator, fetch, setTitle } = setup();
    fetch.mockResolvedValue(new Response('', { status }));
    expect(await generator.generate(request)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(setTitle).not.toHaveBeenCalled();
  });

  test.each([
    { code: 42503 },
    { code: 0, data: { title: '' } },
    { code: 0, data: { title: '字'.repeat(51) } },
    { code: 0, data: { title: 'line\nline' } },
    { code: 0, data: { title: 'bad\u0000title' } },
  ])('rejects unsuccessful or malformed title responses', async (body) => {
    const { generator, fetch, setTitle } = setup();
    fetch.mockResolvedValue(Response.json(body));
    expect(await generator.generate(request)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(setTitle).not.toHaveBeenCalled();
  });

  test('network failures and invalid JSON are silent', async () => {
    const { generator, fetch, setTitle } = setup();
    fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('not json'));
    expect(await generator.generate(request)).toBeNull();
    expect(await generator.generate(request)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(setTitle).not.toHaveBeenCalled();
  });

  test.each(['rename', 'delete', 'logout', 'switch', 'same-title-rename'] as const)(
    'discards a late response after %s', async (operation) => {
      const fixture = setup();
      let finish!: (response: Response) => void;
      fixture.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const pending = fixture.generator.generate(request);
      expect(await fixture.generator.generate(request)).toBeNull();
      if (operation === 'rename') fixture.setSession({ title: 'my title' });
      if (operation === 'delete') fixture.setSession(null);
      if (operation === 'logout') fixture.setAuth(null);
      if (operation === 'switch') fixture.setAuth({ sessionKey: 'account:2', accessToken: 'new', headers: {} });
      if (operation === 'same-title-rename') fixture.generator.cancel(sessionId);
      finish(success());
      expect(await pending).toBeNull();
      expect(fixture.fetch).toHaveBeenCalledTimes(1);
      expect(fixture.setTitle).not.toHaveBeenCalled();
    },
  );

  test('aborts after five seconds and never retries', async () => {
    vi.useFakeTimers();
    const { generator, fetch, setTitle } = setup();
    fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = generator.generate(request);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(setTitle).not.toHaveBeenCalled();
  });
});
