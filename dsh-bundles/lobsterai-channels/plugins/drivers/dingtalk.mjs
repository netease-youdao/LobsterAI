import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';
import { sendDingTalkCard } from './dingtalk-card.mjs';
import { DirectRecipientStore } from './direct-recipient-store.mjs';
import {
  createTimeoutSignal,
  detectImageMime,
  fetchBinaryWithLimit,
  isImageAttachment,
} from './media-utils.mjs';

const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const API_TIMEOUT_MS = 15_000;

function resolveContentObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractQuotedMsgText(container, maxDepth = 3, options = {}) {
  if (maxDepth <= 0 || !container || !container.isReplyMsg || !container.repliedMsg) {
    return '';
  }
  const replied = container.repliedMsg;
  const msgType = String(replied.msgType || 'text');
  const contentObj = resolveContentObject(replied.content);

  let bodyText = '';
  switch (msgType) {
    case 'text': {
      bodyText = String(contentObj?.text || replied.text || '').trim();
      if (contentObj?.isReplyMsg) {
        const nested = extractQuotedMsgText(contentObj, maxDepth - 1, options);
        if (nested) bodyText = bodyText ? `${bodyText}\n${nested}` : nested;
      }
      break;
    }
    case 'richText': {
      const richList = Array.isArray(contentObj?.richText) ? contentObj.richText : [];
      bodyText = richList
        .filter((item) => item?.text && item.msgType !== 'skill' && !item.skillData)
        .map((item) => String(item.text))
        .join('')
        .trim();
      break;
    }
    case 'audio':
      bodyText = String(contentObj?.recognition || '').trim() || '[语音]';
      break;
    case 'picture':
      bodyText = options.suppressImagePlaceholder ? '' : '[图片]';
      break;
    case 'file':
      bodyText = options.suppressImagePlaceholder && isImageAttachment('', contentObj?.fileName)
        ? ''
        : `[文件: ${String(contentObj?.fileName || 'unknown')}]`;
      break;
    default:
      bodyText = String(contentObj?.text || '').trim();
      break;
  }

  return bodyText ? `[引用: ${bodyText}]` : '';
}

export class DingTalkChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'dingtalk' });
    this.ws = null;
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.privateRecipients = new DirectRecipientStore('dingtalk', this.clientId && JSON.stringify([this.instanceId, this.clientId]));
  }

  get clientId() {
    return String(this.config.clientId || this.config.appKey || '').trim();
  }

  get clientSecret() {
    return String(this.config.clientSecret || this.config.appSecret || '').trim();
  }

  async getAppAccessToken(signal) {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const reqAbort = createTimeoutSignal(API_TIMEOUT_MS, signal);
    try {
      const res = await fetch(`${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appKey: this.clientId,
          appSecret: this.clientSecret,
        }),
        signal: reqAbort.signal,
      });
      const data = await res.json();
      if (!res.ok || !data?.accessToken) {
        throw new Error(`DingTalk accessToken failed: ${data?.message || res.status}`);
      }
      this.accessToken = String(data.accessToken);
      this.tokenExpiresAt = Date.now() + Number(data.expireIn || 7200) * 1000;
      return this.accessToken;
    } finally {
      reqAbort.cleanup();
    }
  }

  async downloadByCode(downloadCode, signal) {
    const token = await this.getAppAccessToken(signal);
    const reqAbort = createTimeoutSignal(API_TIMEOUT_MS, signal);
    let downloadUrl = '';
    try {
      const res = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/messageFiles/download`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          downloadCode: String(downloadCode),
          robotCode: this.clientId,
        }),
        signal: reqAbort.signal,
      });
      const data = await res.json();
      if (!res.ok || !data?.downloadUrl) {
        throw new Error(`DingTalk messageFiles/download failed: ${data?.message || res.status}`);
      }
      downloadUrl = String(data.downloadUrl);
    } finally {
      reqAbort.cleanup();
    }
    return fetchBinaryWithLimit(downloadUrl, { signal });
  }

  async extractInboundPayload(payload, signal) {
    const msgtype = String(payload?.msgtype || 'text').trim();
    const content = resolveContentObject(payload?.content);
    const attachments = [];
    let text = '';

    const downloadImageRef = async (pictureUrl, downloadCode, labelId, preferredName) => {
      try {
        const { buffer, contentType } = pictureUrl
          ? await fetchBinaryWithLimit(pictureUrl, { signal })
          : await this.downloadByCode(downloadCode, signal);
        const { mimeType, ext } = detectImageMime(buffer, contentType);
        attachments.push({
          kind: 'image',
          mimeType,
          dataBase64: buffer.toString('base64'),
          sizeBytes: buffer.byteLength,
          name: preferredName || `dingtalk-image-${labelId}.${ext}`,
        });
        return true;
      } catch (err) {
        console.warn('[DingTalkChannelDriver] image download failed:', err instanceof Error ? err.message : String(err));
        return false;
      }
    };

    const downloadQuotedImages = async (container, baseLabel) => {
      const replied = container?.isReplyMsg ? container.repliedMsg : null;
      if (!replied) return false;
      const repliedContent = resolveContentObject(replied.content);
      let downloaded = false;
      if (replied.msgType === 'picture') {
        const picUrl = String(repliedContent?.pictureUrl || '').trim();
        const code = String(repliedContent?.downloadCode || repliedContent?.pictureDownloadCode || '').trim();
        if (picUrl || code) {
          downloaded = await downloadImageRef(picUrl, code, baseLabel);
        }
      } else if (replied.msgType === 'file') {
        const fileName = String(repliedContent?.fileName || '').trim();
        const code = String(repliedContent?.downloadCode || '').trim();
        if (code && isImageAttachment('', fileName)) {
          downloaded = await downloadImageRef('', code, baseLabel, fileName);
        }
      } else if (replied.msgType === 'richText') {
        const richList = Array.isArray(repliedContent?.richText) ? repliedContent.richText : [];
        let quoteImgIdx = 0;
        for (const item of richList) {
          if (!item || typeof item !== 'object') continue;
          const picUrl = String(item.pictureUrl || '').trim();
          const code = String(item.downloadCode || item.pictureDownloadCode || '').trim();
          if (picUrl || (code && (!item.type || item.type === 'picture' || item.msgType === 'picture'))) {
            quoteImgIdx += 1;
            const ok = await downloadImageRef(picUrl, code, `${baseLabel}-quote-${quoteImgIdx}`);
            if (ok) downloaded = true;
          }
        }
      }
      return downloaded;
    };

    const downloadVoiceCode = async (downloadCode) => {
      try {
        const { buffer } = await this.downloadByCode(downloadCode, signal);
        attachments.push({
          kind: 'voice',
          dataBase64: buffer.toString('base64'),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[DingTalkChannelDriver] voice download failed:', message);
        attachments.push({ kind: 'voice', error: message });
      }
    };

    switch (msgtype) {
      case 'text': {
        const rawText = String(payload?.text?.content || '').trim();
        const quotedImageDownloaded = await downloadQuotedImages(payload?.text, payload?.msgId || Date.now());
        const quoted = extractQuotedMsgText(payload?.text, 3, {
          suppressImagePlaceholder: quotedImageDownloaded,
        });
        text = quoted ? (rawText ? `${quoted}\n${rawText}` : quoted) : rawText;

        const replied = payload?.text?.repliedMsg;
        const repliedContent = resolveContentObject(replied?.content);
        if (replied?.msgType === 'audio' && !text && repliedContent?.downloadCode) {
          await downloadVoiceCode(repliedContent.downloadCode);
        }
        break;
      }
      case 'audio': {
        const recognition = String(content?.recognition || payload?.audio?.recognition || '').trim();
        if (recognition && recognition !== '[语音消息]') {
          text = recognition;
        } else {
          const code = String(content?.downloadCode || payload?.audio?.downloadCode || '').trim();
          if (code) {
            await downloadVoiceCode(code);
          } else {
            attachments.push({ kind: 'voice', error: 'DingTalk audio message missing downloadCode and recognition' });
          }
        }
        break;
      }
      case 'picture': {
        const pictureUrl = String(content?.pictureUrl || payload?.picture?.pictureUrl || '').trim();
        const downloadCode = String(
          content?.downloadCode
            || content?.pictureDownloadCode
            || payload?.picture?.downloadCode
            || '',
        ).trim();
        if (pictureUrl || downloadCode) {
          await downloadImageRef(pictureUrl, downloadCode, payload?.msgId || Date.now());
        }
        break;
      }
      case 'file': {
        const fileName = String(content?.fileName || '').trim();
        const downloadCode = String(content?.downloadCode || '').trim();
        if (downloadCode && isImageAttachment('', fileName)) {
          await downloadImageRef('', downloadCode, payload?.msgId || Date.now(), fileName);
        }
        break;
      }
      case 'richText': {
        const richList = Array.isArray(content?.richText)
          ? content.richText
          : (Array.isArray(payload?.richText?.richTextList) ? payload.richText.richTextList : []);
        const textParts = [];
        let imgIdx = 0;
        for (const item of richList) {
          if (!item || typeof item !== 'object') continue;
          const isSkill = item.type === 'skill' || Boolean(item.skillData);
          if (typeof item.text === 'string' && item.text.trim() && !isSkill) {
            textParts.push(item.text.trim());
          }
          const picUrl = String(item.pictureUrl || '').trim();
          const code = String(item.downloadCode || item.pictureDownloadCode || '').trim();
          if (picUrl || (code && (!item.type || item.type === 'picture' || item.msgType === 'picture'))) {
            imgIdx += 1;
            await downloadImageRef(picUrl, code, `${payload?.msgId || Date.now()}-${imgIdx}`);
          } else if (item.downloadCode && item.type === 'audio') {
            await downloadVoiceCode(item.downloadCode);
          }
        }
        const quotedImageDownloaded = await downloadQuotedImages(content, payload?.msgId || Date.now());
        const quoted = extractQuotedMsgText(content, 3, {
          suppressImagePlaceholder: quotedImageDownloaded,
        });
        const joined = textParts.join('\n').trim();
        text = quoted ? (joined ? `${quoted}\n${joined}` : quoted) : joined;
        break;
      }
      case 'markdown': {
        text = String(payload?.text?.content || content?.text || '').trim();
        break;
      }
      default: {
        text = String(payload?.text?.content || content?.text || '').trim();
        break;
      }
    }

    return { text, attachments };
  }

  async connect(signal) {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('DingTalk clientId and clientSecret are required');
    }
    await this.runLoop(signal);
  }

  async openStreamEndpoint(signal) {
    const reqAbort = createTimeoutSignal(API_TIMEOUT_MS, signal);
    try {
      const res = await fetch(`${DINGTALK_API_BASE}/v1.0/gateway/connections/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
          ua: 'lobsterai-dsh-channels/1.0',
        }),
        signal: reqAbort.signal,
      });
      const data = await res.json();
      if (!res.ok || !data?.endpoint || !data?.ticket) {
        throw new Error(`DingTalk stream open failed: ${data?.message || res.status}`);
      }
      return `${data.endpoint}?ticket=${encodeURIComponent(data.ticket)}`;
    } finally {
      reqAbort.cleanup();
    }
  }

  async runLoop(signal) {
    const firstWsUrl = await this.openStreamEndpoint(signal);
    this.setState('connected', null, { clientId: this.clientId });
    void this.maintainStream(firstWsUrl, signal);
  }

  async maintainStream(initialWsUrl, signal) {
    let wsUrl = initialWsUrl;
    while (!signal.aborted) {
      if (!wsUrl) {
        try {
          wsUrl = await this.openStreamEndpoint(signal);
          this.setState('connected', null, { clientId: this.clientId });
        } catch (err) {
          if (signal.aborted) return;
          this.setState('reconnecting', err instanceof Error ? err.message : String(err));
          await sleepAbortable(5_000, signal);
          continue;
        }
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
          if (frame.type === 'SYSTEM' && frame.headers?.topic === 'disconnect') {
            try { ws.close(1000, 'server_disconnect'); } catch {}
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
            const senderId = String(payload.senderStaffId || payload.senderId || '').trim();
            const isDirect = payload.conversationType === '1';
            const chatId = String(payload.conversationId || (isDirect ? senderId : '')).trim();
            if (!senderId || !chatId || !this.isSenderAllowed(senderId)) return;
            if (isDirect && payload.conversationId && payload.senderStaffId) {
              this.privateRecipients.remember(String(payload.conversationId), String(payload.senderStaffId));
            }

            void this.extractInboundPayload(payload, signal)
              .then(({ text, attachments }) => {
                if (!text && attachments.length === 0) return;
                return this.onInbound({
                  platform: 'dingtalk',
                  instanceId: this.instanceId,
                  chatId,
                  senderId,
                  senderName: payload.senderNick || senderId,
                  text,
                  ...(attachments.length > 0 ? { attachments } : {}),
                  messageId: String(payload.msgId || frame.headers?.messageId || ''),
                  chatType: isDirect ? 'direct' : 'group',
                  replyContext: {
                    sessionWebhook: payload.sessionWebhook,
                    senderStaffId: payload.senderStaffId,
                    conversationType: payload.conversationType,
                  },
                });
              })
              .catch((err) => {
                console.warn('[DingTalkChannelDriver] inbound handling failed:', err);
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

      // Stream tickets are single-use/short-lived; obtain a fresh ticket on reconnect.
      wsUrl = '';
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

  async sendMessage({ chatId, text, replyContext }) {
    const content = String(text || '');
    const webhook = String(replyContext?.sessionWebhook || this.config.webhookUrl || '').trim();
    const target = String(chatId || '').trim().replace(/^(?:[^:]+:)?direct:/i, '');
    const staffId = replyContext?.conversationType === '1' && replyContext.senderStaffId
      ? String(replyContext.senderStaffId) : this.privateRecipients.entries.get(target);
    const isGroup = replyContext?.conversationType
      ? replyContext.conversationType === '2' : (!staffId && target.startsWith('cid'));
    const groupMode = isGroup ? this.config.groupReplyMode : undefined;
    const markdown = {
      title: content.split('\n', 1)[0].replace(/^[#*\s>-]+/, '').slice(0, 20) || 'Message',
      text: content,
    };
    const plain = groupMode === 'text';
    const cardTarget = isGroup ? target : staffId || (!target.startsWith('cid') ? target : '');
    let token;
    if (cardTarget && this.clientId && this.clientSecret && !plain && groupMode !== 'markdown') {
      try {
        token = await this.getAppAccessToken();
      } catch (error) {
        if (!webhook) throw error;
      }
      if (token) {
        const receipt = await sendDingTalkCard({ token, robotCode: this.clientId, target: cardTarget, isGroup, text: content });
        if (receipt) return receipt;
      }
    }
    if (webhook) {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(plain ? { msgtype: 'text', text: { content } } : { msgtype: 'markdown', markdown }),
      });
      if (!res.ok) {
        throw new Error(`DingTalk sendMessage failed (HTTP ${res.status})`);
      }
      const ack = await res.json();
      if (ack.errcode !== 0) throw new Error(`DingTalk webhook did not accept the message: ${ack.errmsg ?? ack.errcode}`);
      return { delivered: true };
    }

    // Proactive OpenAPI fallback when no sessionWebhook is present (e.g. scheduled tasks)
    if (!target) {
      throw new Error('DingTalk sendMessage requires sessionWebhook or chatId');
    }
    token ??= await this.getAppAccessToken();
    const url = isGroup
      ? `${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`
      : `${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`;
    const useMarkdown = !plain && (groupMode === 'markdown' || /^[#*>-]|[*_`#\[\]\n]/.test(content));
    const body = {
      robotCode: this.clientId,
      ...(isGroup ? { openConversationId: target } : { userIds: [staffId || target] }),
      msgKey: useMarkdown ? 'sampleMarkdown' : 'sampleText',
      msgParam: JSON.stringify(useMarkdown ? markdown : { content }),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`DingTalk proactive send failed (HTTP ${res.status}): ${await res.text()}`);
    }
    if (isGroup) return { delivered: true };
    const receipt = await res.json();
    if (!receipt.processQueryKey || receipt.invalidStaffIdList?.length || receipt.flowControlledStaffIdList?.length) {
      throw new Error('DingTalk did not accept the message for the selected private recipient');
    }
    return { delivered: true, messageId: receipt.processQueryKey };
  }
}
