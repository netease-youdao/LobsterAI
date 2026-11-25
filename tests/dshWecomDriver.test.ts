import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';

const WECOM_DRIVER_PATH = '../dsh-bundles/lobsterai-channels/plugins/drivers/wecom.mjs';

test('accepts the WeCom handshake, waits for subscription, and replies to a direct message', async () => {
  const { WeComChannelDriver } = await import(WECOM_DRIVER_PATH);
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const subscription = Promise.withResolvers<{ socket: WebSocket; requestId: string }>();
  const incoming = Promise.withResolvers<{ chatId: string; chatType: string; text: string; replyContext: Record<string, unknown> }>();
  const outgoing = Promise.withResolvers<{ cmd: string; body: unknown }>();

  server.on('upgrade', (request, socket, head) => {
    if (!request.rawHeaders.includes('Sec-WebSocket-Key')) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, client => {
      client.on('message', raw => {
        const frame = JSON.parse(raw.toString());
        if (frame.cmd === 'aibot_subscribe') {
          subscription.resolve({ socket: client, requestId: frame.headers.req_id });
        } else if (frame.cmd === 'aibot_respond_msg') {
          outgoing.resolve(frame);
          client.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const driver = new WeComChannelDriver({
    instanceId: 'test-wecom',
    config: {
      botId: 'test-bot',
      secret: 'test-secret',
      websocketUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
    onInbound: async (message: Parameters<typeof incoming.resolve>[0]) => incoming.resolve(message),
  });

  try {
    const start = driver.start();
    const { socket, requestId } = await Promise.race([
      subscription.promise,
      start.then(() => { throw new Error('Driver connected before the subscription acknowledgement'); }),
    ]);
    expect(driver.getStatus().state).toBe('connecting');

    socket.send(JSON.stringify({ headers: { req_id: requestId }, errcode: 0 }));
    await start;
    expect(driver.getStatus()).toMatchObject({ state: 'connected', error: null });

    socket.send(JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'direct-request' },
      body: {
        msgid: 'direct-message',
        chattype: 'single',
        from: { userid: 'sender' },
        msgtype: 'text',
        text: { content: 'ping' },
      },
    }));

    const message = await incoming.promise;
    expect(message).toMatchObject({ chatId: 'sender', chatType: 'direct', text: 'ping' });
    await expect(driver.sendMessage({
      chatId: message.chatId,
      text: 'pong',
      replyContext: message.replyContext,
    })).resolves.toEqual({ delivered: true });
    expect(await outgoing.promise).toMatchObject({
      cmd: 'aibot_respond_msg',
      body: { msgtype: 'stream', stream: { finish: true, content: 'pong' } },
    });
  } finally {
    await driver.stop();
    for (const client of webSocketServer.clients) client.terminate();
    webSocketServer.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function exerciseSubscriptions(
  onSubscribe: (socket: WebSocket, reply: (code: number) => void, attempt: number) => void,
  check: (driver: InstanceType<typeof import('../dsh-bundles/lobsterai-channels/plugins/drivers/wecom.mjs').WeComChannelDriver>, attempts: () => number) => Promise<void>,
) {
  const { WeComChannelDriver } = await import(WECOM_DRIVER_PATH);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let attempts = 0;
  server.on('connection', socket => socket.on('message', data => {
    const frame = JSON.parse(data.toString());
    if (frame.cmd !== 'aibot_subscribe') return;
    onSubscribe(socket, errcode => socket.send(JSON.stringify({ headers: frame.headers, errcode })), ++attempts);
  }));
  const driver = new WeComChannelDriver({
    instanceId: 'retry-test',
    config: { botId: 'bot', secret: 'secret', websocketUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` },
    onInbound: async () => {},
  });
  try {
    await check(driver, () => attempts);
  } finally {
    await driver.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test.concurrent('recovers from a dropped first handshake and a transient subscription rejection', async () => {
  await exerciseSubscriptions((socket, reply, attempt) => {
    if (attempt === 1) socket.terminate();
    else reply(attempt === 2 ? -1 : 0);
  }, async (driver, attempts) => {
    await driver.start();
    expect(driver.getStatus()).toMatchObject({ state: 'reconnecting', error: 'imWecomReconnecting' });
    await expect.poll(() => driver.getStatus().state, { timeout: 15_000 }).toBe('connected');
    expect(attempts()).toBe(3);
    expect(driver.getStatus().error).toBeNull();
  });
});

test.concurrent('recovers an established socket and yields ownership to a subsequent takeover', async () => {
  let owner: WebSocket;
  await exerciseSubscriptions((socket, reply, attempt) => {
    owner = socket;
    reply(0);
    if (attempt === 1) socket.close();
  }, async (driver, attempts) => {
    await driver.start();
    await expect.poll(() => driver.getStatus().state, { timeout: 2000 }).toBe('reconnecting');
    await expect.poll(() => driver.getStatus().state, { timeout: 6000 }).toBe('connected');
    owner.send(JSON.stringify({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'disconnected_event' } } }));
    await expect.poll(() => driver.getStatus().error).toBe('imWecomConnectionReplaced');
    await delay(3300);
    expect(driver.getStatus().state).toBe('error');
    expect(attempts()).toBe(2);
    await driver.stop();
    await driver.start();
    expect(driver.getStatus()).toMatchObject({ state: 'connected', error: null });
    expect(attempts()).toBe(3);
  });
});

test.concurrent('stops on invalid credentials and cancels pending retries when disabled', async () => {
  await exerciseSubscriptions((_socket, reply, attempt) => reply(attempt === 1 ? 853000 : -1), async (driver, attempts) => {
    await expect(driver.start()).rejects.toThrow('imWecomInvalidCredentials');
    await delay(3300);
    expect(attempts()).toBe(1);
    await driver.stop();
    await driver.start();
    expect(driver.getStatus().state).toBe('reconnecting');
    await driver.stop();
    await delay(3300);
    expect(attempts()).toBe(2);
    expect(driver.getStatus()).toMatchObject({ state: 'stopped', error: null });
  });
});

test('a silent gateway cannot leave an unacknowledged subscription or heartbeat stuck', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const firstSubscription = Promise.withResolvers<void>();
  const nextSubscription = Promise.withResolvers<void>();
  try {
    await exerciseSubscriptions((_socket, reply, attempt) => {
      if (attempt === 1) firstSubscription.resolve();
      else { reply(0); nextSubscription.resolve(); }
    }, async driver => {
      const starting = driver.start();
      await firstSubscription.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      await starting;
      expect(driver.getStatus().state).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(3000);
      await nextSubscription.promise;
      await expect.poll(() => driver.getStatus().state).toBe('connected');
      await vi.advanceTimersByTimeAsync(60_000);
      await expect.poll(() => driver.getStatus().state).toBe('reconnecting');
    });
  } finally {
    vi.useRealTimers();
  }
});
