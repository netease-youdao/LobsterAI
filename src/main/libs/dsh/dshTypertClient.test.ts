import { describe, expect, test, vi } from 'vitest';

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
  test('concurrent waiters rejoin the same Host with one fresh API peer after mux loss', async () => {
    const sockets: FakeWebSocket[] = [];
    const grants: string[] = [];
    const cookies: string[] = [];
    const client = new DshTypertClient({
      requester: async url => {
        grants.push(url);
        return { status: 302, headers: { 'set-cookie': `peer=${grants.length}; HttpOnly` }, body: '' };
      },
      webSocketFactory: (_url, headers) => {
        cookies.push(headers.cookie);
        const socket = new FakeWebSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.triggerOpen());
        return socket;
      },
    });
    const finishHandshake = async (index: number) => {
      await vi.waitFor(() => expect(sockets[index]?.sent[0]?.endpoint).toBe('$events'));
      expect(client.isConnected()).toBe(false);
      const socket = sockets[index];
      socket.triggerMessage({ type: 'item', streamId: socket.sent[0].streamId, value: { type: 'ready', clientId: String(index) } });
    };
    try {
      const boot = client.connect('http://127.0.0.1:41234/?token=original');
      await finishHandshake(0);
      await boot;
      sockets[0].close();
      const waiting = client.waitUntilConnected();
      expect(client.waitUntilConnected()).toBe(waiting);
      await finishHandshake(1);
      await waiting;
      expect(client.isConnected()).toBe(true);
      expect(cookies).toEqual(['peer=1', 'peer=2']);
      expect(grants[1]).toBe(grants[0]);
      sockets[1].close();
      const closed = expect(client.waitUntilConnected()).rejects.toMatchObject({ code: 'gateway/closed' });
      await client.close();
      await closed;
    } finally {
      await client.close();
    }
  });

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

  test('executeCommand posts exact commands/execute contract and handles goal, compact, and unresolved results', async () => {
    const fakeWs = new FakeWebSocket();
    const commandRequests: Array<{ url: string; payload: Record<string, unknown> }> = [];

    const requester: DshHttpRequester = async (url, options) => {
      if (url.includes('/connect?')) {
        return {
          status: 302,
          headers: { 'set-cookie': ['dsh-auth-cmd=ok; Path=/'] },
          body: '',
        };
      }
      if (url.endsWith('/api/commands/execute')) {
        const parsed = JSON.parse(options.body ?? '{}') as {
          rpcId: string;
          method: string;
          payload: { args: Record<string, unknown> };
        };
        commandRequests.push({ url, payload: parsed });
        const line = String(parsed.payload.args.line ?? '');
        if (line === '/unknown') {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              type: 'server-response',
              rpcId: parsed.rpcId,
              result: { ok: true },
            }),
          };
        }
        if (line === '/compact') {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              type: 'server-response',
              rpcId: parsed.rpcId,
              result: {
                ok: true,
                value: {
                  commandId: 'cmd-compact',
                  result: {
                    kind: 'success',
                    text: 'Compacted 4 history items (~1200 tokens).',
                    sourceEventSeq: 12,
                  },
                },
              },
            }),
          };
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            type: 'server-response',
            rpcId: parsed.rpcId,
            result: {
              ok: true,
              value: {
                commandId: 'cmd-1',
                result: { kind: 'success', text: 'Goal created' },
              },
            },
          }),
        };
      }
      return { status: 404, headers: {}, body: 'not found' };
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
              value: { type: 'ready', clientId: 'c-cmd', host: { home: '/tmp' } },
            });
          });
        });
        return fakeWs;
      },
    });

    await client.connect('http://127.0.0.1:41234/?token=tok');

    const res1 = await client.executeCommand({
      agentId: 'session-42',
      line: '/goal Build release checklist',
    });
    expect(res1).toEqual({
      commandId: 'cmd-1',
      result: { kind: 'success', text: 'Goal created' },
    });
    expect(commandRequests[0].payload).toMatchObject({
      type: 'client-request',
      method: 'commands/execute',
      payload: {
        args: {
          agentId: 'session-42',
          line: '/goal Build release checklist',
          submittedAttachments: [],
        },
      },
    });
    expect(Object.keys((commandRequests[0].payload.payload as { args: Record<string, unknown> }).args).sort()).toEqual([
      'agentId',
      'line',
      'submittedAttachments',
    ]);

    const res2 = await client.executeCommand({
      agentId: 'session-42',
      line: '/goal edit With image',
      submittedAttachments: [
        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'spec.png' },
      ],
    });
    expect(res2?.result.kind).toBe('success');
    expect((commandRequests[1].payload.payload as { args: { submittedAttachments: unknown[] } }).args.submittedAttachments).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'spec.png' },
    ]);

    const compactRes = await client.executeCommand({
      agentId: 'session-99',
      line: '/compact',
    });
    expect(compactRes).toEqual({
      commandId: 'cmd-compact',
      result: {
        kind: 'success',
        text: 'Compacted 4 history items (~1200 tokens).',
        sourceEventSeq: 12,
      },
    });
    expect(commandRequests[2].payload).toMatchObject({
      type: 'client-request',
      method: 'commands/execute',
      payload: {
        args: {
          agentId: 'session-99',
          line: '/compact',
          submittedAttachments: [],
        },
      },
    });

    const resUnknown = await client.executeCommand({
      agentId: 'session-42',
      line: '/unknown',
    });
    expect(resUnknown).toBeUndefined();

    await client.close();
  });

  test('calls pluginManager/listVersions and pluginManager/updateBundle and emits forwarded plugin events', async () => {
    const fakeWs = new FakeWebSocket();
    const rpcCalls: Array<{ method: string; args: Record<string, unknown> }> = [];

    const requester: DshHttpRequester = async (url, options) => {
      if (url.includes('/connect')) {
        return {
          status: 204,
          headers: { 'set-cookie': 'dsh_session=plugin-sess; HttpOnly' },
          body: '',
        };
      }
      if (url.endsWith('/api/pluginManager/listVersions') || url.endsWith('/api/pluginManager/updateBundle')) {
        const parsed = JSON.parse(options.body ?? '{}') as {
          rpcId: string;
          method: string;
          payload?: { args?: Record<string, unknown> };
        };
        rpcCalls.push({ method: parsed.method, args: parsed.payload?.args ?? {} });

        if (parsed.method === 'pluginManager/listVersions') {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              type: 'server-response',
              rpcId: parsed.rpcId,
              result: {
                ok: true,
                value: {
                  status: 'listed',
                  installed: '1.0.0',
                  registry: 'https://registry.npmmirror.com/',
                  attempts: [{ registry: 'https://registry.npmmirror.com/' }],
                  versions: [
                    {
                      version: '1.2.0',
                      tags: ['latest'],
                      prerelease: false,
                      bundle: true,
                    },
                  ],
                  omitted: 0,
                },
              },
            }),
          };
        }

        if (parsed.method === 'pluginManager/updateBundle') {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              type: 'server-response',
              rpcId: parsed.rpcId,
              result: {
                ok: true,
                value: {
                  from: '1.0.0',
                  to: '1.2.0',
                  step: 'install',
                  result: {
                    changed: true,
                    application: 'applied',
                    stage: 'enable',
                    target: '@acme/tool',
                    bundle: '@acme/tool',
                    version: '1.2.0',
                  },
                },
              },
            }),
          };
        }
      }
      return { status: 404, headers: {}, body: 'not found' };
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
              value: { type: 'ready', clientId: 'c-plugin', host: { home: '/tmp' } },
            });
          });
        });
        return fakeWs;
      },
    });

    await client.connect('http://127.0.0.1:41234/?token=tok');

    const updateStates: unknown[] = [];
    const pluginChanges: unknown[] = [];
    client.on('remote:plugin-manager/update-state', (payload) => updateStates.push(payload));
    client.on('remote:plugin-manager/changed', (payload) => pluginChanges.push(payload));

    const openEvents = fakeWs.sent.find((m) => m.endpoint === '$events');
    fakeWs.triggerMessage({
      type: 'item',
      streamId: openEvents!.streamId,
      value: {
        type: 'emit',
        event: 'plugin-manager/update-state',
        args: [{ requestId: 'upd-1', step: 'removing' }],
      },
    });
    fakeWs.triggerMessage({
      type: 'item',
      streamId: openEvents!.streamId,
      value: {
        type: 'emit',
        event: 'plugin-manager/changed',
        args: [{ reason: 'install' }],
      },
    });

    const versions = await client.listPluginVersions('@acme/tool', {
      registry: 'https://registry.npmmirror.com/',
    });
    expect(versions.status).toBe('listed');
    expect(rpcCalls[0]).toEqual({
      method: 'pluginManager/listVersions',
      args: {
        name: '@acme/tool',
        options: { registry: 'https://registry.npmmirror.com/' },
      },
    });

    const updated = await client.updatePluginBundle('@acme/tool', '1.2.0', {
      registry: 'https://registry.npmmirror.com/',
      requestId: 'upd-1',
    });
    expect(updated.step).toBe('install');
    expect(updated.result.application).toBe('applied');
    expect(rpcCalls[1]).toEqual({
      method: 'pluginManager/updateBundle',
      args: {
        name: '@acme/tool',
        version: '1.2.0',
        options: {
          registry: 'https://registry.npmmirror.com/',
          requestId: 'upd-1',
        },
      },
    });

    expect(updateStates).toEqual([{ requestId: 'upd-1', step: 'removing' }]);
    expect(pluginChanges).toEqual([{ reason: 'install' }]);

    await client.close();
  });
});
