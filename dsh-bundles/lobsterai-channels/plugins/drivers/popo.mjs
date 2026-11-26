import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BaseChannelDriver } from './base-driver.mjs';
import { PopoApi, popoMessage, readMercuryEvent, stompFrame } from './popo-protocol.mjs';
import { listenPopoWebhook } from './popo-webhook.mjs';

const WS_ENDPOINT = 'wss://nws.popo.netease.com:11012/stomp';
const HEARTBEAT_MS = 10_000;

export class PopoChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'popo' });
    this.requestPairing = options.requestPairing;
    this.seen = new Set();
  }

  async connect(signal) {
    const { appKey, appSecret, aesKey, token } = this.config;
    if (!appKey || !appSecret || Buffer.byteLength(aesKey || '') !== 32) {
      throw new Error('POPO requires AppKey, AppSecret and a 32-byte AES key');
    }
    this.api = new PopoApi(this.config, signal);
    const mode = this.config.connectionMode || (token ? 'webhook' : 'websocket');
    if (mode === 'webhook') {
      if (!token) throw new Error('POPO Webhook requires a signing token');
      await this.api.getToken();
      signal.throwIfAborted();
      const close = await listenPopoWebhook(this.config, this.instanceId, event => this.handleEvent(event));
      if (signal.aborted) { await close(); return; }
      this.closeWebhook = close;
      this.setState('connected');
      return;
    }
    if (mode !== 'websocket') throw new Error('Unsupported POPO connection mode');
    const ready = Promise.withResolvers();
    this.monitor = this.monitorMercury(signal, ready);
    return ready.promise;
  }

  async monitorMercury(signal, ready) {
    let retryMs = 1000;
    while (!signal.aborted) {
      try {
        this.setState('connecting');
        const auth = await this.api.request('/im/onceToken/get', {});
        if (!auth?.onceToken || !auth.robotUid) throw new Error('Incomplete POPO Mercury authorization');
        signal.throwIfAborted();
        this.markStartupStage('popo-authorized');
        this.robotUid = auth.robotUid;
        await this.runSocket(auth.onceToken, signal, () => {
          retryMs = 1000;
          this.setState('connected', null, { accountId: this.robotUid });
          ready.resolve();
        });
      } catch (err) {
        ready.reject(err);
        if (signal.aborted) break;
        this.setState('error', err.message);
      }
      await delay(retryMs, undefined, { signal }).catch(() => {});
      retryMs = Math.min(retryMs * 2, 60_000);
    }
  }

  runSocket(onceToken, signal, onReady) {
    const url = new URL(WS_ENDPOINT);
    url.search = new URLSearchParams({ auth_type: 'ROBOT_ONCE_TOKEN', auth_token: onceToken, app_id: 'popo' });
    const ws = new WebSocket(url, ['v11.stomp', 'v12.stomp']);
    ws.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      let heartbeat;
      let buffer = '';
      let finished = false;
      const finish = err => {
        if (finished) return;
        finished = true;
        clearTimeout(handshake);
        clearInterval(heartbeat);
        signal.removeEventListener('abort', stop);
        if (ws.readyState < WebSocket.CLOSING) ws.close();
        if (err) reject(err); else resolve();
      };
      const stop = () => finish(signal.reason);
      const handshake = setTimeout(() => finish(new Error('POPO STOMP handshake timed out')), 12_000);
      signal.addEventListener('abort', stop, { once: true });
      ws.onopen = () => {
        if (finished) return;
        ws.send(stompFrame('CONNECT', { 'accept-version': '1.0,1.1,1.2', host: 'mercury', 'heart-beat': '10000,10000' }));
        this.markStartupStage('popo-stomp-connect-sent');
      };
      ws.onerror = () => finish(new Error('POPO Mercury WebSocket connection failed'));
      ws.onclose = e => finish(new Error('POPO Mercury WebSocket closed (' + e.code + ')'));
      ws.onmessage = ({ data }) => {
        if (finished) return;
        buffer += typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        buffer = buffer.replace(/^[\r\n]+/, '');
        if (buffer.length > 4 * 1024 * 1024) return finish(new Error('Oversized POPO STOMP frame'));
        let end;
        while ((end = buffer.indexOf('\0')) >= 0) {
          const frame = buffer.slice(0, end).replace(/\r\n/g, '\n');
          buffer = buffer.slice(end + 1).replace(/^[\r\n]+/, '');
          const command = frame.split('\n', 1)[0];
          if (command === 'ERROR') return finish(new Error('POPO Mercury rejected STOMP session'));
          if (command === 'CONNECTED' && !heartbeat) {
            ws.send(stompFrame('SUBSCRIBE', { id: randomUUID(), destination: '/robots/msg/OpenClaw/' + this.robotUid, ack: 'auto' }));
            clearTimeout(handshake);
            heartbeat = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(stompFrame('SEND', { destination: '/heart-beat' }));
                ws.send('\n');
              }
            }, HEARTBEAT_MS);
            onReady();
          } else if (command === 'MESSAGE') {
            try {
              const event = readMercuryEvent(frame.slice(frame.indexOf('\n\n') + 2), this.config.aesKey);
              if (event) void this.handleEvent(event).catch(() => console.warn('[POPO] Inbound delivery failed'));
            } catch {
              console.warn('[POPO] Invalid incoming robot event');
            }
          }
        }
      };
    });
  }

  async handleEvent(event) {
    const msg = popoMessage(event, this.robotUid);
    if (!msg || this.abortController?.signal.aborted || !this.abortController) return;
    if (msg.messageId) {
      if (this.seen.has(msg.messageId)) return;
      this.seen.add(msg.messageId);
      if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value);
    }
    const group = msg.chatType === 'group';
    const policy = (group ? this.config.groupPolicy : this.config.dmPolicy) ?? 'open';
    const allow = (group ? this.config.groupAllowFrom : this.config.allowFrom) ?? [];
    const allowed = allow.includes('*') || allow.includes(msg.senderId) || (group && allow.includes(msg.chatId));
    if (policy === 'pairing' && !group && !allowed) {
      const result = await this.requestPairing?.(msg.senderId);
      if (!result?.approved) {
        if (result?.message) await this.sendMessage({ chatId: msg.chatId, text: result.message });
        return;
      }
    } else if (policy !== 'open' && !(policy === 'allowlist' && allowed) && !(policy === 'pairing' && allowed)) {
      return;
    }
    await this.onInbound({ ...msg, platform: this.platform, instanceId: this.instanceId });
  }

  async sendMessage({ chatId, text }) {
    const receiver = String(chatId).replace(/^(?:moltbot-popo:|popo:)/i, '').replace(/^(?:user|direct|group):/i, '');
    if (!receiver || !text.trim()) throw new Error('POPO requires a recipient and message');
    const chars = Array.from(text);
    const limit = Math.max(1, Math.min(Number(this.config.textChunkLimit) || 3000, 3000));
    let receipt;
    for (let start = 0; start < chars.length; start += limit) {
      receipt = await this.api.request('/im/send-msg', {
        receiver, msgType: 'text', message: { content: chars.slice(start, start + limit).join('') },
      });
    }
    return { delivered: true, messageId: receipt?.msgId ?? receipt?.uuid ?? null };
  }

  async disconnect() {
    await this.monitor;
    await this.closeWebhook?.();
    this.closeWebhook = null;
    this.seen.clear();
  }
}
