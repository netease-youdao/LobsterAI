import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export class DiscordChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'discord' });
    this.ws = null;
    this.heartbeatTimer = null;
    this.lastSeq = null;
    this.botUserId = null;
  }

  get token() {
    return String(this.config.botToken || this.config.token || '').trim();
  }

  authHeaders() {
    return {
      authorization: `Bot ${this.token}`,
      'content-type': 'application/json',
    };
  }

  async connect(signal) {
    if (!this.token) throw new Error('Discord botToken is required');
    const [meRes, gwRes] = await Promise.all([
      fetch(`${DISCORD_API_BASE}/users/@me`, { headers: this.authHeaders(), signal }),
      fetch(`${DISCORD_API_BASE}/gateway/bot`, { headers: this.authHeaders(), signal }),
    ]);
    if (!meRes.ok) throw new Error(`Discord auth failed (HTTP ${meRes.status})`);
    if (!gwRes.ok) throw new Error(`Discord gateway lookup failed (HTTP ${gwRes.status})`);
    const me = await meRes.json();
    const gw = await gwRes.json();
    this.botUserId = String(me.id || '');
    const wsUrl = `${String(gw.url || 'wss://gateway.discord.gg').replace(/\/+$/, '')}/?v=10&encoding=json`;
    void this.runGateway(wsUrl, me, signal);
  }

  async runGateway(wsUrl, me, signal) {
    while (!signal.aborted) {
      await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;
        const cleanup = () => {
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
          }
          if (this.ws === ws) this.ws = null;
          resolve();
        };
        const onAbort = () => {
          try {
            ws.close(1000, 'stopped');
          } catch {}
          cleanup();
        };
        signal.addEventListener('abort', onAbort, { once: true });

        ws.addEventListener('message', (event) => {
          let payload;
          try {
            payload = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (typeof payload.s === 'number') this.lastSeq = payload.s;
          if (payload.op === 10) {
            const interval = Number(payload.d?.heartbeat_interval || 41250);
            this.heartbeatTimer = setInterval(() => {
              if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
            }, interval);
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token: this.token,
                intents: 37377, // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
                properties: { os: process.platform, browser: 'lobsterai', device: 'lobsterai' },
              },
            }));
          } else if (payload.t === 'READY') {
            this.setState('connected', null, { id: me.id, username: me.username });
          } else if (payload.t === 'MESSAGE_CREATE' && payload.d) {
            const d = payload.d;
            if (d.author?.bot || d.author?.id === this.botUserId) return;
            const text = String(d.content || '').trim();
            if (!text) return;
            const senderId = String(d.author?.id || '');
            if (!this.isSenderAllowed(senderId)) return;
            void this.onInbound({
              platform: 'discord',
              instanceId: this.instanceId,
              chatId: String(d.channel_id || ''),
              senderId,
              senderName: d.author?.username || senderId,
              text,
              messageId: String(d.id || ''),
              chatType: d.guild_id ? 'group' : 'direct',
            });
          }
        });

        ws.addEventListener('close', () => {
          signal.removeEventListener('abort', onAbort);
          cleanup();
        });
        ws.addEventListener('error', () => {
          signal.removeEventListener('abort', onAbort);
          cleanup();
        });
      });

      if (!signal.aborted) {
        this.setState('reconnecting', 'Discord gateway disconnected');
        await sleepAbortable(3_000, signal);
      }
    }
  }

  async disconnect() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      this.ws?.close(1000, 'stopped');
    } catch {}
    this.ws = null;
  }

  async sendMessage({ chatId, text }) {
    const res = await fetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ content: String(text || '').slice(0, 2000) }),
    });
    if (!res.ok) {
      throw new Error(`Discord sendMessage failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    return { messageId: String(data.id ?? '') };
  }
}
