import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';
import {
  detectImageMime,
  fetchBinaryWithLimit,
  isAudioAttachment,
  isImageAttachment,
} from './media-utils.mjs';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

function acceptsGuildMessage(message, botId, config) {
  if (config.groupPolicy === 'disabled') return false;
  const guilds = config.guilds;
  const requireMention = guilds?.[message.guild_id]?.requireMention ?? guilds?.['*']?.requireMention ?? true;
  return !requireMention || message.mention_everyone === true
    || message.mentions?.some(user => user.id === botId)
    || message.referenced_message?.author?.id === botId;
}

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

  async extractInboundPayload(d, signal) {
    let text = String(d?.content || '').trim();
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '').trim();
    }
    const referencedText = String(d?.referenced_message?.content || '').trim();
    if (referencedText) {
      text = text ? `[引用: ${referencedText}]\n${text}` : `[引用: ${referencedText}]`;
    }

    const attachments = [];
    const rawAttachments = Array.isArray(d?.attachments) ? d.attachments : [];
    let imgIdx = 0;

    const downloadImageAttachment = async (att) => {
      try {
        imgIdx += 1;
        const contentType = String(att.content_type || '').toLowerCase();
        const fileName = String(att.filename || '');
        const { buffer, contentType: dlMime } = await fetchBinaryWithLimit(att.url, { signal });
        const { mimeType, ext } = detectImageMime(buffer, dlMime || contentType);
        attachments.push({
          kind: 'image',
          mimeType,
          dataBase64: buffer.toString('base64'),
          sizeBytes: buffer.byteLength,
          name: fileName || `discord-image-${String(d?.id || Date.now())}-${imgIdx}.${ext}`,
        });
      } catch (err) {
        console.warn('[DiscordChannelDriver] image download failed:', err instanceof Error ? err.message : String(err));
      }
    };

    for (const att of rawAttachments) {
      if (!att || typeof att !== 'object' || !att.url) continue;
      const contentType = String(att.content_type || '').toLowerCase();
      const fileName = String(att.filename || '');

      if (isAudioAttachment(contentType, fileName)) {
        try {
          const { buffer } = await fetchBinaryWithLimit(att.url, { signal });
          attachments.push({
            kind: 'voice',
            dataBase64: buffer.toString('base64'),
            playtimeMs: typeof att.duration_secs === 'number'
              ? Math.round(att.duration_secs * 1000)
              : undefined,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[DiscordChannelDriver] voice download failed:', message);
          attachments.push({ kind: 'voice', error: message });
        }
      } else if (isImageAttachment(contentType, fileName || att.url)) {
        await downloadImageAttachment(att);
      }
    }

    // If the message itself had no images, include images from the replied-to message.
    if (imgIdx === 0 && Array.isArray(d?.referenced_message?.attachments)) {
      for (const att of d.referenced_message.attachments) {
        if (!att || typeof att !== 'object' || !att.url) continue;
        const contentType = String(att.content_type || '').toLowerCase();
        const fileName = String(att.filename || '');
        if (isImageAttachment(contentType, fileName || att.url)) {
          await downloadImageAttachment(att);
        }
      }
    }

    return { text, attachments };
  }

  async handleMessage(message, signal) {
    if (message.author?.bot || message.author?.id === this.botUserId) return;
    const senderId = String(message.author?.id || '').trim();
    const chatId = String(message.channel_id || '').trim();
    if (!senderId || !chatId || !this.isSenderAllowed(senderId)) return;
    if (message.guild_id && !acceptsGuildMessage(message, this.botUserId, this.config)) return;

    const { text, attachments } = await this.extractInboundPayload(message, signal);
    if (!text && attachments.length === 0) return;
    await this.onInbound({
      platform: 'discord',
      instanceId: this.instanceId,
      chatId,
      senderId,
      senderName: message.author?.username || senderId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      messageId: String(message.id || ''),
      chatType: message.guild_id ? 'group' : 'direct',
    });
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
            this.heartbeatTimer.unref?.();
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
            void this.handleMessage(payload.d, signal).catch((err) => {
              console.warn('[DiscordChannelDriver] inbound handling failed:', err);
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
