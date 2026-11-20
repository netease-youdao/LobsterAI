import { describe, expect, test } from 'vitest';

import { DshOpsAction } from '../../../shared/dshEngine/hostConstants';
import {
  type DshHttpRequester,
  DshRemoteError,
  DshTypertClient,
  type DshWebSocketLike,
} from './dshTypertClient';

class FakeWebSocket implements DshWebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  triggerMessage(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn(event);
    }
  }
}

describe('DshTypertClient', () => {
  test('authenticates via /connect, establishes $events, invokes unary RPC & ops, and answers waterfall events', async () => {
    const httpLog: Array<{ url: string; method: string; headers?: Record<string, string>; body?: string }> = [];
    const fakeWs = new FakeWebSocket();

    const requester: DshHttpRequester = async (url, options) => {
      httpLog.push({ url, method: options.method, headers: options.headers, body: options.body });

      if (url.includes('/connect?')) {
        return {
          status: 302,
          headers: { 'set-cookie': ['dsh-auth-abc=signed-val; Path=/; HttpOnly'] },
          body: '',
        };
      }

      if (url.endsWith('/api/lobsterai/ops')) {
        const req = JSON.parse(options.body ?? '{}') as { action: string };
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ ok: true, result: { action: req.action, healthy: true } }),
        };
      }

      if (url.endsWith('/api/session/create')) {
        const req = JSON.parse(options.body ?? '{}') as { rpcId: string };
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            type: 'server-response',
            rpcId: req.rpcId,
            result: { ok: true, value: { sessionId: 'session-42' } },
          }),
        };
      }

      if (url.endsWith('/api/$events/result')) {
        const req = JSON.parse(options.body ?? '{}') as { rpcId: string };
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            type: 'server-response',
            rpcId: req.rpcId,
            result: { ok: true, value: null },
          }),
        };
      }

      return { status: 404, headers: {}, body: 'not found' };
    };

    const client = new DshTypertClient({
      requester,
      webSocketFactory: (_wsUrl, headers) => {
        expect(headers.cookie).toBe('dsh-auth-abc=signed-val');
        queueMicrotask(() => {
          fakeWs.triggerOpen();
          queueMicrotask(() => {
            const openEvents = fakeWs.sent.find((m) => m.endpoint === '$events');
            expect(openEvents).toBeDefined();
            fakeWs.triggerMessage({
              type: 'item',
              streamId: openEvents!.streamId,
              value: { type: 'ready', clientId: 'client-1', host: { home: '/tmp/dsh-home' } },
            });
          });
        });
        return fakeWs;
      },
    });

    client.onWaterfall('approval/request', async (evt) => {
      expect(evt.agentId).toBe('session-42');
      expect(evt.request.toolName).toBe('bash');
      return { kind: 'result', value: 'allowed-once' };
    });

    const connected = await client.connect('http://127.0.0.1:41234/?token=secret-token');
    expect(connected).toEqual({ origin: 'http://127.0.0.1:41234', hostHome: '/tmp/dsh-home' });
    expect(client.isConnected()).toBe(true);

    const created = await client.createSession({ cwd: '/work' });
    expect(created.sessionId).toBe('session-42');

    const health = await client.callOps<{ action: string; healthy: boolean }>(DshOpsAction.Health);
    expect(health).toEqual({ action: 'health', healthy: true });

    // Deliver a forwarded waterfall approval request over $events and verify $events/result reply.
    const eventsStreamId = fakeWs.sent.find((m) => m.endpoint === '$events')!.streamId as string;
    fakeWs.triggerMessage({
      type: 'item',
      streamId: eventsStreamId,
      value: {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'evt-99',
        agentId: 'session-42',
        request: { toolName: 'bash', reason: 'Run command' },
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    const resultCall = httpLog.find((entry) => entry.url.endsWith('/api/$events/result'));
    expect(resultCall).toBeDefined();
    const resultBody = JSON.parse(resultCall!.body!) as {
      payload: { args: { clientId: string; eventId: string; outcome: { kind: string; value: string } } };
    };
    expect(resultBody.payload.args).toEqual({
      clientId: 'client-1',
      eventId: 'evt-99',
      outcome: { kind: 'result', value: 'allowed-once' },
    });

    await client.close();
  });

  test('streams multiplexed frames and propagates RemoteError', async () => {
    const fakeWs = new FakeWebSocket();
    const requester: DshHttpRequester = async (url) => {
      if (url.includes('/connect?')) {
        return {
          status: 302,
          headers: { 'set-cookie': ['dsh-auth-x=1; Path=/'] },
          body: '',
        };
      }
      return { status: 200, headers: {}, body: '{}' };
    };

    const client = new DshTypertClient({
      requester,
      webSocketFactory: () => {
        queueMicrotask(() => {
          fakeWs.triggerOpen();
          queueMicrotask(() => {
            const openEvents = fakeWs.sent.find((m) => m.endpoint === '$events');
            fakeWs.triggerMessage({
              type: 'item',
              streamId: openEvents!.streamId,
              value: { type: 'ready', clientId: 'c1', host: { home: '/tmp' } },
            });
          });
        });
        return fakeWs;
      },
    });

    await client.connect('http://127.0.0.1:41234/?token=tok');

    const stream = client.followSession<{ type: string; text?: string }>({
      address: { kind: 'session', sessionId: 's1' },
      assistantStream: true,
    });

    const received: Array<{ type: string; text?: string }> = [];
    const consumePromise = (async () => {
      for await (const item of stream) {
        received.push(item);
      }
    })();

    await new Promise((r) => setTimeout(r, 10));
    const followOpen = fakeWs.sent.find((m) => m.endpoint === 'session/follow');
    expect(followOpen).toBeDefined();
    const sid = followOpen!.streamId as string;

    fakeWs.triggerMessage({ type: 'item', streamId: sid, value: { type: 'snapshot' } });
    fakeWs.triggerMessage({ type: 'item', streamId: sid, value: { type: 'chunk', text: 'hello' } });
    fakeWs.triggerMessage({
      type: 'error',
      streamId: sid,
      error: { code: 'session/not-found', message: 'missing', details: {} },
    });

    await expect(consumePromise).rejects.toThrow(DshRemoteError);
    expect(received).toEqual([{ type: 'snapshot' }, { type: 'chunk', text: 'hello' }]);

    await client.close();
  });
});
