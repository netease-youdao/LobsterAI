import { describe, expect, test } from 'vitest';

import {
  appendCallbackReturnTo,
  appendLoginParams,
  startAuthLocalCallback,
} from './authLocalCallbackServer';

describe('appendLoginParams', () => {
  test('appends params inside hash route query for portal URLs', () => {
    const result = appendLoginParams(
      'https://lobsterai.youdao.com/portal#/login',
      {
        source: 'electron',
        redirect_uri: 'http://127.0.0.1:43210/auth/callback',
        state: 'test-state',
      },
    );

    expect(result).toBe(
      'https://lobsterai.youdao.com/portal#/login?source=electron&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2Fauth%2Fcallback&state=test-state',
    );
  });

  test('preserves existing hash route params', () => {
    const result = appendLoginParams(
      'https://lobsterai.youdao.com/portal#/login?invitationCode=ABC123',
      { source: 'electron' },
    );

    expect(result).toBe(
      'https://lobsterai.youdao.com/portal#/login?invitationCode=ABC123&source=electron',
    );
  });

  test('appends params to normal URL query when there is no hash route', () => {
    const result = appendLoginParams('https://example.com/login?foo=bar', {
      source: 'electron',
    });

    expect(result).toBe('https://example.com/login?foo=bar&source=electron');
  });
});

describe('appendCallbackReturnTo', () => {
  test('adds portal return URL to the local callback redirect URI', () => {
    const result = appendCallbackReturnTo(
      'http://127.0.0.1:43210/auth/callback',
      'https://lobsterai.youdao.com/portal#/login?source=electron&electronLogin=success',
    );

    expect(result).toBe(
      'http://127.0.0.1:43210/auth/callback?return_to=https%3A%2F%2Flobsterai.youdao.com%2Fportal%23%2Flogin%3Fsource%3Delectron%26electronLogin%3Dsuccess',
    );
  });
});

describe('startAuthLocalCallback', () => {
  test('starts on 127.0.0.1 with a dynamic callback port', async () => {
    const callback = await startAuthLocalCallback({ onCode: () => {} });

    try {
      expect(callback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
      expect(callback.state).toHaveLength(32);
    } finally {
      await callback.close();
    }
  });

  test('reuses the active callback so a repeated login does not invalidate the first page', async () => {
    const codes: string[] = [];
    const firstCallback = await startAuthLocalCallback({
      onCode: code => codes.push(code),
    });
    const secondCallback = await startAuthLocalCallback({ onCode: () => {} });

    expect(secondCallback.redirectUri).toBe(firstCallback.redirectUri);
    expect(secondCallback.state).toBe(firstCallback.state);

    const response = await fetch(
      `${firstCallback.redirectUri}?code=first-page-code&state=${firstCallback.state}`,
    );

    expect(response.status).toBe(200);
    expect(codes).toEqual(['first-page-code']);
  });

  test('coalesces callback servers that start concurrently', async () => {
    const codes: string[] = [];
    const [firstCallback, secondCallback] = await Promise.all([
      startAuthLocalCallback({ onCode: code => codes.push(code) }),
      startAuthLocalCallback({ onCode: () => {} }),
    ]);

    try {
      expect(secondCallback.redirectUri).toBe(firstCallback.redirectUri);
      expect(secondCallback.state).toBe(firstCallback.state);
    } finally {
      await firstCallback.close();
    }
  });

  test('delivers code when callback path and state are valid', async () => {
    const codes: string[] = [];
    const callback = await startAuthLocalCallback({
      onCode: code => codes.push(code),
    });

    const response = await fetch(`${callback.redirectUri}?code=abc123&state=${callback.state}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('登录成功');
    expect(codes).toEqual(['abc123']);
  });

  test('returns a success page that redirects back to the portal when return_to is safe', async () => {
    const callback = await startAuthLocalCallback({ onCode: () => {} });
    const returnTo = encodeURIComponent(
      'https://lobsterai.youdao.com/portal#/login?source=electron&electronLogin=success',
    );

    const response = await fetch(
      `${callback.redirectUri}?return_to=${returnTo}&code=abc123&state=${callback.state}`,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('window.location.replace');
    expect(body).toContain('electronLogin=success');
  });

  test('allows loopback return_to URLs for local portal development', async () => {
    const callback = await startAuthLocalCallback({ onCode: () => {} });
    const returnTo = encodeURIComponent(
      'http://127.0.0.1:5180/login?source=electron&electronLogin=success',
    );

    const response = await fetch(
      `${callback.redirectUri}?return_to=${returnTo}&code=abc123&state=${callback.state}`,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('window.location.replace');
    expect(body).toContain('127.0.0.1:5180');
  });

  test('does not redirect to unsafe return_to URLs', async () => {
    const callback = await startAuthLocalCallback({ onCode: () => {} });
    const returnTo = encodeURIComponent(
      'https://example.com/login?source=electron&electronLogin=success',
    );

    const response = await fetch(
      `${callback.redirectUri}?return_to=${returnTo}&code=abc123&state=${callback.state}`,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('window.location.replace');
    expect(body).not.toContain('example.com');
  });

  test('rejects callback when state does not match', async () => {
    const codes: string[] = [];
    const callback = await startAuthLocalCallback({
      onCode: code => codes.push(code),
    });

    const response = await fetch(`${callback.redirectUri}?code=abc123&state=wrong-state`);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain('登录失败');
    expect(codes).toEqual([]);
  });

  test('returns 404 for non-callback paths', async () => {
    const callback = await startAuthLocalCallback({ onCode: () => {} });

    try {
      const response = await fetch(callback.redirectUri.replace('/auth/callback', '/other'));

      expect(response.status).toBe(404);
    } finally {
      await callback.close();
    }
  });
});
