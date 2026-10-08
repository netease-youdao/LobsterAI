import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { exchangeDshLaunchToken, parseDshWebLaunchUrl, probeDshWebIndex, redactDshWebToken } from './dshWebAuth';

describe('parseDshWebLaunchUrl', () => {
  test('reads the authenticated URL dsh prints once settled', () => {
    expect(parseDshWebLaunchUrl('dsh web: http://127.0.0.1:31243/?token=9sjl_Dqc-c0g', 31243)).toBe(
      'http://127.0.0.1:31243/?token=9sjl_Dqc-c0g'
    );
  });

  test('ignores the LAN suffix and any prefix on the line', () => {
    const line = '[web] dsh web: http://127.0.0.1:31243/?token=abc (LAN: http://10.0.0.2:31243/?token=abc)';
    expect(parseDshWebLaunchUrl(line, 31243)).toBe('http://127.0.0.1:31243/?token=abc');
  });

  test('rejects lines that are not our loopback runtime', () => {
    expect(parseDshWebLaunchUrl('dsh web: http://127.0.0.1:40000/?token=abc', 31243)).toBeNull();
    expect(parseDshWebLaunchUrl('dsh web: http://10.0.0.2:31243/?token=abc', 31243)).toBeNull();
    expect(parseDshWebLaunchUrl('dsh web: https://127.0.0.1:31243/?token=abc', 31243)).toBeNull();
    expect(parseDshWebLaunchUrl('dsh web: http://127.0.0.1:31243/', 31243)).toBeNull();
  });

  test('rejects other dsh web lines and unrelated output', () => {
    expect(parseDshWebLaunchUrl('dsh web: opening the default browser; pass --no-open to disable', 31243)).toBeNull();
    expect(parseDshWebLaunchUrl('listening on http://127.0.0.1:31243/?token=abc', 31243)).toBeNull();
  });
});

describe('redactDshWebToken', () => {
  test('masks every token in a line', () => {
    expect(redactDshWebToken('dsh web: http://127.0.0.1:1/?token=a-b_c1 (LAN: http://10.0.0.2:1/?x=1&token=zz)')).toBe(
      'dsh web: http://127.0.0.1:1/?token=<redacted> (LAN: http://10.0.0.2:1/?x=1&token=<redacted>)'
    );
  });

  test('leaves token-free output untouched', () => {
    expect(redactDshWebToken('web-app: could not open the default browser')).toBe(
      'web-app: could not open the default browser'
    );
  });
});

// Mirrors how dsh answers: the launch token buys a session cookie through a
// 303, and the index answers 401 to anything without that cookie.
describe('launch-token exchange against a dsh-shaped server', () => {
  const token = 'launch-token';
  const cookie = 'dsh-auth-abc=v1.body.sig';
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://dsh.invalid');
      if (url.searchParams.get('token') === token) {
        response.writeHead(303, {
          location: '/',
          'set-cookie': [`${cookie}; Max-Age=60; Path=/; HttpOnly; SameSite=Strict`, 'dsh-extra=1; Path=/'],
        });
        response.end();
        return;
      }
      if (url.pathname === '/' && !url.search && request.headers.cookie?.includes(cookie)) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html>');
        return;
      }
      response.writeHead(401);
      response.end('dsh web authentication required');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('a valid token yields every cookie the runtime set', async () => {
    await expect(exchangeDshLaunchToken(`http://127.0.0.1:${port}/?token=${token}`)).resolves.toBe(
      `${cookie}; dsh-extra=1`
    );
  });

  test('a rejected token yields no session', async () => {
    await expect(exchangeDshLaunchToken(`http://127.0.0.1:${port}/?token=wrong`)).resolves.toBeNull();
  });

  test('the index answers the session holder and refuses everyone else', async () => {
    await expect(probeDshWebIndex(port, cookie)).resolves.toBe(200);
    await expect(probeDshWebIndex(port, 'dsh-auth-abc=forged')).resolves.toBe(401);
  });

  test('nothing listening reads as 0 rather than throwing', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(probeDshWebIndex(closedPort, cookie)).resolves.toBe(0);
    await expect(exchangeDshLaunchToken(`http://127.0.0.1:${closedPort}/?token=${token}`)).resolves.toBeNull();
  });
});
