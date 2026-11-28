import {
  isStrictDirectMessageAllowed,
  isStrictGroupMessageAllowed,
} from './access-policy.mjs';
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
const GENERAL_TOPIC_ID = 1;
const TELEGRAM_USER_PREFIX_RE = /^(?:tg|telegram|user):/i;
const TELEGRAM_GROUP_PREFIX_RE = /^(?:tg|telegram|group|chat):/i;

function acceptsGroupMessage(msg, bot, config) {
  if (config.groupPolicy === 'disabled') return false;
  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const username = bot?.username?.toLowerCase();
  const command = entities.find(entity => entity.type === 'bot_command' && entity.offset === 0);
  const commandTarget = command && text.slice(0, command.length).match(/^\/\w+@(\w+)$/)?.[1];
  if (commandTarget) return commandTarget.toLowerCase() === username;

  const groups = config.groups;
  if (!(groups?.[msg.chat.id]?.requireMention ?? groups?.['*']?.requireMention ?? true)) return true;
  const reply = msg.reply_to_message;
  if (bot?.id != null && reply?.from?.id === bot.id && !Object.keys(reply).some(key => /^(?:general_)?forum_topic_/.test(key))) {
    return true;
  }
  if (bot?.id != null && entities.some(entity => entity.type === 'text_mention' && entity.user?.id === bot.id)) return true;
  if (!username) return false;
  // Bot API entities use UTF-16 offsets, the same units as String.slice.
  if (entities.length) {
    return entities.some(entity => entity.type === 'mention'
      && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username}`);
  }
  return Array.from(text.matchAll(/(?<![\w@])@(\w+)/g)).some(match => match[1].toLowerCase() === username);
}

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

  async handleMessage(msg, signal) {
    const senderId = String(msg.from?.id ?? '').trim();
    const chatId = String(msg.chat?.id ?? '').trim();
    const isGroup = msg.chat?.type !== 'private';
    if (!chatId || !senderId) return;
    if (isGroup) {
      const groupConfig = this.config.groups?.[chatId] ?? this.config.groups?.['*'];
      if (!isStrictGroupMessageAllowed(this.config, {
        groupCandidates: [chatId],
        senderId,
        groupConfig,
        groupPrefixPattern: TELEGRAM_GROUP_PREFIX_RE,
        senderPrefixPattern: TELEGRAM_USER_PREFIX_RE,
      })) return;
      if (!acceptsGroupMessage(msg, this.botInfo, this.config)) return;
    } else if (!isStrictDirectMessageAllowed(this.config, senderId, TELEGRAM_USER_PREFIX_RE)) {
      return;
    }

    const { text, attachments } = await this.extractInboundPayload(msg, signal);
    if (!text && attachments.length === 0) return;

    // A regular group's reply can also carry message_thread_id. Only a
    // forum topic has its own conversation identity in OpenClaw.
    const isForum = isGroup && (msg.chat.is_forum || msg.is_topic_message);
    const topicId = msg.message_thread_id ?? GENERAL_TOPIC_ID;
    await this.onInbound({
      platform: 'telegram',
      instanceId: this.instanceId,
      chatId: isForum ? `${chatId}:topic:${topicId}` : chatId,
      senderId,
      senderName: msg.from?.username || msg.from?.first_name || senderId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      // Telegram allocates message numbers independently in each chat.
      messageId: msg.message_id == null ? undefined : `${chatId}:${msg.message_id}`,
      chatType: isGroup ? 'group' : 'direct',
      replyContext: { replyToMessageId: msg.message_id },
    });
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
          if (update.message) await this.handleMessage(update.message, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.setState('reconnecting', error instanceof Error ? error.message : String(error));
        await sleepAbortable(3_000, signal);
      }
    }
  }

  async sendMessage({ chatId, text }) {
    const topic = /^(-\d+):topic:(\d+)$/.exec(chatId);
    const threadId = topic && Number(topic[2]);
    const res = await fetch(this.apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: topic?.[1] ?? chatId,
        ...(threadId && threadId !== GENERAL_TOPIC_ID ? { message_thread_id: threadId } : {}),
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
