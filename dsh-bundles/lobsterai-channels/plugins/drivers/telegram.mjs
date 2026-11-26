import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';
import {
  createTimeoutSignal,
  detectImageMime,
  fetchBinaryWithLimit,
  isAudioAttachment,
  isImageAttachment,
} from './media-utils.mjs';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const API_TIMEOUT_MS = 15_000;

export class TelegramChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'telegram' });
    this.offset = 0;
  }

  get token() {
    return String(this.config.botToken || this.config.token || '').trim();
  }

  get baseOrigin() {
    return String(this.config.apiBaseUrl || TELEGRAM_API_BASE).replace(/\/+$/, '');
  }

  apiUrl(method) {
    return `${this.baseOrigin}/bot${this.token}/${method}`;
  }

  fileDownloadUrl(filePath) {
    return `${this.baseOrigin}/file/bot${this.token}/${String(filePath).replace(/^\/+/, '')}`;
  }

  async downloadFileById(fileId, signal) {
    const reqAbort = createTimeoutSignal(API_TIMEOUT_MS, signal);
    let filePath = '';
    try {
      const res = await fetch(this.apiUrl('getFile'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: String(fileId) }),
        signal: reqAbort.signal,
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || !data?.result?.file_path) {
        throw new Error(`Telegram getFile failed: ${data?.description || res.status}`);
      }
      filePath = String(data.result.file_path);
    } finally {
      reqAbort.cleanup();
    }
    return fetchBinaryWithLimit(this.fileDownloadUrl(filePath), { signal });
  }

  async extractInboundPayload(msg, signal) {
    let text = String(msg?.text || msg?.caption || '').trim();
    if (msg?.reply_to_message) {
      const quotedText = String(msg.reply_to_message.text || msg.reply_to_message.caption || '').trim();
      if (quotedText) {
        text = text ? `[引用: ${quotedText}]\n${text}` : `[引用: ${quotedText}]`;
      }
    }

    const attachments = [];
    const voiceObj = msg?.voice || msg?.audio || (
      msg?.document && isAudioAttachment(msg.document.mime_type, msg.document.file_name)
        ? msg.document
        : null
    );
    if (voiceObj?.file_id) {
      try {
        const { buffer } = await this.downloadFileById(voiceObj.file_id, signal);
        attachments.push({
          kind: 'voice',
          dataBase64: buffer.toString('base64'),
          playtimeMs: typeof voiceObj.duration === 'number' ? voiceObj.duration * 1000 : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[TelegramChannelDriver] voice download failed:', message);
        attachments.push({ kind: 'voice', error: message });
      }
    }

    const selectLargestPhoto = (photos) => {
      if (!Array.isArray(photos) || photos.length === 0) return null;
      let best = photos[photos.length - 1];
      let bestScore = Number(best?.file_size || 0) || (Number(best?.width || 0) * Number(best?.height || 0));
      for (const candidate of photos) {
        if (!candidate?.file_id) continue;
        const score = Number(candidate.file_size || 0) || (Number(candidate.width || 0) * Number(candidate.height || 0));
        if (score >= bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      return best;
    };

    const resolveMessageImageObj = (source) => {
      const photo = selectLargestPhoto(source?.photo);
      if (photo?.file_id) return photo;
      if (source?.document?.file_id && isImageAttachment(source.document.mime_type, source.document.file_name)) {
        return source.document;
      }
      return null;
    };

    const imageObj = resolveMessageImageObj(msg) ?? resolveMessageImageObj(msg?.reply_to_message);
    if (imageObj?.file_id) {
      try {
        const { buffer, contentType } = await this.downloadFileById(imageObj.file_id, signal);
        const { mimeType, ext } = detectImageMime(buffer, contentType || imageObj.mime_type);
        attachments.push({
          kind: 'image',
          mimeType,
          dataBase64: buffer.toString('base64'),
          sizeBytes: buffer.byteLength,
          name: imageObj.file_name || `telegram-image-${String(msg?.message_id || Date.now())}.${ext}`,
        });
      } catch (err) {
        console.warn('[TelegramChannelDriver] image download failed:', err instanceof Error ? err.message : String(err));
      }
    }

    return { text, attachments };
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
          if (!msg) continue;
          const senderId = String(msg.from?.id ?? '').trim();
          if (!senderId || !this.isSenderAllowed(senderId)) continue;

          const { text, attachments } = await this.extractInboundPayload(msg, signal);
          if (!text && attachments.length === 0) continue;

          await this.onInbound({
            platform: 'telegram',
            instanceId: this.instanceId,
            chatId: String(msg.chat?.id ?? ''),
            senderId,
            senderName: msg.from?.username || msg.from?.first_name || senderId,
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            messageId: String(msg.message_id ?? ''),
            chatType: msg.chat?.type === 'private' ? 'direct' : 'group',
            replyContext: { replyToMessageId: msg.message_id },
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
