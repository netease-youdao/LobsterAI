import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { BaseChannelDriver, sleepAbortable } from './base-driver.mjs';
import { DirectRecipientStore } from './direct-recipient-store.mjs';

export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const DEFAULT_ILINK_BOT_TYPE = '3';

const ILINK_APP_ID = 'bot';
const CHANNEL_VERSION = '2.4.3';
// uint32 encoded as 0x00MMNNPP -> 2.4.3 = (2<<16)|(4<<8)|3 = 132099
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 3;
const BOT_AGENT = 'LobsterAI/1.0';

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_START_TIMEOUT_MS = 15_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const NOTIFY_TIMEOUT_MS = 5_000;
const CDN_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_INBOUND_MEDIA_BYTES = 15 * 1024 * 1024;

const MESSAGE_ITEM_TYPE = Object.freeze({
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
});

const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_EXPIRED_PAUSE_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CACHED_CONTEXT_TOKENS = 512;

const TRANSIENT_QR_POLL_HTTP_STATUSES = new Set([502, 503, 504, 524]);

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function buildCommonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildPostHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (trimmed) {
    headers.Authorization = `Bearer ${trimmed}`;
  }
  return headers;
}

function buildBaseInfo() {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: BOT_AGENT,
  };
}

function normalizeOrigin(baseUrl) {
  return String(baseUrl || DEFAULT_WEIXIN_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_WEIXIN_BASE_URL;
}

function createRequestAbort(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => {
    controller.abort(parentSignal?.reason ?? new Error('Aborted'));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const timer =
    typeof timeoutMs === 'number' && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64 || '').trim(), 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`Invalid Weixin media aes_key (decoded ${decoded.length} bytes)`);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function resolveCdnDownloadUrl(media, cdnBaseUrl) {
  if (typeof media?.full_url === 'string' && media.full_url.trim()) {
    return media.full_url.trim();
  }
  const param = typeof media?.encrypt_query_param === 'string' ? media.encrypt_query_param.trim() : '';
  if (!param) {
    throw new Error('Weixin CDN media missing full_url and encrypt_query_param');
  }
  const base = normalizeOrigin(cdnBaseUrl || DEFAULT_WEIXIN_CDN_BASE_URL);
  return `${base}/download?encrypted_query_param=${encodeURIComponent(param)}`;
}

async function downloadWeixinCdnMedia({ media, hexAesKey, cdnBaseUrl, signal }) {
  const url = resolveCdnDownloadUrl(media, cdnBaseUrl);
  const reqAbort = createRequestAbort(CDN_DOWNLOAD_TIMEOUT_MS, signal);
  let rawBuf;
  try {
    const res = await fetch(url, { method: 'GET', signal: reqAbort.signal });
    if (!res.ok) {
      throw new Error(`Weixin CDN download failed (HTTP ${res.status})`);
    }
    rawBuf = Buffer.from(await res.arrayBuffer());
  } finally {
    reqAbort.cleanup();
  }
  if (rawBuf.byteLength > MAX_INBOUND_MEDIA_BYTES) {
    throw new Error(`Weixin CDN media too large (${rawBuf.byteLength} bytes)`);
  }
  const aesKeyBase64 =
    typeof hexAesKey === 'string' && hexAesKey.trim()
      ? Buffer.from(hexAesKey.trim(), 'hex').toString('base64')
      : (typeof media?.aes_key === 'string' ? media.aes_key.trim() : '');
  if (!aesKeyBase64) {
    console.warn('[WeixinChannelDriver] CDN media missing aes_key; returning raw bytes');
    return rawBuf;
  }
  return decryptAesEcb(rawBuf, parseAesKey(aesKeyBase64));
}

function detectImageMime(buf) {
  if (buf.byteLength >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (buf.byteLength >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.byteLength >= 4 && buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    return { mimeType: 'image/gif', ext: 'gif' };
  }
  if (
    buf.byteLength >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  return { mimeType: 'image/jpeg', ext: 'jpg' };
}

function isMediaItemType(type) {
  return (
    type === MESSAGE_ITEM_TYPE.IMAGE ||
    type === MESSAGE_ITEM_TYPE.VOICE ||
    type === MESSAGE_ITEM_TYPE.FILE ||
    type === MESSAGE_ITEM_TYPE.VIDEO
  );
}

function hasDownloadableMedia(media) {
  return Boolean(
    (typeof media?.full_url === 'string' && media.full_url.trim()) ||
    (typeof media?.encrypt_query_param === 'string' && media.encrypt_query_param.trim()),
  );
}

function extractInboundText(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  for (const item of items) {
    if (item?.type === MESSAGE_ITEM_TYPE.TEXT && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim();
      const ref = item.ref_msg;
      if (!ref || (ref.message_item && isMediaItemType(ref.message_item.type))) {
        return text;
      }
      const refParts = [];
      if (typeof ref.title === 'string' && ref.title.trim()) refParts.push(ref.title.trim());
      if (ref.message_item) {
        const refBody = extractInboundText([ref.message_item]);
        if (refBody) refParts.push(refBody);
      }
      if (refParts.length === 0) return text;
      return `[引用: ${refParts.join(' | ')}]\n${text}`.trim();
    }
    if (item?.type === MESSAGE_ITEM_TYPE.VOICE && typeof item.voice_item?.text === 'string') {
      const voiceText = item.voice_item.text.trim();
      if (voiceText) return voiceText;
    }
  }
  return '';
}

function parseSendReceipt(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('WEIXIN_SEND_INVALID_RESPONSE');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WEIXIN_SEND_INVALID_RESPONSE');
  }
  const hasInvalidRet = parsed.ret !== undefined && typeof parsed.ret !== 'number';
  const hasInvalidErrcode = parsed.errcode !== undefined && typeof parsed.errcode !== 'number';
  if (hasInvalidRet || hasInvalidErrcode) {
    throw new Error('WEIXIN_SEND_INVALID_RESPONSE');
  }
  const ret = typeof parsed.ret === 'number' ? parsed.ret : 0;
  const errcode = typeof parsed.errcode === 'number' ? parsed.errcode : 0;
  if (ret === 0 && errcode === 0) return;
  if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
    throw new Error(`WEIXIN_ACCOUNT_EXPIRED ret=${ret} errcode=${errcode}`);
  }
  const errmsg = typeof parsed.errmsg === 'string' ? parsed.errmsg.toLowerCase() : '';
  if (errmsg.includes('context_token')) {
    throw new Error(`WEIXIN_CONTEXT_EXPIRED ret=${ret} errcode=${errcode}`);
  }
  throw new Error(`WEIXIN_SEND_REJECTED ret=${ret} errcode=${errcode}`);
}

export class WeixinChannelDriver extends BaseChannelDriver {
  constructor(options) {
    super({ ...options, platform: 'weixin' });
    this.cursor = '';
    const account = String(this.config.accountId || '').trim();
    this.privateRecipients = new DirectRecipientStore('weixin', account, {
      legacyFile: account ? this.config.legacyContextFile : undefined,
      limit: MAX_CACHED_CONTEXT_TOKENS,
    });
  }

  get baseUrl() {
    return normalizeOrigin(this.config.baseUrl);
  }

  get cdnBaseUrl() {
    return normalizeOrigin(this.config.cdnBaseUrl || DEFAULT_WEIXIN_CDN_BASE_URL);
  }

  get token() {
    return String(this.config.botToken || this.config.token || '').trim();
  }

  get accountId() {
    return String(this.config.accountId || '').trim() || this.instanceId;
  }

  async extractInboundAttachments(items, msg, signal) {
    const attachments = [];
    if (!Array.isArray(items) || items.length === 0) return attachments;

    // 1. Voice messages without server-provided voice_item.text
    const voiceItem = items.find(
      (item) =>
        item?.type === MESSAGE_ITEM_TYPE.VOICE &&
        !(typeof item.voice_item?.text === 'string' && item.voice_item.text.trim()) &&
        hasDownloadableMedia(item.voice_item?.media),
    );
    if (voiceItem?.voice_item) {
      const voice = voiceItem.voice_item;
      try {
        const audioBuf = await downloadWeixinCdnMedia({
          media: voice.media,
          hexAesKey: voice.aeskey,
          cdnBaseUrl: this.cdnBaseUrl,
          signal,
        });
        attachments.push({
          kind: 'voice',
          dataBase64: audioBuf.toString('base64'),
          encodeType: typeof voice.encode_type === 'number' ? voice.encode_type : undefined,
          sampleRate: typeof voice.sample_rate === 'number' ? voice.sample_rate : undefined,
          playtimeMs: typeof voice.playtime === 'number' ? voice.playtime : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[WeixinChannelDriver] voice CDN download/decrypt failed:', message);
        attachments.push({ kind: 'voice', error: message });
      }
    }

    // 2. Image messages (or image inside a quoted message)
    const directImageItems = items.filter(
      (item) => item?.type === MESSAGE_ITEM_TYPE.IMAGE && hasDownloadableMedia(item.image_item?.media),
    );
    const imageItems =
      directImageItems.length > 0
        ? directImageItems
        : items
            .filter(
              (item) =>
                item?.type === MESSAGE_ITEM_TYPE.TEXT &&
                item.ref_msg?.message_item?.type === MESSAGE_ITEM_TYPE.IMAGE &&
                hasDownloadableMedia(item.ref_msg.message_item.image_item?.media),
            )
            .map((item) => item.ref_msg.message_item);

    for (let i = 0; i < imageItems.length; i += 1) {
      const img = imageItems[i]?.image_item;
      if (!img) continue;
      try {
        const imgBuf = await downloadWeixinCdnMedia({
          media: img.media,
          hexAesKey: img.aeskey,
          cdnBaseUrl: this.cdnBaseUrl,
          signal,
        });
        const { mimeType, ext } = detectImageMime(imgBuf);
        const suffix = imageItems.length > 1 ? `-${i + 1}` : '';
        attachments.push({
          kind: 'image',
          mimeType,
          dataBase64: imgBuf.toString('base64'),
          sizeBytes: imgBuf.byteLength,
          name: `weixin-image-${String(msg?.message_id || Date.now())}${suffix}.${ext}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[WeixinChannelDriver] image CDN download/decrypt failed:', message);
      }
    }

    return attachments;
  }

  rememberContextToken(chatId, contextToken) {
    const key = String(chatId || '').trim();
    const val = String(contextToken || '').trim();
    this.privateRecipients.remember(key, val);
  }

  async notifyLifecycle(endpoint, signal) {
    if (!this.token) return;
    const reqAbort = createRequestAbort(NOTIFY_TIMEOUT_MS, signal);
    try {
      await fetch(`${this.baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: buildPostHeaders(this.token),
        body: JSON.stringify({ base_info: buildBaseInfo() }),
        signal: reqAbort.signal,
      });
    } catch {
      // Best-effort lifecycle notification; never block startup/shutdown.
    } finally {
      reqAbort.cleanup();
    }
  }

  async connect(signal) {
    if (!this.token) {
      throw new Error('Weixin not configured: iLink token is required (complete QR login first)');
    }
    await this.notifyLifecycle('ilink/bot/msg/notifystart', signal);
    if (signal.aborted) return;
    this.setState('connected', null, { accountId: this.accountId });
    void this.pollLoop(signal);
  }

  async disconnect() {
    await this.notifyLifecycle('ilink/bot/msg/notifystop');
  }

  async pollLoop(signal) {
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      const reqAbort = createRequestAbort(nextTimeoutMs, signal);
      try {
        const res = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
          method: 'POST',
          headers: buildPostHeaders(this.token),
          body: JSON.stringify({
            get_updates_buf: this.cursor,
            base_info: buildBaseInfo(),
          }),
          signal: reqAbort.signal,
        });
        reqAbort.cleanup();

        if (!res.ok) {
          consecutiveFailures += 1;
          this.setState('reconnecting', `Weixin getupdates HTTP ${res.status}`);
          const delayMs = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
          await sleepAbortable(delayMs, signal);
          continue;
        }

        const data = await res.json();
        if (typeof data?.longpolling_timeout_ms === 'number' && data.longpolling_timeout_ms > 0) {
          nextTimeoutMs = data.longpolling_timeout_ms;
        }

        const isApiError =
          (data?.ret !== undefined && data.ret !== 0) ||
          (data?.errcode !== undefined && data.errcode !== 0);
        if (isApiError) {
          const isSessionExpired =
            data?.errcode === SESSION_EXPIRED_ERRCODE || data?.ret === SESSION_EXPIRED_ERRCODE;
          if (isSessionExpired) {
            consecutiveFailures = 0;
            this.setState(
              'error',
              `Weixin session expired (errcode=${SESSION_EXPIRED_ERRCODE}), please re-scan QR code`,
            );
            await sleepAbortable(SESSION_EXPIRED_PAUSE_MS, signal);
            continue;
          }

          consecutiveFailures += 1;
          const detail = data?.errmsg || `ret=${String(data?.ret ?? 0)} errcode=${String(data?.errcode ?? 0)}`;
          this.setState('reconnecting', `Weixin getupdates failed: ${detail}`);
          const delayMs = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
          await sleepAbortable(delayMs, signal);
          continue;
        }

        consecutiveFailures = 0;
        if (this.state !== 'connected') {
          this.setState('connected', null, { accountId: this.accountId });
        }

        if (typeof data?.get_updates_buf === 'string' && data.get_updates_buf !== '') {
          this.cursor = data.get_updates_buf;
        }

        const msgs = Array.isArray(data?.msgs) ? data.msgs : [];
        const eligibleMsgs = [];
        for (const msg of msgs) {
          // Ignore echoed bot messages (message_type === 2)
          if (msg?.message_type !== undefined && msg.message_type !== 1) continue;
          const senderId = String(msg?.from_user_id || '').trim();
          if (!senderId || !this.isSenderAllowed(senderId)) continue;
          if (msg?.context_token) {
            this.rememberContextToken(senderId, msg.context_token);
          }
          eligibleMsgs.push({ msg, senderId });
        }

        // Download CDN media for all messages in this poll batch concurrently so
        // multi-image bursts sent together arrive back-to-back in order.
        const preparedEvents = await Promise.all(
          eligibleMsgs.map(async ({ msg, senderId }) => {
            const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
            const text = extractInboundText(items);
            const attachments = await this.extractInboundAttachments(items, msg, signal);
            if (!text && attachments.length === 0) return null;
            return {
              platform: 'weixin',
              instanceId: this.instanceId,
              chatId: senderId,
              senderId,
              text,
              ...(attachments.length > 0 ? { attachments } : {}),
              messageId: String(msg?.message_id || ''),
              chatType: 'direct',
              replyContext: msg?.context_token ? { contextToken: String(msg.context_token) } : undefined,
            };
          }),
        );

        for (const event of preparedEvents) {
          if (!event) continue;
          try {
            await this.onInbound(event);
          } catch (inboundErr) {
            console.warn('[WeixinChannelDriver] inbound handler failed:', inboundErr);
          }
        }
      } catch (error) {
        reqAbort.cleanup();
        if (signal.aborted) return;
        // Normal long-poll timeout: immediately issue the next poll without entering reconnecting.
        if (reqAbort.didTimeout()) {
          continue;
        }
        consecutiveFailures += 1;
        this.setState('reconnecting', error instanceof Error ? error.message : String(error));
        const delayMs = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
        await sleepAbortable(delayMs, signal);
      }
    }
  }

  async sendMessage({ chatId, text, replyContext }) {
    if (!this.token) {
      throw new Error('Weixin not configured: iLink token is required');
    }
    let targetUserId = String(chatId || '').trim().replace(/^(?:[^:]+:)?direct:/i, '');
    const tokens = this.privateRecipients.entries;
    const replyToken = String(replyContext?.contextToken || '').trim();
    // OpenClaw lowercased its session keys. iLink requires the original peer ID.
    if (!replyToken && targetUserId === targetUserId.toLowerCase()) {
      const owner = String(this.config.userId || '').trim();
      const peers = new Set(tokens.keys());
      if (owner) peers.add(owner);
      const matches = [...peers].filter(peer => peer.toLowerCase() === targetUserId);
      if (matches.length > 1) throw new Error('WEIXIN_AMBIGUOUS_RECIPIENT');
      if (matches.length === 1) targetUserId = matches[0];
    }
    const contextToken = replyToken || tokens.get(targetUserId) || '';
    const clientId = `lobsterai-weixin-${randomUUID()}`;
    const reqAbort = createRequestAbort(API_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: buildPostHeaders(this.token),
        body: JSON.stringify({
          msg: {
            from_user_id: '',
            to_user_id: targetUserId,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: String(text || '') } }],
            ...(contextToken ? { context_token: contextToken } : {}),
          },
          base_info: buildBaseInfo(),
        }),
        signal: reqAbort.signal,
      });
      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`WEIXIN_SEND_HTTP_ERROR status=${res.status}`);
      }
      parseSendReceipt(rawText);
      return { delivered: true, messageId: clientId };
    } finally {
      reqAbort.cleanup();
    }
  }

  /**
   * Request a fresh Weixin iLink bot QR code via POST /ilink/bot/get_bot_qrcode.
   * Accepts either a baseUrl string or an options object.
   */
  static async startQrLogin(options) {
    const opts = typeof options === 'string' ? { baseUrl: options } : (options || {});
    const origin = normalizeOrigin(opts.baseUrl);
    const botType = String(opts.botType || DEFAULT_ILINK_BOT_TYPE).trim() || DEFAULT_ILINK_BOT_TYPE;
    const localTokenList = Array.isArray(opts.localTokenList)
      ? opts.localTokenList
          .filter((item) => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
          .slice(0, 10)
      : [];

    const reqAbort = createRequestAbort(opts.timeoutMs ?? QR_START_TIMEOUT_MS, opts.signal);
    try {
      const res = await fetch(
        `${origin}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        {
          method: 'POST',
          headers: buildPostHeaders(),
          body: JSON.stringify({ local_token_list: localTokenList }),
          signal: reqAbort.signal,
        },
      );
      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`Weixin QR code request failed (HTTP ${res.status}): ${rawText.slice(0, 200)}`);
      }
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error('Weixin QR code response was not valid JSON');
      }
      const qrcode = typeof data?.qrcode === 'string' ? data.qrcode.trim() : '';
      const qrcodeImgContent =
        typeof data?.qrcode_img_content === 'string' ? data.qrcode_img_content.trim() : '';
      if (!qrcode || !qrcodeImgContent) {
        const detail = data?.errmsg || (data?.ret !== undefined ? `ret=${data.ret}` : 'missing QR fields');
        throw new Error(`Weixin QR code response invalid: ${detail}`);
      }
      return {
        qrcode,
        qrcode_img_content: qrcodeImgContent,
        qrDataUrl: qrcodeImgContent,
      };
    } finally {
      reqAbort.cleanup();
    }
  }

  /**
   * Long-poll Weixin iLink QR scan status via GET /ilink/bot/get_qrcode_status.
   * Client-side timeouts and transient gateway timeouts return `{ status: 'wait' }`.
   */
  static async pollQrLogin(qrcode, options) {
    const opts = typeof options === 'string' ? { baseUrl: options } : (options || {});
    const origin = normalizeOrigin(opts.baseUrl);
    const trimmedCode = String(qrcode || '').trim();
    if (!trimmedCode) {
      throw new Error('Weixin QR code is required for status polling');
    }

    let endpoint = `${origin}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(trimmedCode)}`;
    if (typeof opts.verifyCode === 'string' && opts.verifyCode.trim()) {
      endpoint += `&verify_code=${encodeURIComponent(opts.verifyCode.trim())}`;
    }

    const reqAbort = createRequestAbort(opts.timeoutMs ?? QR_LONG_POLL_TIMEOUT_MS, opts.signal);
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: buildCommonHeaders(),
        signal: reqAbort.signal,
      });
      if (TRANSIENT_QR_POLL_HTTP_STATUSES.has(res.status)) {
        return { status: 'wait' };
      }
      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`Weixin QR status failed (HTTP ${res.status}): ${rawText.slice(0, 200)}`);
      }
      return JSON.parse(rawText);
    } catch (error) {
      if (opts.signal?.aborted) {
        throw error;
      }
      if (reqAbort.didTimeout() || (error instanceof Error && error.name === 'AbortError')) {
        return { status: 'wait' };
      }
      if (error instanceof TypeError) {
        // Transient network / socket drop during long-poll; let caller keep waiting.
        return { status: 'wait' };
      }
      throw error;
    } finally {
      reqAbort.cleanup();
    }
  }
}
