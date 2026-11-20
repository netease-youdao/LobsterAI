import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';

export class FeishuChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'feishu' });
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.ws = null;
  }

  get baseUrl() {
    const domain = String(this.config.domain || 'feishu').toLowerCase();
    if (domain === 'lark') return 'https://open.larksuite.com';
    if (domain.startsWith('http://') || domain.startsWith('https://')) {
      return domain.replace(/\/+$/, '');
    }
    return 'https://open.feishu.cn';
  }

  get appId() {
    return String(this.config.appId || '').trim();
  }

  get appSecret() {
    return String(this.config.appSecret || '').trim();
  }

  async getTenantAccessToken(signal) {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const res = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal,
    });
    const data = await res.json();
    if (!res.ok || data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`Feishu token request failed: ${data.msg || res.status}`);
    }
    this.accessToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Number(data.expire || 7200) * 1000;
    return this.accessToken;
  }

  async connect(signal) {
    if (!this.appId || !this.appSecret) {
      throw new Error('Feishu appId and appSecret are required');
    }
    await this.getTenantAccessToken(signal);
    this.setState('connected', null, { appId: this.appId, domain: this.baseUrl });
    void this.maintainWsEndpoint(signal);
  }

  async maintainWsEndpoint(signal) {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.baseUrl}/callback/ws/endpoint`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', locale: 'zh' },
          body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
          signal,
        });
        const data = await res.json();
        const wsUrl = data?.data?.URL;
        if (!wsUrl) {
          await sleepAbortable(10_000, signal);
          continue;
        }
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
          ws.addEventListener('close', () => {
            signal.removeEventListener('abort', onAbort);
            done();
          });
          ws.addEventListener('error', () => {
            signal.removeEventListener('abort', onAbort);
            done();
          });
        });
      } catch (error) {
        if (signal.aborted) return;
        this.setState('reconnecting', error instanceof Error ? error.message : String(error));
        await sleepAbortable(5_000, signal);
      }
    }
  }

  async disconnect() {
    try { this.ws?.close(1000, 'stopped'); } catch {}
    this.ws = null;
  }

  async sendMessage({ chatId, text, replyContext }) {
    const token = await this.getTenantAccessToken();
    const receiveIdType = String(replyContext?.receiveIdType || 'chat_id');
    const url = `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: String(text || '') }),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.code !== 0) {
      throw new Error(`Feishu sendMessage failed: ${data.msg || res.status}`);
    }
    return { messageId: String(data.data?.message_id ?? '') };
  }
}
