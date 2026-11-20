import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';

const DINGTALK_API_BASE = 'https://api.dingtalk.com';

export class DingTalkChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'dingtalk' });
    this.ws = null;
  }

  get clientId() {
    return String(this.config.clientId || this.config.appKey || '').trim();
  }

  get clientSecret() {
    return String(this.config.clientSecret || this.config.appSecret || '').trim();
  }

  async connect(signal) {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('DingTalk clientId and clientSecret are required');
    }
    const res = await fetch(`${DINGTALK_API_BASE}/v1.0/gateway/connections/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
        ua: 'lobsterai-dsh-channels/1.0',
      }),
      signal,
    });
    const data = await res.json();
    if (!res.ok || !data.endpoint || !data.ticket) {
      throw new Error(`DingTalk stream open failed: ${data.message || res.status}`);
    }
    const wsUrl = `${data.endpoint}?ticket=${encodeURIComponent(data.ticket)}`;
    this.setState('connected', null, { clientId: this.clientId });
    void this.runStream(wsUrl, signal);
  }

  async runStream(wsUrl, signal) {
    while (!signal.aborted) {
      await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;
        const done = () => {
          if (this.ws === ws) this.ws = null;
          resolve();
        };
        const onAbort = () => {
          try { ws.close(1000, 'stopped'); } catch {}
          done();
        };
        signal.addEventListener('abort', onAbort, { once: true });

        ws.addEventListener('message', (event) => {
          let frame;
          try { frame = JSON.parse(String(event.data)); } catch { return; }
          if (frame.type === 'SYSTEM' && frame.headers?.topic === 'ping') {
            ws.send(JSON.stringify({
              code: 200,
              headers: frame.headers,
              message: 'OK',
              data: frame.data,
            }));
            return;
          }
          if (frame.type === 'CALLBACK' && frame.headers?.messageId) {
            ws.send(JSON.stringify({
              code: 200,
              headers: {
                contentType: 'application/json',
                messageId: frame.headers.messageId,
              },
              message: 'OK',
              data: '{}',
            }));
            let payload;
            try { payload = JSON.parse(String(frame.data || '{}')); } catch { return; }
            const text = String(payload.text?.content || '').trim();
            const senderId = String(payload.senderStaffId || payload.senderId || '');
            if (!text || !this.isSenderAllowed(senderId)) return;
            void this.onInbound({
              platform: 'dingtalk',
              instanceId: this.instanceId,
              chatId: String(payload.conversationId || senderId),
              senderId,
              senderName: payload.senderNick || senderId,
              text,
              messageId: String(payload.msgId || ''),
              chatType: payload.conversationType === '1' ? 'direct' : 'group',
              replyContext: { sessionWebhook: payload.sessionWebhook },
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
        this.setState('reconnecting', 'DingTalk stream disconnected');
        await sleepAbortable(5_000, signal);
      }
    }
  }

  async disconnect() {
    try { this.ws?.close(1000, 'stopped'); } catch {}
    this.ws = null;
  }

  async sendMessage({ text, replyContext }) {
    const webhook = String(replyContext?.sessionWebhook || this.config.webhookUrl || '').trim();
    if (!webhook) {
      throw new Error('DingTalk reply requires sessionWebhook or configured webhookUrl');
    }
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: String(text || '') },
      }),
    });
    if (!res.ok) {
      throw new Error(`DingTalk sendMessage failed (HTTP ${res.status})`);
    }
    return { delivered: true };
  }
}
