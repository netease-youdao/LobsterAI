import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from 'vitest';
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
