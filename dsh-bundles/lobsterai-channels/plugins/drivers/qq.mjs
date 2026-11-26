import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';
import {
  detectImageMime,
  fetchBinaryWithLimit,
  isAudioAttachment,
  isImageAttachment,
  normalizeMediaUrl,
} from './media-utils.mjs';

const QQ_AUTH_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_API_BASE = 'https://api.sgroup.qq.com';
const MAX_CACHED_MSG_SEQS = 512;

export class QQChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'qq' });
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.ws = null;
    this.heartbeatTimer = null;
    this.lastSeq = null;
    this.msgSeqCounters = new Map();
  }

  get appId() {
    return String(this.config.appId || '').trim();
  }

  get clientSecret() {
    return String(this.config.clientSecret || this.config.appSecret || '').trim();
  }

  nextMsgSeq(msgId) {
    const key = String(msgId || '').trim();
    if (!key) return 1;
    const next = (this.msgSeqCounters.get(key) || 0) + 1;
    if (this.msgSeqCounters.has(key)) this.msgSeqCounters.delete(key);
    this.msgSeqCounters.set(key, next);
    while (this.msgSeqCounters.size > MAX_CACHED_MSG_SEQS) {
      const oldest = this.msgSeqCounters.keys().next().value;
      if (oldest === undefined) break;
      this.msgSeqCounters.delete(oldest);
    }
    return next;
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

  async extractInboundPayload(d, signal) {
    let text = String(d?.content || '')
      .replace(/<@!?\w+>/g, '')
      .trim();
    const attachments = [];
    const rawAttachments = Array.isArray(d?.attachments) ? d.attachments : [];

    let imgIdx = 0;
    for (const att of rawAttachments) {
      if (!att || typeof att !== 'object') continue;
      const contentType = String(att.content_type || '').toLowerCase();
      const fileName = String(att.filename || '');
      const hasVoiceFields = Boolean(att.voice_wav_url || att.asr_refer_text);

      if (hasVoiceFields || isAudioAttachment(contentType, fileName)) {
        const asrText = typeof att.asr_refer_text === 'string' ? att.asr_refer_text.trim() : '';
        if (asrText && !text) {
          text = asrText;
          continue;
        }
        const audioUrl = normalizeMediaUrl(att.voice_wav_url) || normalizeMediaUrl(att.url);
        if (!audioUrl) {
          attachments.push({ kind: 'voice', error: 'QQ voice attachment missing URL' });
          continue;
        }
        try {
          const { buffer } = await fetchBinaryWithLimit(audioUrl, { signal });
          attachments.push({
            kind: 'voice',
            dataBase64: buffer.toString('base64'),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[QQChannelDriver] voice attachment download failed:', message);
          attachments.push({ kind: 'voice', error: message });
        }
      } else if (
        isImageAttachment(contentType, fileName || att.url) ||
        (
          !contentType.startsWith('video/') &&
          typeof att.width === 'number' &&
          att.width > 0 &&
          typeof att.height === 'number' &&
          att.height > 0
        )
      ) {
        const imgUrl = normalizeMediaUrl(att.url);
        if (!imgUrl) continue;
        try {
          imgIdx += 1;
          const { buffer, contentType: dlMime } = await fetchBinaryWithLimit(imgUrl, { signal });
          const { mimeType, ext } = detectImageMime(buffer, dlMime || contentType);
          attachments.push({
            kind: 'image',
            mimeType,
            dataBase64: buffer.toString('base64'),
            sizeBytes: buffer.byteLength,
            name: fileName || `qq-image-${String(d?.id || Date.now())}-${imgIdx}.${ext}`,
          });
        } catch (err) {
          console.warn('[QQChannelDriver] image attachment download failed:', err instanceof Error ? err.message : String(err));
        }
      }
    }

    return { text, attachments };
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
      let token;
      try {
        token = await this.getAccessToken(signal);
      } catch (err) {
        if (signal.aborted) return;
        this.setState('reconnecting', err instanceof Error ? err.message : String(err));
        await sleepAbortable(5_000, signal);
        continue;
      }

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
            this.heartbeatTimer.unref?.();
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
            const isGroup = payload.t === 'GROUP_AT_MESSAGE_CREATE';
            const senderId = String(d.author?.user_openid || d.author?.member_openid || '').trim();
            const chatId = isGroup ? String(d.group_openid || '').trim() : senderId;
            if (!chatId || !senderId || !this.isSenderAllowed(senderId)) return;

            void this.extractInboundPayload(d, signal)
              .then(({ text, attachments }) => {
                if (!text && attachments.length === 0) return;
                return this.onInbound({
                  platform: 'qq',
                  instanceId: this.instanceId,
                  chatId,
                  senderId,
                  text,
                  ...(attachments.length > 0 ? { attachments } : {}),
                  messageId: String(d.id || ''),
                  chatType: isGroup ? 'group' : 'direct',
                  replyContext: { isGroup, msgId: d.id },
                });
              })
              .catch((err) => {
                console.warn('[QQChannelDriver] inbound handling failed:', err);
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
    const msgId = replyContext?.msgId ? String(replyContext.msgId) : '';
    const content = String(text || '');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...(this.config.markdownSupport === false
          ? { msg_type: 0, content }
          : { msg_type: 2, markdown: { content } }),
        ...(msgId ? { msg_id: msgId, msg_seq: this.nextMsgSeq(msgId) } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`QQ sendMessage failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    return { messageId: String(data.id ?? '') };
  }
}
