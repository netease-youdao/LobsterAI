import { BaseChannelDriver } from './base-driver.mjs';

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com';

export class WeComChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'wecom' });
    this.accessToken = '';
    this.tokenExpiresAt = 0;
  }

  get corpId() {
    return String(this.config.corpId || this.config.botId || '').trim();
  }

  get secret() {
    return String(this.config.secret || this.config.corpSecret || '').trim();
  }

  get webhookUrl() {
    return String(this.config.webhookUrl || '').trim();
  }

  async getAccessToken(signal) {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const url = `${WECOM_API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`;
    const res = await fetch(url, { signal });
    const data = await res.json();
    if (!res.ok || data.errcode !== 0 || !data.access_token) {
      throw new Error(`WeCom gettoken failed: ${data.errmsg || res.status}`);
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000;
    return this.accessToken;
  }

  async connect(signal) {
    if (this.webhookUrl) {
      this.setState('connected', null, { mode: 'webhook' });
      return;
    }
    if (!this.corpId || !this.secret) {
      throw new Error('WeCom corpId/botId and secret (or webhookUrl) are required');
    }
    await this.getAccessToken(signal);
    this.setState('connected', null, { corpId: this.corpId });
  }

  async sendMessage({ chatId, text }) {
    if (this.webhookUrl) {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: String(text || '') },
        }),
      });
      const data = await res.json();
      if (!res.ok || data.errcode !== 0) {
        throw new Error(`WeCom webhook send failed: ${data.errmsg || res.status}`);
      }
      return { delivered: true };
    }

    const token = await this.getAccessToken();
    const res = await fetch(`${WECOM_API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        touser: chatId,
        msgtype: 'text',
        agentid: Number(this.config.agentId || 0),
        text: { content: String(text || '') },
      }),
    });
    const data = await res.json();
    if (!res.ok || data.errcode !== 0) {
      throw new Error(`WeCom sendMessage failed: ${data.errmsg || res.status}`);
    }
    return { messageId: String(data.msgid ?? '') };
  }
}
