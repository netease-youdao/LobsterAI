import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';

const QQ_AUTH_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_API_BASE = 'https://api.sgroup.qq.com';

export class QQChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'qq' });
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.ws = null;
    this.heartbeatTimer = null;
    this.lastSeq = null;
  }

  get appId() {
    return String(this.config.appId || '').trim();
  }

  get clientSecret() {
    return String(this.config.clientSecret || this.config.appSecret || '').trim();
  }

  async getAccessToken(signal) {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const res = await fetch(QQ_AUTH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
      signal,
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error(`QQ access token failed (HTTP ${res.status})`);
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000;
    return this.accessToken;
  }

  async connect(signal) {
    if (!this.appId || !this.clientSecret) {
      throw new Error('QQ appId and clientSecret are required');
    }
    const token = await this.getAccessToken(signal);
    const gwRes = await fetch(`${QQ_API_BASE}/gateway`, {
      headers: { authorization: `QQBot ${token}` },
      signal,
    });
    const gw = await gwRes.json();
    if (!gwRes.ok || !gw.url) {
      throw new Error(`QQ gateway lookup failed (HTTP ${gwRes.status})`);
    }
    void this.runGateway(gw.url, signal);
  }

  async runGateway(wsUrl, signal) {
    while (!signal.aborted) {
      const token = await this.getAccessToken(signal);
      await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;
        const done = () => {
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
          }
          if (this.ws === ws) this.ws = null;
          resolve();
        };
        const onAbort = () => {
          try { ws.close(1000, 'stopped'); } catch {}
          done();
        };
        signal.addEventListener('abort', onAbort, { once: true });

        ws.addEventListener('message', (event) => {
          let payload;
          try { payload = JSON.parse(String(event.data)); } catch { return; }
          if (typeof payload.s === 'number') this.lastSeq = payload.s;
          if (payload.op === 10) {
            const interval = Number(payload.d?.heartbeat_interval || 30_000);
            this.heartbeatTimer = setInterval(() => {
              if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
            }, interval);
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token: `QQBot ${token}`,
                intents: 1 << 25, // GROUP_AND_C2C_EVENT
              },
            }));
          } else if (payload.t === 'READY') {
            this.setState('connected', null, { appId: this.appId, user: payload.d?.user });
          } else if (payload.t === 'C2C_MESSAGE_CREATE' || payload.t === 'GROUP_AT_MESSAGE_CREATE') {
            const d = payload.d || {};
            const text = String(d.content || '').trim();
            const isGroup = payload.t === 'GROUP_AT_MESSAGE_CREATE';
            const senderId = String(d.author?.user_openid || d.author?.member_openid || '');
            const chatId = isGroup ? String(d.group_openid || '') : senderId;
            if (!text || !chatId || !this.isSenderAllowed(senderId)) return;
            void this.onInbound({
              platform: 'qq',
              instanceId: this.instanceId,
              chatId,
              senderId,
              text,
              messageId: String(d.id || ''),
              chatType: isGroup ? 'group' : 'direct',
              replyContext: { isGroup, msgId: d.id },
            });
          }
        });

        ws.addEventListener('close', () => {
          signal.removeEventListener('abort', onAbort);
          done();
        });
        ws.addEventListener('error', () => {
          signal.removeEventListener('abort', onAbort);
          done();
        });
      });

      if (!signal.aborted) {
        this.setState('reconnecting', 'QQ gateway disconnected');
        await sleepAbortable(5_000, signal);
      }
    }
  }

  async disconnect() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try { this.ws?.close(1000, 'stopped'); } catch {}
    this.ws = null;
  }

  async sendMessage({ chatId, text, replyContext }) {
    const token = await this.getAccessToken();
    const isGroup = Boolean(replyContext?.isGroup);
    const endpoint = isGroup
      ? `${QQ_API_BASE}/v2/groups/${encodeURIComponent(chatId)}/messages`
      : `${QQ_API_BASE}/v2/users/${encodeURIComponent(chatId)}/messages`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content: String(text || ''),
        msg_type: 0,
        ...(replyContext?.msgId ? { msg_id: String(replyContext.msgId) } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`QQ sendMessage failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    return { messageId: String(data.id ?? '') };
  }
}
