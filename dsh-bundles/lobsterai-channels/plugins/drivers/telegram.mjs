import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export class TelegramChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'telegram' });
    this.offset = 0;
  }

  get token() {
    return String(this.config.botToken || this.config.token || '').trim();
  }

  apiUrl(method) {
    const base = String(this.config.apiBaseUrl || TELEGRAM_API_BASE).replace(/\/+$/, '');
    return `${base}/bot${this.token}/${method}`;
  }

  async connect(signal) {
    if (!this.token) {
      throw new Error('Telegram botToken is required');
    }
    const res = await fetch(this.apiUrl('getMe'), { signal });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram getMe failed: ${data.description || res.status}`);
    }
    this.setState('connected', null, {
      id: data.result?.id,
      username: data.result?.username,
    });
    void this.pollLoop(signal);
  }

  async pollLoop(signal) {
    while (!signal.aborted) {
      try {
        const res = await fetch(this.apiUrl('getUpdates'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            offset: this.offset,
            timeout: 25,
            allowed_updates: ['message'],
          }),
          signal,
        });
        const data = await res.json();
        if (!data.ok || !Array.isArray(data.result)) {
          await sleepAbortable(3_000, signal);
          continue;
        }
        for (const update of data.result) {
          if (typeof update.update_id === 'number') {
            this.offset = Math.max(this.offset, update.update_id + 1);
          }
          const msg = update.message;
          if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) continue;
          const senderId = String(msg.from?.id ?? '');
          if (!this.isSenderAllowed(senderId)) continue;
          await this.onInbound({
            platform: 'telegram',
            instanceId: this.instanceId,
            chatId: String(msg.chat?.id ?? ''),
            senderId,
            senderName: msg.from?.username || msg.from?.first_name || senderId,
            text: msg.text.trim(),
            messageId: String(msg.message_id ?? ''),
            chatType: msg.chat?.type === 'private' ? 'direct' : 'group',
          });
        }
      } catch (error) {
        if (signal.aborted) return;
        this.setState('reconnecting', error instanceof Error ? error.message : String(error));
        await sleepAbortable(3_000, signal);
      }
    }
  }

  async sendMessage({ chatId, text }) {
    const res = await fetch(this.apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text || '').slice(0, 4096),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram sendMessage failed: ${data.description || res.status}`);
    }
    return { messageId: String(data.result?.message_id ?? '') };
  }
}
