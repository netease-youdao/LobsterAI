import { createServer, type ServerResponse } from 'node:http';

import { describe, expect, test, vi } from 'vitest';

import { AuthRefreshFailureKind, AuthRefreshOutcome, AuthRefreshReason } from '../../shared/auth/constants';
import { AuthSessionManager, type AuthTokens } from './authSessionManager';
import { ServerRouteContextTracker } from './serverRouteContext';

async function fakeService(label: string, holdFirstRefresh = false) {
  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  let release: (() => void) | undefined;
  let reportPending!: () => void;
  const pending = new Promise<void>(resolve => { reportPending = resolve; });
  let refreshes = 0;
  const server = createServer((request, response: ServerResponse) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/auth/refresh') {
      refreshes++;
      const body = JSON.stringify({ code: 0, data: { accessToken: `access-${label}-${refreshes}`, refreshToken: `refresh-${label}-${refreshes}` } });
      if (holdFirstRefresh && refreshes === 1) {
        response.writeHead(200); response.write(body.slice(0, 10));
        release = () => { response.end(body.slice(10)); };
        reportPending();
      } else response.end(body);
    } else {
      response.statusCode = request.headers.authorization?.startsWith(`Bearer access-${label}-`) ? 200 : 401;
      response.end(JSON.stringify({ code: response.statusCode === 200 ? 0 : 40101 }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test service has no TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`, requests, pending,
    release: () => release?.(),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

describe('authentication across two actual service routes', () => {
  test('A → B → A keeps each refresh and retry on its captured route and rejects the first A body', async () => {
    const a = await fakeService('a', true);
    let b: Awaited<ReturnType<typeof fakeService>> | undefined;
    try {
      b = await fakeService('b');
      const routes = new ServerRouteContextTracker();
      let active = a.url;
      let tokens: AuthTokens = { accessToken: 'access-initial', refreshToken: 'refresh-initial' };
      const saveTokens = vi.fn((next: AuthTokens) => { tokens = next; });
      const onTerminalFailure = vi.fn(), onRefreshSuccess = vi.fn();
      const manager = new AuthSessionManager({
        getTokens: () => tokens,
        getSessionKey: () => `owner:${routes.capture(active, 'owner:1').routeEpoch}`,
        getRefreshUrl: () => `${active}/api/auth/refresh`,
        saveTokens, fetch: (url, init) => fetch(url, init),
        buildRefreshRequestBody: refreshToken => JSON.stringify({ refreshToken }), onTerminalFailure, onRefreshSuccess,
      });
      const switchTo = (url: string) => { active = url; routes.capture(active, 'owner:1'); manager.invalidateContext(); };
      const firstA = manager.refresh(AuthRefreshReason.Proactive);
      await a.pending;
      switchTo(b.url);
      const fromB = await manager.fetchWithAuth(`${b.url}/api/user/profile`);
      expect(fromB.status).toBe(200);
      expect(tokens.accessToken).toBe('access-b-1');
      switchTo(a.url);
      const secondA = await manager.refresh(AuthRefreshReason.Manual);
      expect(secondA).toMatchObject({ outcome: AuthRefreshOutcome.Success, accessToken: 'access-a-2' });
      a.release();
      const stale = await firstA;
      expect(stale).toMatchObject({ outcome: AuthRefreshOutcome.TransientFailure, failureKind: AuthRefreshFailureKind.ContextChanged });
      expect(stale).not.toHaveProperty('accessToken');
      expect(saveTokens.mock.calls.map(([value]) => value.accessToken)).toEqual(['access-b-1', 'access-a-2']);
      expect(a.requests.map(value => value.path)).toEqual(['/api/auth/refresh', '/api/auth/refresh']);
      expect(b.requests.map(value => value.path)).toEqual(['/api/user/profile', '/api/auth/refresh', '/api/user/profile']);
      expect(b.requests.at(-1)?.authorization).toBe('Bearer access-b-1');
      expect(onTerminalFailure).not.toHaveBeenCalled();
      expect(onRefreshSuccess).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.all([a.close(), b?.close()]);
    }
  });
});
