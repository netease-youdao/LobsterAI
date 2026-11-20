import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';

const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';

export class WeixinChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'weixin' });
    this.cursor = '';
  }

  get baseUrl() {
    return String(this.config.baseUrl || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, '');
  }

  get token() {
    return String(this.config.botToken || this.config.token || '').trim();
  }

  authHeaders() {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
  }

  async connect(signal) {
    if (!this.token) {
      throw new Error('Weixin iLink token is required (complete QR login first)');
    }
    this.setState('connected', null, { accountId: this.config.accountId || this.instanceId });
    void this.pollLoop(signal);
  }

  async pollLoop(signal) {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({ get_updates_buf: this.cursor }),
          signal,
        });
        if (!res.ok) {
          this.setState('reconnecting', `Weixin getupdates HTTP ${res.status}`);
          await sleepAbortable(4_000, signal);
          continue;
        }
        const data = await res.json();
        if (typeof data.get_updates_buf === 'string') {
          this.cursor = data.get_updates_buf;
        }
        const msgs = Array.isArray(data.msgs) ? data.msgs : [];
        for (const msg of msgs) {
          const senderId = String(msg.from_user_id || '');
          const textItem = Array.isArray(msg.item_list)
            ? msg.item_list.find((item) => item?.type === 1 && typeof item.text_item?.text === 'string')
            : null;
          const text = String(textItem?.text_item?.text || '').trim();
          if (!senderId || !text || !this.isSenderAllowed(senderId)) continue;
          await this.onInbound({
            platform: 'weixin',
            instanceId: this.instanceId,
            chatId: senderId,
            senderId,
            text,
            messageId: String(msg.message_id || ''),
            chatType: 'direct',
            replyContext: { contextToken: msg.context_token },
          });
        }
      } catch (error) {
        if (signal.aborted) return;
        this.setState('reconnecting', error instanceof Error ? error.message : String(error));
        await sleepAbortable(4_000, signal);
      }
    }
  }

  async sendMessage({ chatId, text, replyContext }) {
    const res = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        msg: {
          to_user_id: chatId,
          ...(replyContext?.contextToken ? { context_token: String(replyContext.contextToken) } : {}),
          item_list: [{ type: 1, text_item: { text: String(text || '') } }],
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Weixin sendmessage failed (HTTP ${res.status}): ${await res.text()}`);
    }
    return { delivered: true };
  }

  static async startQrLogin(baseUrl = DEFAULT_WEIXIN_BASE_URL) {
    const origin = String(baseUrl || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, '');
    const res = await fetch(`${origin}/ilink/bot/get_bot_qrcode?bot_type=3`);
    if (!res.ok) throw new Error(`Weixin QR code request failed (HTTP ${res.status})`);
    return res.json();
  }

  static async pollQrLogin(qrcode, baseUrl = DEFAULT_WEIXIN_BASE_URL) {
    const origin = String(baseUrl || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, '');
    const res = await fetch(
      `${origin}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(String(qrcode || ''))}`,
    );
    if (!res.ok) throw new Error(`Weixin QR status failed (HTTP ${res.status})`);
    return res.json();
  }
}
