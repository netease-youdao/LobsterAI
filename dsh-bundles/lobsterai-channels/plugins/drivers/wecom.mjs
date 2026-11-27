import { createDecipheriv, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';
import { detectImageMime, fetchBinaryWithLimit, isImageAttachment } from './media-utils.mjs';

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com';
const DEFAULT_WECOM_WS_URL = 'wss://openws.work.weixin.qq.com';
const HEARTBEAT_INTERVAL_MS = 30_000;
const SUBSCRIBE_TIMEOUT_MS = 15_000;
const INITIAL_RETRY_MS = 3_000;
const MAX_RETRY_MS = 60_000;
const INVALID_BOT_CREDENTIALS = 853000;
const WeComError = {
  Replaced: 'imWecomConnectionReplaced',
  InvalidCredentials: 'imWecomInvalidCredentials',
  Reconnecting: 'imWecomReconnecting',
};
const MAX_CACHED_REQ_IDS = 512;

function generateReqId(prefix) {
  return `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export function decryptWeComFile(encryptedBuf, aesKeyBase64) {
  const trimmed = String(aesKeyBase64 || '').trim();
  if (!trimmed) return encryptedBuf;
  const paddedKey = trimmed.endsWith('=') ? trimmed : `${trimmed}=`;
  const key = Buffer.from(paddedKey, 'base64');
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv(key.length === 16 ? 'aes-128-cbc' : 'aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
  if (decrypted.length === 0) return decrypted;
  const padLen = decrypted[decrypted.length - 1];
  if (padLen >= 1 && padLen <= 32 && padLen <= decrypted.length) {
    let validPad = true;
    for (let i = 0; i < padLen; i += 1) {
      if (decrypted[decrypted.length - 1 - i] !== padLen) {
        validPad = false;
        break;
      }
    }
    if (validPad) {
      return decrypted.subarray(0, decrypted.length - padLen);
    }
  }
  return decrypted;
}

function extractQuoteText(quote, options = {}) {
  if (!quote || typeof quote !== 'object') return '';
  if (quote.msgtype === 'text' && typeof quote.text?.content === 'string') {
    return quote.text.content.trim();
  }
  if (quote.msgtype === 'voice' && typeof quote.voice?.content === 'string') {
    return quote.voice.content.trim();
  }
  if (quote.msgtype === 'mixed' && Array.isArray(quote.mixed?.msg_item)) {
    const parts = quote.mixed.msg_item
      .filter((item) => item?.msgtype === 'text' && typeof item.text?.content === 'string')
      .map((item) => item.text.content.trim())
      .filter(Boolean);
    return parts.join('\n');
  }
  if (quote.msgtype === 'image') return options.suppressImagePlaceholder ? '' : '[图片]';
  if (quote.msgtype === 'file') {
    return options.suppressImagePlaceholder && isImageAttachment('', quote.file?.filename)
      ? ''
      : `[文件: ${String(quote.file?.filename || 'file')}]`;
  }
  return '';
}

export class WeComChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'wecom' });
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.ws = null;
    this.chatReqIds = new Map();
    this.pendingAcks = new Map();
  }

  get botId() {
    return String(this.config.botId || '').trim();
  }

  get corpId() {
    return String(this.config.corpId || '').trim();
  }

  get secret() {
    return String(this.config.secret || this.config.corpSecret || '').trim();
  }

  get webhookUrl() {
    return String(this.config.webhookUrl || '').trim();
  }

  get wsUrl() {
    return String(this.config.websocketUrl || DEFAULT_WECOM_WS_URL).trim();
  }

  get usesAiBotWs() {
    return Boolean(this.botId && this.secret && !this.webhookUrl && !this.corpId);
  }

  rememberReqId(chatId, reqId) {
    const key = String(chatId || '').trim();
    const val = String(reqId || '').trim();
    if (!key || !val) return;
    if (this.chatReqIds.has(key)) this.chatReqIds.delete(key);
    this.chatReqIds.set(key, val);
    while (this.chatReqIds.size > MAX_CACHED_REQ_IDS) {
      const oldest = this.chatReqIds.keys().next().value;
      if (oldest === undefined) break;
      this.chatReqIds.delete(oldest);
    }
  }

  async getAccessToken(signal) {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const id = this.corpId || this.botId;
    const url = `${WECOM_API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(id)}&corpsecret=${encodeURIComponent(this.secret)}`;
    const res = await fetch(url, { signal });
    const data = await res.json();
    if (!res.ok || data.errcode !== 0 || !data.access_token) {
      throw new Error(`WeCom gettoken failed: ${data.errmsg || res.status}`);
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000;
    return this.accessToken;
  }

  async extractWsInbound(frame, signal) {
    const body = frame?.body || {};
    const msgtype = String(body.msgtype || '').trim();
    const attachments = [];
    const textParts = [];
    let imgIdx = 0;

    const downloadEncryptedImage = async (url, aeskey, preferredName) => {
      try {
        const { buffer, contentType } = await fetchBinaryWithLimit(url, { signal });
        const effectiveKey = aeskey || body.aeskey;
        const plain = effectiveKey ? decryptWeComFile(buffer, effectiveKey) : buffer;
        const { mimeType, ext } = detectImageMime(plain, contentType);
        imgIdx += 1;
        attachments.push({
          kind: 'image',
          mimeType,
          dataBase64: plain.toString('base64'),
          sizeBytes: plain.byteLength,
          name: preferredName || `wecom-image-${String(body.msgid || Date.now())}-${imgIdx}.${ext}`,
        });
        return true;
      } catch (err) {
        console.warn('[WeComChannelDriver] image download/decrypt failed:', err instanceof Error ? err.message : String(err));
        return false;
      }
    };

    if (msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
      for (const item of body.mixed.msg_item) {
        if (item?.msgtype === 'text' && typeof item.text?.content === 'string') {
          textParts.push(item.text.content.trim());
        } else if (item?.msgtype === 'image' && item.image?.url) {
          await downloadEncryptedImage(item.image.url, item.image.aeskey);
        }
      }
    } else if (msgtype === 'voice') {
      const voiceText = typeof body.voice?.content === 'string' ? body.voice.content.trim() : '';
      if (voiceText) {
        textParts.push(voiceText);
      } else if (body.voice?.url) {
        try {
          const { buffer } = await fetchBinaryWithLimit(body.voice.url, { signal });
          const effectiveKey = body.voice.aeskey || body.aeskey;
          const plain = effectiveKey ? decryptWeComFile(buffer, effectiveKey) : buffer;
          attachments.push({
            kind: 'voice',
            dataBase64: plain.toString('base64'),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[WeComChannelDriver] voice download/decrypt failed:', message);
          attachments.push({ kind: 'voice', error: message });
        }
      }
    } else if (msgtype === 'image' && body.image?.url) {
      await downloadEncryptedImage(body.image.url, body.image.aeskey);
    } else if (msgtype === 'file' && body.file?.url && isImageAttachment('', body.file?.filename)) {
      await downloadEncryptedImage(body.file.url, body.file.aeskey, String(body.file.filename || '').trim() || undefined);
    } else if (typeof body.text?.content === 'string') {
      textParts.push(body.text.content.trim());
    }

    let quotedImageDownloaded = false;
    const quote = body.quote;
    if (quote && typeof quote === 'object') {
      if (quote.msgtype === 'image' && quote.image?.url) {
        quotedImageDownloaded = await downloadEncryptedImage(quote.image.url, quote.image.aeskey);
      } else if (quote.msgtype === 'mixed' && Array.isArray(quote.mixed?.msg_item)) {
        for (const item of quote.mixed.msg_item) {
          if (item?.msgtype === 'image' && item.image?.url) {
            const ok = await downloadEncryptedImage(item.image.url, item.image.aeskey);
            if (ok) quotedImageDownloaded = true;
          }
        }
      } else if (quote.msgtype === 'file' && quote.file?.url && isImageAttachment('', quote.file?.filename)) {
        quotedImageDownloaded = await downloadEncryptedImage(
          quote.file.url,
          quote.file.aeskey,
          String(quote.file.filename || '').trim() || undefined,
        );
      }
    }

    const quoteText = extractQuoteText(quote, { suppressImagePlaceholder: quotedImageDownloaded });
    const mainText = textParts.filter(Boolean).join('\n').trim();
    const text = quoteText ? (mainText ? `[引用: ${quoteText}]\n${mainText}` : `[引用: ${quoteText}]`) : mainText;
    return { text, attachments };
  }

  async connect(signal) {
    if (this.webhookUrl) {
      this.setState('connected', null, { mode: 'webhook' });
      return;
    }
    if (this.usesAiBotWs) {
      await this.connectAiBotWs(signal);
      return;
    }
    if ((!this.corpId && !this.botId) || !this.secret) {
      throw new Error('WeCom botId/corpId and secret (or webhookUrl) are required');
    }
    await this.getAccessToken(signal);
    this.setState('connected', null, { corpId: this.corpId || this.botId });
  }

  async connectAiBotWs(signal, retryDelay = INITIAL_RETRY_MS) {
    return new Promise((resolve, reject) => {
      // The WeCom gateway rejects the lowercase sec-websocket-key sent by Node's built-in client.
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      let authenticated = false;
      let terminalError = null;
      let heartbeatTimer = null;
      let pendingPing = null;
      const authReqId = generateReqId('aibot_subscribe');
      const subscribeTimer = setTimeout(() => ws.terminate(), SUBSCRIBE_TIMEOUT_MS);
      subscribeTimer.unref?.();

      const onAbort = () => {
        ws.terminate();
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      ws.addEventListener('open', () => {
        if (signal.aborted) return;
        ws.send(JSON.stringify({
          cmd: 'aibot_subscribe',
          headers: { req_id: authReqId },
          body: {
            bot_id: this.botId,
            secret: this.secret,
          },
        }));
        this.markStartupStage('wecom-subscribe-sent');
      });

      ws.addEventListener('message', (event) => {
        if (signal.aborted || terminalError || ws.readyState !== WebSocket.OPEN) return;
        let frame;
        try { frame = JSON.parse(String(event.data)); } catch { return; }
        const reqId = String(frame?.headers?.req_id || '');

        if (!frame.cmd && reqId === authReqId && !authenticated) {
          if (frame.errcode !== 0) {
            if (frame.errcode === INVALID_BOT_CREDENTIALS) terminalError = WeComError.InvalidCredentials;
            ws.terminate();
            return;
          }
          clearTimeout(subscribeTimer);
          authenticated = true;
          this.setState('connected', null, { botId: this.botId, mode: 'websocket' });
          heartbeatTimer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (pendingPing) return ws.terminate();
            pendingPing = generateReqId('ping');
            ws.send(JSON.stringify({ cmd: 'ping', headers: { req_id: pendingPing } }));
          }, HEARTBEAT_INTERVAL_MS);
          heartbeatTimer.unref?.();
          resolve();
          return;
        }

        if (!frame.cmd && reqId === pendingPing && frame.errcode === 0) {
          pendingPing = null;
          return;
        }

        if (!frame.cmd && this.pendingAcks.has(reqId)) {
          const waiter = this.pendingAcks.get(reqId);
          this.pendingAcks.delete(reqId);
          clearTimeout(waiter.timer);
          if (frame.errcode === 0 || frame.errcode === undefined) waiter.resolve(frame);
          else waiter.reject(new Error(`WeCom WS send failed (errcode=${frame.errcode}): ${frame.errmsg || ''}`));
          return;
        }

        if (frame.cmd === 'aibot_event_callback' && frame.body?.event?.eventtype === 'disconnected_event') {
          // WeCom grants the new subscriber ownership. Retrying here would evict it.
          terminalError = WeComError.Replaced;
          ws.terminate();
          return;
        }

        if (frame.cmd === 'aibot_msg_callback' && frame.body) {
          const body = frame.body;
          const senderId = String(body.from?.userid || '').trim();
          const isGroup = body.chattype === 'group';
          const chatId = String(body.chatid || (isGroup ? '' : senderId)).trim();
          if (reqId && chatId) this.rememberReqId(chatId, reqId);
          if (!senderId || !chatId || !this.isSenderAllowed(senderId)) return;

          void this.extractWsInbound(frame, signal)
            .then(({ text, attachments }) => {
              if (!text && attachments.length === 0) return;
              return this.onInbound({
                platform: 'wecom',
                instanceId: this.instanceId,
                chatId,
                senderId,
                text,
                ...(attachments.length > 0 ? { attachments } : {}),
                messageId: String(body.msgid || reqId),
                chatType: isGroup ? 'group' : 'direct',
                replyContext: { reqId, chatType: body.chattype },
              });
            })
            .catch((err) => {
              console.warn('[WeComChannelDriver] inbound handling failed:', err);
            });
        }
      });

      ws.addEventListener('close', () => {
        signal.removeEventListener('abort', onAbort);
        clearTimeout(subscribeTimer);
        clearInterval(heartbeatTimer);
        if (signal.aborted || this.ws !== ws) return;
        this.ws = null;
        this.clearPendingAcks();
        this.chatReqIds.clear();
        if (terminalError) {
          if (authenticated) this.setState('error', terminalError);
          else reject(new Error(terminalError));
          return;
        }
        this.setState('reconnecting', WeComError.Reconnecting);
        // A retrying driver is running. Release the initial sync even if its first attempt failed.
        resolve();
        const delay = authenticated ? INITIAL_RETRY_MS : retryDelay;
        void this.retryAiBotWs(signal, delay);
      });

      // ws always emits close after a transport error. That handler owns the only retry.
      ws.addEventListener('error', () => {});
    });
  }

  async retryAiBotWs(signal, delay) {
    await sleepAbortable(delay, signal);
    if (signal.aborted) return;
    try {
      await this.connectAiBotWs(signal, Math.min(delay * 2, MAX_RETRY_MS));
    } catch (error) {
      if (!signal.aborted) this.setState('error', error.message);
    }
  }

  sendWsFrameWithAck(cmd, reqId, body) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== 'connected') {
      return Promise.reject(new Error('WeCom AI Bot WebSocket is not connected'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(reqId);
        reject(new Error(`WeCom WS ${cmd} ack timed out`));
      }, 8_000);
      timer.unref?.();
      this.pendingAcks.set(reqId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ cmd, headers: { req_id: reqId }, body }));
      } catch (err) {
        clearTimeout(timer);
        this.pendingAcks.delete(reqId);
        reject(err);
      }
    });
  }

  clearPendingAcks() {
    for (const waiter of this.pendingAcks.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('WeCom AI Bot WebSocket disconnected'));
    }
    this.pendingAcks.clear();
  }

  async disconnect() {
    this.clearPendingAcks();
    this.chatReqIds.clear();
    this.ws = null;
  }

  async sendMessage({ chatId, text, replyContext }) {
    const content = String(text || '');
    if (this.webhookUrl) {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content },
        }),
      });
      const data = await res.json();
      if (!res.ok || data.errcode !== 0) {
        throw new Error(`WeCom webhook send failed: ${data.errmsg || res.status}`);
      }
      return { delivered: true };
    }

    if (this.usesAiBotWs) {
      const targetChat = String(chatId || '').trim();
      const callbackReqId = String(replyContext?.reqId || this.chatReqIds.get(targetChat) || '').trim();
      if (callbackReqId) {
        try {
          await this.sendWsFrameWithAck('aibot_respond_msg', callbackReqId, {
            msgtype: 'stream',
            stream: {
              id: generateReqId('stream'),
              finish: true,
              content,
            },
          });
          return { delivered: true };
        } catch {
          // Fall through to proactive aibot_send_msg if callback req_id expired.
        }
      }
      const sendReqId = generateReqId('aibot_send_msg');
      await this.sendWsFrameWithAck('aibot_send_msg', sendReqId, {
        chatid: targetChat,
        msgtype: 'markdown',
        markdown: { content },
      });
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
        text: { content },
      }),
    });
    const data = await res.json();
    if (!res.ok || data.errcode !== 0) {
      throw new Error(`WeCom sendMessage failed: ${data.errmsg || res.status}`);
    }
    return { messageId: String(data.msgid ?? '') };
  }
}
