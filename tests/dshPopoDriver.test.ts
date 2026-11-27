import { createCipheriv, createHash } from 'node:crypto';
import { createServer } from 'node:net';

import { afterEach, describe, expect, test, vi } from 'vitest';

const driverPath = '../dsh-bundles/lobsterai-channels/plugins/drivers/popo.mjs';
const protocolPath = '../dsh-bundles/lobsterai-channels/plugins/drivers/popo-protocol.mjs';
const webhookPath = '../dsh-bundles/lobsterai-channels/plugins/drivers/popo-webhook.mjs';
const key = '1234567890abcdef0123456789abcdef';
const account = { appKey: 'test', appSecret: 'secret', aesKey: key, textChunkLimit: 3 };

function encrypt(event: unknown) {
  const cipher = createCipheriv('aes-128-cbc', key.slice(0, 16), key.slice(16));
  return Buffer.concat([cipher.update(JSON.stringify(event)), cipher.final()]).toString('base64');
}

const direct = { eventType: 'IM_P2P_TO_ROBOT_MSG', eventData: { from: 'alice', notify: 'hello', uuid: 'm1' } };
const group = { eventType: 'IM_CHAT_TO_ROBOT_AT_MSG', eventData: { from: 'alice', sessionId: 'room', notify: '@Bot hello', atList: ['my-bot'], uuid: 'm2' } };

afterEach(() => vi.unstubAllGlobals());

describe('DSH POPO', () => {
  test('subscribes after STOMP CONNECTED, decrypts and deduplicates messages, and sends to the original peer', async () => {
    const { PopoChannelDriver } = await import(driverPath);
    const { stompFrame } = await import(protocolPath);
    const send = vi.fn();
    const close = vi.fn();
    class Socket {
      static CLOSING = 2;
      static OPEN = 1;
      static current: Socket;
      readyState = 1;
      send = send;
      close = close;
      onopen?: () => void;
      onmessage?: (e: { data: string }) => void;
      constructor(readonly url: URL) { Socket.current = this; }
    }
    vi.stubGlobal('WebSocket', Socket);
    const payloads: { receiver: string; message: { content: string } }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
      let data;
      if (url.endsWith('/token')) data = { accessToken: 'test-token', accessExpiredAt: Date.now() + 3600_000 };
      else if (url.endsWith('/onceToken/get')) data = { onceToken: 'once', robotUid: 'my-bot' };
      else { payloads.push(JSON.parse(String(opts.body))); data = { msgId: 'receipt' }; }
      return Response.json({ errcode: 0, data });
    }));
    const onInbound = vi.fn().mockResolvedValue(undefined);
    const driver = new PopoChannelDriver({ instanceId: 'a', config: account, onInbound });
    const start = driver.start();
    try {
      await vi.waitFor(() => expect(Socket.current).toBeDefined());
      const ws = Socket.current;
      expect(ws.url.searchParams.get('auth_token')).toBe('once');
      ws.onopen?.();
      expect(driver.getStatus().state).toBe('connecting');
      ws.onmessage?.({ data: stompFrame('CONNECTED') });
      await start;
      expect(send).toHaveBeenCalledWith(expect.stringContaining('destination:/robots/msg/OpenClaw/my-bot'));
      const frame = 'MESSAGE\n\n' + JSON.stringify({ messageType: 'ROBOT_EVENT', data: { encrypt: encrypt(direct) } }) + '\0';
      ws.onmessage?.({ data: frame.slice(0, 12) });
      ws.onmessage?.({ data: frame.slice(12) + frame });
      expect(onInbound).toHaveBeenCalledTimes(1);
      expect(onInbound).toHaveBeenCalledWith(expect.objectContaining({ platform: 'popo', instanceId: 'a', chatId: 'alice', text: 'hello' }));
      await expect(driver.sendMessage({ chatId: 'user:alice', text: '中🌞文123' })).resolves.toMatchObject({ delivered: true, messageId: 'receipt' });
      expect(payloads.map(p => [p.receiver, p.message.content])).toEqual([['alice', '中🌞文'], ['alice', '123']]);
    } finally { await driver.stop(); }
    expect(close).toHaveBeenCalledTimes(1);
    expect(driver.getStatus().state).toBe('stopped');
  });

  test('only forwards permitted senders and the addressed group, and keeps pairing closed until approved', async () => {
    const { PopoChannelDriver } = await import(driverPath);
    const onInbound = vi.fn();
    const pairing = vi.fn().mockResolvedValue({ approved: false, message: 'code' });
    const driver = new PopoChannelDriver({ instanceId: 'bot', config: { ...account, dmPolicy: 'pairing', groupPolicy: 'allowlist', groupAllowFrom: ['room'] }, onInbound, requestPairing: pairing });
    driver.abortController = new AbortController();
    driver.robotUid = 'my-bot';
    driver.sendMessage = vi.fn();
    await driver.handleEvent(direct);
    expect(driver.sendMessage).toHaveBeenCalledWith({ chatId: 'alice', text: 'code' });
    expect(onInbound).not.toHaveBeenCalled();
    pairing.mockResolvedValue({ approved: true });
    await driver.handleEvent({ ...direct, eventData: { ...direct.eventData, uuid: 'next' } });
    await driver.handleEvent(group);
    await driver.handleEvent({ ...group, eventData: { ...group.eventData, atList: ['other-bot'], uuid: 'wrong-bot' } });
    await driver.handleEvent({ ...group, eventData: { ...group.eventData, sessionId: 'other-room', uuid: 'wrong-room' } });
    expect(onInbound).toHaveBeenCalledTimes(2);
    expect(onInbound).toHaveBeenLastCalledWith(expect.objectContaining({ chatId: 'room', chatType: 'group', text: 'hello' }));
  });

  test('refreshes an expired platform token once, and propagates failed deliveries', async () => {
    const { PopoApi } = await import(protocolPath);
    const issued: string[] = [];
    const used: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
      if (url.endsWith('/token')) {
        const accessToken = 'token' + issued.length;
        issued.push(accessToken);
        return Response.json({ errcode: 0, data: { accessToken, accessExpiredAt: Date.now() + 3600_000 } });
      }
      used.push(new Headers(opts.headers).get('open-access-token') ?? '');
      return Response.json({ errcode: used.length === 1 ? 42001 : 40014 });
    }));
    const api = new PopoApi(account, new AbortController().signal);
    await expect(api.request('/im/send-msg', {})).rejects.toThrow(/40014/);
    expect(issued).toEqual(['token0', 'token1']);
    expect(used).toEqual(issued);
  });

  test('routes signed webhook challenges and encrypted messages to the correct instance on a shared port', async () => {
    const { listenPopoWebhook } = await import(webhookPath);
    const probe = createServer();
    const port = await new Promise<number>(resolve => probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address && typeof address === 'object') resolve(address.port);
    }));
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const first = vi.fn(), second = vi.fn();
    const closers: Array<() => Promise<void>> = [];
    try {
      for (const [id, token, receive] of [['12345678-old', 'one', first], ['87654321-other', 'two', second]] as const) {
        closers.push(await listenPopoWebhook({ aesKey: key, webhookPort: port, token }, id, receive));
      }
      const timestamp = String(Date.now()), nonce = 'challenge';
      const signature = createHash('sha256').update(['one', timestamp, nonce].sort().join('')).digest('hex');
      const url = new URL('http://127.0.0.1:' + port + '/popo/callback/12345678');
      url.search = new URLSearchParams({ timestamp, nonce, signature }).toString();
      expect(await (await fetch(url)).text()).toBe(nonce);
      const result = await fetch(url, { method: 'POST', body: JSON.stringify({ encrypt: encrypt(group) }) });
      expect(result.ok).toBe(true);
      expect(first).toHaveBeenCalledWith(group);
      expect(second).not.toHaveBeenCalled();
      url.pathname = '/popo/callback/87654321';
      expect((await fetch(url)).status).toBe(401);
    } finally { for (const close of closers) await close(); }
  });
});
