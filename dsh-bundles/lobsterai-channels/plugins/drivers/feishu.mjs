import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';
import { formatCardMarkdown } from './card-markdown.mjs';
import {
  createTimeoutSignal,
  detectImageMime,
  fetchBinaryWithLimit,
  isImageAttachment,
} from './media-utils.mjs';

const API_TIMEOUT_MS = 15_000;
const DEFAULT_PING_INTERVAL_MS = 120_000;
const FRAGMENT_TTL_MS = 15_000;

const FRAME_METHOD = Object.freeze({
  CONTROL: 0,
  DATA: 1,
});

// ── Minimal pbbp2 Protobuf Codec (Feishu WebSocket binary framing) ──────────

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 70n) throw new Error('Invalid pbbp2 varint');
  }
  throw new Error('Truncated pbbp2 varint');
}

function writeVarint(chunks, value) {
  let v = BigInt.asUintN(64, BigInt(value));
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  chunks.push(Buffer.from(out));
}

function writeBytesField(chunks, fieldNo, bytes) {
  writeVarint(chunks, (fieldNo << 3) | 2);
  writeVarint(chunks, bytes.length);
  chunks.push(Buffer.from(bytes));
}

function writeStringField(chunks, fieldNo, str) {
  writeBytesField(chunks, fieldNo, Buffer.from(String(str), 'utf8'));
}

function skipWireField(buf, offset, wireType) {
  if (wireType === 0) return readVarint(buf, offset).nextOffset;
  if (wireType === 1) return offset + 8;
  if (wireType === 2) {
    const { value: len, nextOffset } = readVarint(buf, offset);
    return nextOffset + Number(len);
  }
  if (wireType === 5) return offset + 4;
  throw new Error(`Unsupported pbbp2 wireType=${wireType}`);
}

function decodePbbp2Header(buf) {
  let offset = 0;
  let key = '';
  let value = '';
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    offset = tag.nextOffset;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === 2 && (fieldNo === 1 || fieldNo === 2)) {
      const lenRes = readVarint(buf, offset);
      const len = Number(lenRes.value);
      const slice = buf.subarray(lenRes.nextOffset, lenRes.nextOffset + len);
      offset = lenRes.nextOffset + len;
      const text = Buffer.from(slice).toString('utf8');
      if (fieldNo === 1) key = text;
      else value = text;
    } else {
      offset = skipWireField(buf, offset, wireType);
    }
  }
  return { key, value };
}

function encodePbbp2Header(header) {
  const chunks = [];
  writeStringField(chunks, 1, header.key ?? '');
  writeStringField(chunks, 2, header.value ?? '');
  return Buffer.concat(chunks);
}

export function decodePbbp2Frame(rawBuffer) {
  const buf = rawBuffer instanceof Uint8Array
    ? rawBuffer
    : new Uint8Array(rawBuffer);
  const frame = {
    SeqID: 0n,
    LogID: 0n,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: '',
    payloadType: '',
    payload: new Uint8Array(0),
    LogIDNew: '',
  };

  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    offset = tag.nextOffset;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);

    if (wireType === 0) {
      const val = readVarint(buf, offset);
      offset = val.nextOffset;
      if (fieldNo === 1) frame.SeqID = val.value;
      else if (fieldNo === 2) frame.LogID = val.value;
      else if (fieldNo === 3) frame.service = Number(BigInt.asIntN(32, val.value));
      else if (fieldNo === 4) frame.method = Number(BigInt.asIntN(32, val.value));
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, offset);
      const len = Number(lenRes.value);
      const slice = buf.subarray(lenRes.nextOffset, lenRes.nextOffset + len);
      offset = lenRes.nextOffset + len;
      if (fieldNo === 5) frame.headers.push(decodePbbp2Header(slice));
      else if (fieldNo === 6) frame.payloadEncoding = Buffer.from(slice).toString('utf8');
      else if (fieldNo === 7) frame.payloadType = Buffer.from(slice).toString('utf8');
      else if (fieldNo === 8) frame.payload = slice;
      else if (fieldNo === 9) frame.LogIDNew = Buffer.from(slice).toString('utf8');
    } else {
      offset = skipWireField(buf, offset, wireType);
    }
  }
  return frame;
}

export function encodePbbp2Frame(frame) {
  const chunks = [];
  writeVarint(chunks, (1 << 3) | 0);
  writeVarint(chunks, frame.SeqID ?? 0n);
  writeVarint(chunks, (2 << 3) | 0);
  writeVarint(chunks, frame.LogID ?? 0n);
  writeVarint(chunks, (3 << 3) | 0);
  writeVarint(chunks, BigInt.asUintN(64, BigInt(frame.service ?? 0)));
  writeVarint(chunks, (4 << 3) | 0);
  writeVarint(chunks, BigInt.asUintN(64, BigInt(frame.method ?? 0)));

  for (const header of frame.headers ?? []) {
    writeBytesField(chunks, 5, encodePbbp2Header(header));
  }
  if (frame.payloadEncoding) writeStringField(chunks, 6, frame.payloadEncoding);
  if (frame.payloadType) writeStringField(chunks, 7, frame.payloadType);
  if (frame.payload && frame.payload.length > 0) writeBytesField(chunks, 8, frame.payload);
  if (frame.LogIDNew) writeStringField(chunks, 9, frame.LogIDNew);
  return Buffer.concat(chunks);
}

function cleanFeishuText(rawText, mentions) {
  let out = String(rawText || '');
  if (Array.isArray(mentions)) {
    for (const m of mentions) {
      if (!m?.key) continue;
      out = out.split(String(m.key)).join('');
    }
  }
  return out.replace(/@_user_\d+/g, '').trim();
}

function extractPostContent(parsedContent) {
  const textParts = [];
  const imageKeys = [];
  // Feishu post content may be { title, content: [[...]] } or locale-keyed { zh_cn: { title, content } }
  let postObj = parsedContent;
  if (postObj && !Array.isArray(postObj.content)) {
    const firstLocale = Object.values(postObj).find(
      (v) => v && typeof v === 'object' && Array.isArray(v.content),
    );
    if (firstLocale) postObj = firstLocale;
  }
  if (typeof postObj?.title === 'string' && postObj.title.trim()) {
    textParts.push(postObj.title.trim());
  }
  const paragraphs = Array.isArray(postObj?.content) ? postObj.content : [];
  for (const row of paragraphs) {
    if (!Array.isArray(row)) continue;
    const lineParts = [];
    for (const elem of row) {
      if (!elem || typeof elem !== 'object') continue;
      if ((elem.tag === 'text' || elem.tag === 'a') && typeof elem.text === 'string') {
        lineParts.push(elem.text);
      } else if (elem.tag === 'img' && typeof elem.image_key === 'string' && elem.image_key.trim()) {
        imageKeys.push(elem.image_key.trim());
      }
    }
    const line = lineParts.join('').trim();
    if (line) textParts.push(line);
  }
  return { text: textParts.join('\n').trim(), imageKeys };
}

export class FeishuChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'feishu' });
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.ws = null;
    this.fragments = new Map();
    this.threadModes = new Map();
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
    const reqAbort = createTimeoutSignal(API_TIMEOUT_MS, signal);
    try {
      const res = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        signal: reqAbort.signal,
      });
      const data = await res.json();
      if (!res.ok || data.code !== 0 || !data.tenant_access_token) {
        throw new Error(`Feishu token request failed: ${data.msg || res.status}`);
      }
      this.accessToken = data.tenant_access_token;
      this.tokenExpiresAt = Date.now() + Number(data.expire || 7200) * 1000;
      return this.accessToken;
    } finally {
      reqAbort.cleanup();
    }
  }

  async downloadMessageResource(messageId, fileKey, resourceType, signal) {
    const token = await this.getTenantAccessToken(signal);
    const url = `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(resourceType)}`;
    return fetchBinaryWithLimit(url, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
  }

  async fetchMessageById(messageId, signal) {
    const token = await this.getTenantAccessToken(signal);
    const reqAbort = createTimeoutSignal(API_TIMEOUT_MS, signal);
    try {
      const res = await fetch(
        `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
          signal: reqAbort.signal,
        },
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.code !== 0) return null;
      const items = data?.data?.items;
      return Array.isArray(items) && items.length > 0 ? items[0] : null;
    } catch {
      return null;
    } finally {
      reqAbort.cleanup();
    }
  }

  async isThreadGroup(chatId, signal) {
    const cached = this.threadModes.get(chatId);
    if (cached && cached.expiresAt > Date.now()) return cached.threaded;

    const reqAbort = createTimeoutSignal(API_TIMEOUT_MS, signal);
    try {
      const token = await this.getTenantAccessToken(reqAbort.signal);
      const res = await fetch(`${this.baseUrl}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: reqAbort.signal,
      });
      const body = await res.json();
      if (!res.ok || body.code !== 0) return false;
      const threaded = body.data?.chat_mode === 'topic' || body.data?.group_message_type === 'thread';
      this.threadModes.delete(chatId);
      if (this.threadModes.size >= 512) this.threadModes.delete(this.threadModes.keys().next().value);
      this.threadModes.set(chatId, { threaded, expiresAt: Date.now() + 60 * 60 * 1000 });
      return threaded;
    } catch {
      return false;
    } finally {
      reqAbort.cleanup();
    }
  }

  mergeEventFragments(messageId, sum, seq, payload) {
    const total = Number(sum || 1);
    const index = Number(seq || 0);
    if (!Number.isFinite(total) || total <= 1) {
      return JSON.parse(Buffer.from(payload).toString('utf8'));
    }
    const now = Date.now();
    for (const [k, entry] of this.fragments.entries()) {
      if (now - entry.createdAt > FRAGMENT_TTL_MS) this.fragments.delete(k);
    }
    let bucket = this.fragments.get(messageId);
    if (!bucket || bucket.parts.length !== total) {
      bucket = { createdAt: now, parts: new Array(total).fill(null) };
      this.fragments.set(messageId, bucket);
    }
    if (index >= 0 && index < total) {
      bucket.parts[index] = Buffer.from(payload);
    }
    if (bucket.parts.some((p) => p === null)) {
      return null;
    }
    this.fragments.delete(messageId);
    return JSON.parse(Buffer.concat(bucket.parts).toString('utf8'));
  }

  async handleFeishuEventPayload(eventEnvelope, signal) {
    const eventType = eventEnvelope?.header?.event_type || eventEnvelope?.type;
    if (eventType !== 'im.message.receive_v1') return;

    const event = eventEnvelope?.event;
    const message = event?.message;
    const sender = event?.sender;
    if (!message || !sender) return;
    if (sender.sender_type === 'bot' || sender.sender_type === 'app') return;

    const senderId = String(sender.sender_id?.open_id || sender.sender_id?.user_id || '').trim();
    const isGroup = message.chat_type !== 'p2p';
    const chatId = String(message.chat_id || (isGroup ? '' : senderId)).trim();
    const messageId = String(message.message_id || '').trim();
    if (!senderId || !chatId || !this.isSenderAllowed(senderId)) return;

    let parsedContent = {};
    if (typeof message.content === 'string' && message.content.trim()) {
      try {
        parsedContent = JSON.parse(message.content);
      } catch {
        parsedContent = {};
      }
    }

    const msgType = String(message.message_type || 'text').trim();
    let text = '';
    const attachments = [];

    if (msgType === 'text') {
      text = cleanFeishuText(parsedContent.text, message.mentions);
    } else if (msgType === 'post') {
      const post = extractPostContent(parsedContent);
      text = cleanFeishuText(post.text, message.mentions);
      for (let i = 0; i < post.imageKeys.length; i += 1) {
        try {
          const { buffer, contentType } = await this.downloadMessageResource(
            messageId,
            post.imageKeys[i],
            'image',
            signal,
          );
          const { mimeType, ext } = detectImageMime(buffer, contentType);
          attachments.push({
            kind: 'image',
            mimeType,
            dataBase64: buffer.toString('base64'),
            sizeBytes: buffer.byteLength,
            name: `feishu-image-${messageId}-${i + 1}.${ext}`,
          });
        } catch (err) {
          console.warn('[FeishuChannelDriver] post image download failed:', err instanceof Error ? err.message : String(err));
        }
      }
    } else if (msgType === 'audio') {
      const fileKey = String(parsedContent.file_key || '').trim();
      if (fileKey && messageId) {
        try {
          const { buffer } = await this.downloadMessageResource(messageId, fileKey, 'file', signal);
          attachments.push({
            kind: 'voice',
            dataBase64: buffer.toString('base64'),
            playtimeMs: typeof parsedContent.duration === 'number' ? parsedContent.duration : undefined,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn('[FeishuChannelDriver] audio download failed:', errMsg);
          attachments.push({ kind: 'voice', error: errMsg });
        }
      } else {
        attachments.push({ kind: 'voice', error: 'Feishu audio message missing file_key' });
      }
    } else if (msgType === 'image') {
      const imageKey = String(parsedContent.image_key || '').trim();
      if (imageKey && messageId) {
        try {
          const { buffer, contentType } = await this.downloadMessageResource(messageId, imageKey, 'image', signal);
          const { mimeType, ext } = detectImageMime(buffer, contentType);
          attachments.push({
            kind: 'image',
            mimeType,
            dataBase64: buffer.toString('base64'),
            sizeBytes: buffer.byteLength,
            name: `feishu-image-${messageId}.${ext}`,
          });
        } catch (err) {
          console.warn('[FeishuChannelDriver] image download failed:', err instanceof Error ? err.message : String(err));
        }
      }
    } else if (msgType === 'file') {
      const fileKey = String(parsedContent.file_key || '').trim();
      const fileName = String(parsedContent.file_name || '').trim();
      if (fileKey && messageId && isImageAttachment('', fileName)) {
        try {
          const { buffer, contentType } = await this.downloadMessageResource(messageId, fileKey, 'file', signal);
          const { mimeType, ext } = detectImageMime(buffer, contentType);
          attachments.push({
            kind: 'image',
            mimeType,
            dataBase64: buffer.toString('base64'),
            sizeBytes: buffer.byteLength,
            name: fileName || `feishu-image-${messageId}.${ext}`,
          });
        } catch (err) {
          console.warn('[FeishuChannelDriver] image file download failed:', err instanceof Error ? err.message : String(err));
        }
      }
    }

    // Best-effort: if user replied to a parent image/post message, attach the quoted original image(s).
    const parentId = String(message.parent_id || '').trim();
    if (attachments.length === 0 && parentId) {
      const parentMsg = await this.fetchMessageById(parentId, signal);
      const parentType = String(parentMsg?.msg_type || '').trim();
      let parentContent = {};
      if (typeof parentMsg?.body?.content === 'string' && parentMsg.body.content.trim()) {
        try {
          parentContent = JSON.parse(parentMsg.body.content);
        } catch {
          parentContent = {};
        }
      }
      if (parentType === 'image' && typeof parentContent.image_key === 'string' && parentContent.image_key.trim()) {
        try {
          const { buffer, contentType } = await this.downloadMessageResource(
            parentId,
            parentContent.image_key.trim(),
            'image',
            signal,
          );
          const { mimeType, ext } = detectImageMime(buffer, contentType);
          attachments.push({
            kind: 'image',
            mimeType,
            dataBase64: buffer.toString('base64'),
            sizeBytes: buffer.byteLength,
            name: `feishu-image-${parentId}.${ext}`,
          });
        } catch (err) {
          console.warn('[FeishuChannelDriver] quoted image download failed:', err instanceof Error ? err.message : String(err));
        }
      } else if (parentType === 'post') {
        const parentPost = extractPostContent(parentContent);
        for (let i = 0; i < parentPost.imageKeys.length; i += 1) {
          try {
            const { buffer, contentType } = await this.downloadMessageResource(
              parentId,
              parentPost.imageKeys[i],
              'image',
              signal,
            );
            const { mimeType, ext } = detectImageMime(buffer, contentType);
            attachments.push({
              kind: 'image',
              mimeType,
              dataBase64: buffer.toString('base64'),
              sizeBytes: buffer.byteLength,
              name: `feishu-image-${parentId}-${i + 1}.${ext}`,
            });
          } catch (err) {
            console.warn('[FeishuChannelDriver] quoted post image download failed:', err instanceof Error ? err.message : String(err));
          }
        }
      } else if (parentType === 'file') {
        const fileKey = String(parentContent.file_key || '').trim();
        const fileName = String(parentContent.file_name || '').trim();
        if (fileKey && isImageAttachment('', fileName)) {
          try {
            const { buffer, contentType } = await this.downloadMessageResource(parentId, fileKey, 'file', signal);
            const { mimeType, ext } = detectImageMime(buffer, contentType);
            attachments.push({
              kind: 'image',
              mimeType,
              dataBase64: buffer.toString('base64'),
              sizeBytes: buffer.byteLength,
              name: fileName || `feishu-image-${parentId}.${ext}`,
            });
          } catch (err) {
            console.warn('[FeishuChannelDriver] quoted image file download failed:', err instanceof Error ? err.message : String(err));
          }
        }
      }
    }

    if (!text && attachments.length === 0) return;

    const rootMessageId = String(message.root_id || '').trim();
    // Topic-group reply events can omit thread_id. A quote in a regular
    // group can also have root_id, so verify the group mode before using it.
    const threadId = isGroup && (String(message.thread_id || '').trim()
      || (rootMessageId && await this.isThreadGroup(chatId, signal) ? rootMessageId : ''));
    await this.onInbound({
      platform: 'feishu',
      instanceId: this.instanceId,
      chatId,
      senderId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      messageId,
      chatType: isGroup ? 'group' : 'direct',
      replyContext: {
        receiveIdType: 'chat_id',
        isGroup,
        replyToMessageId: messageId,
        ...(threadId ? { threadId, rootMessageId: rootMessageId || undefined, replyInThread: true } : {}),
      },
    });
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
        const parsedUrl = new URL(wsUrl);
        const serviceId = Number(parsedUrl.searchParams.get('service_id') || 0);
        let pingIntervalMs = Number(data?.data?.ClientConfig?.PingInterval || 120) * 1000;
        if (!Number.isFinite(pingIntervalMs) || pingIntervalMs < 5_000) {
          pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
        }

        await new Promise((resolve) => {
          const ws = new WebSocket(wsUrl);
          ws.binaryType = 'arraybuffer';
          this.ws = ws;
          let pingTimer = null;

          const sendPing = () => {
            if (ws.readyState !== 1) return;
            try {
              const pingBuf = encodePbbp2Frame({
                SeqID: 0n,
                LogID: 0n,
                service: serviceId,
                method: FRAME_METHOD.CONTROL,
                headers: [{ key: 'type', value: 'ping' }],
              });
              ws.send(pingBuf);
            } catch {
              // Ignore ping write errors; close handler will trigger reconnect.
            }
          };

          const done = () => {
            if (pingTimer) {
              clearInterval(pingTimer);
              pingTimer = null;
            }
            if (this.ws === ws) this.ws = null;
            resolve();
          };
          const onAbort = () => {
            try { ws.close(1000, 'stopped'); } catch {}
            done();
          };
          signal.addEventListener('abort', onAbort, { once: true });

          ws.addEventListener('open', () => {
            this.setState('connected', null, { appId: this.appId, domain: this.baseUrl });
            sendPing();
            pingTimer = setInterval(sendPing, pingIntervalMs);
            pingTimer.unref?.();
          });

          ws.addEventListener('message', (event) => {
            try {
              const raw = event.data instanceof ArrayBuffer
                ? new Uint8Array(event.data)
                : (ArrayBuffer.isView(event.data)
                    ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
                    : Buffer.from(String(event.data || '')));
              const frame = decodePbbp2Frame(raw);
              const headerMap = {};
              for (const h of frame.headers) {
                headerMap[h.key] = h.value;
              }

              if (frame.method === FRAME_METHOD.CONTROL) {
                if (headerMap.type === 'pong' && frame.payload.length > 0) {
                  try {
                    const pong = JSON.parse(Buffer.from(frame.payload).toString('utf8'));
                    if (typeof pong?.PingInterval === 'number' && pong.PingInterval >= 5) {
                      pingIntervalMs = pong.PingInterval * 1000;
                    }
                  } catch {}
                }
                return;
              }

              if (frame.method === FRAME_METHOD.DATA && headerMap.type === 'event') {
                const startMs = Date.now();
                const merged = this.mergeEventFragments(
                  headerMap.message_id || '',
                  headerMap.sum,
                  headerMap.seq,
                  frame.payload,
                );
                // Immediately send 200 OK ack frame back to Feishu within its 3s SLA
                if (ws.readyState === 1) {
                  const ackFrame = encodePbbp2Frame({
                    ...frame,
                    headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - startMs) }],
                    payload: Buffer.from(JSON.stringify({ code: 200 }), 'utf8'),
                  });
                  ws.send(ackFrame);
                }
                if (merged) {
                  void this.handleFeishuEventPayload(merged, signal).catch((err) => {
                    console.warn('[FeishuChannelDriver] event dispatch failed:', err);
                  });
                }
              }
            } catch (err) {
              console.warn('[FeishuChannelDriver] frame decode failed:', err instanceof Error ? err.message : String(err));
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
    this.fragments.clear();
    this.threadModes.clear();
  }

  async sendMessage({ chatId, text, replyContext }) {
    const token = await this.getTenantAccessToken();
    const recipient = String(chatId).trim().replace(/^(?:[^:]+:)?direct:/i, '').replace(/^user:(?=ou_)/i, '');
    const receiveIdType = String(replyContext?.receiveIdType || (recipient.startsWith('ou_') ? 'open_id' : 'chat_id'));
    const useReply = typeof replyContext?.replyInThread === 'boolean';
    const replyTo = String(replyContext?.replyToMessageId || '').trim();
    if (useReply && !replyTo) throw new Error('Feishu reply target is missing its message ID');
    const messagesUrl = `${this.baseUrl}/open-apis/im/v1/messages`;
    const url = useReply
      ? `${messagesUrl}/${encodeURIComponent(replyTo)}/reply`
      : `${messagesUrl}?receive_id_type=${encodeURIComponent(receiveIdType)}`;
    const send = async (msgType, content) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...(useReply ? { reply_in_thread: replyContext.replyInThread } : { receive_id: recipient }),
          msg_type: msgType,
          content: JSON.stringify(content),
        }),
      });
      return { res, data: await res.json() };
    };
    const markdown = String(text || '');
    const mode = this.config.replyMode ?? 'auto';
    const useCard = replyContext?.replyToMessageId && this.config.streaming === true
      && (mode === 'streaming' || (mode === 'auto' && replyContext.isGroup === false));
    const post = { zh_cn: { content: [[{ tag: 'md', text: markdown }]] } };
    let { res, data } = useCard
      ? await send('interactive', {
          schema: '2.0',
          config: { wide_screen_mode: true },
          body: { elements: [{ tag: 'markdown', content: formatCardMarkdown(markdown) }] },
        })
      : await send('post', post);
    // A rejected card (e.g. too many tables) can still render as a native post.
    if (useCard && data.code === 230099) ({ res, data } = await send('post', post));
    if (!res.ok || data.code !== 0) {
      throw new Error(`Feishu sendMessage failed: ${data.msg || res.status}`);
    }
    const messageId = String(data.data?.message_id ?? '').trim();
    if (!messageId) throw new Error('Feishu sendMessage did not acknowledge a message ID');
    return { messageId };
  }
}
