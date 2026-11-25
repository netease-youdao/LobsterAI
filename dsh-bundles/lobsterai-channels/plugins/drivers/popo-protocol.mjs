import { createDecipheriv } from 'node:crypto';

const API_ROOT = 'https://open.popo.netease.com/open-apis/robots/v1';

export class PopoApi {
  constructor(config, signal) {
    this.config = config;
    this.signal = signal;
    this.token = null;
    this.refresh = null;
  }

  async post(path, body, token) {
    const response = await fetch(API_ROOT + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'Open-Access-Token': token } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(12_000)]),
    });
    if (!response.ok) throw new Error('POPO ' + path + ' HTTP ' + response.status);
    return response.json();
  }

  async getToken() {
    if (this.token && this.token.accessExpiredAt > Date.now() + 60_000) return this.token.accessToken;
    if (!this.refresh) {
      const { appKey, appSecret } = this.config;
      this.refresh = this.post('/token', { appKey, appSecret }).then(result => {
        if (result.errcode !== 0 || !result.data?.accessToken) throw new Error('POPO token request failed (' + result.errcode + ')');
        this.token = result.data;
        return this.token.accessToken;
      }).finally(() => { this.refresh = null; });
    }
    return this.refresh;
  }

  async request(path, body) {
    const token = await this.getToken();
    let result = await this.post(path, body, token);
    if ([42001, 40014].includes(result.errcode)) {
      if (this.token?.accessToken === token) this.token = null;
      result = await this.post(path, body, await this.getToken());
    }
    if (result.errcode !== 0) throw new Error('POPO ' + path + ' failed (' + result.errcode + ')');
    return result.data;
  }
}

export function stompFrame(command, headers = {}) {
  return [command, ...Object.entries(headers).map(([k, v]) => k + ':' + v), '', '\0'].join('\n');
}

export function decryptPopoEvent(ciphertext, key) {
  const bytes = Buffer.from(key);
  if (bytes.length !== 32) throw new Error('Invalid POPO AES key length');
  const cipher = createDecipheriv('aes-128-cbc', bytes.subarray(0, 16), bytes.subarray(16));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64')), cipher.final()]).toString('utf8'));
}

export function readMercuryEvent(body, key) {
  const envelope = JSON.parse(body);
  if (envelope.messageType !== 'ROBOT_EVENT' || (envelope.timestamp && Date.now() - envelope.timestamp > 30 * 60_000)) return null;
  let data = envelope.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* Mercury also sends raw base64. */ }
  }
  const ciphertext = typeof data === 'string' ? data : data?.encrypt;
  const event = ciphertext ? decryptPopoEvent(ciphertext, key) : data;
  return event && { ...event, envelopeId: envelope.messageId };
}

export function popoMessage(event, robotUid) {
  const group = event?.eventType === 'IM_CHAT_TO_ROBOT_AT_MSG';
  if (!group && event?.eventType !== 'IM_P2P_TO_ROBOT_MSG') return null;
  const data = typeof event.eventData === 'string' ? JSON.parse(event.eventData) : event.eventData;
  const senderId = String(data?.from ?? '').trim();
  const chatId = group ? String(data?.sessionId ?? '').trim() : senderId;
  if (!senderId || !chatId || senderId === robotUid || typeof data.notify !== 'string') return null;
  // The group event is addressed to a bot by POPO. Where explicit recipients are
  // supplied, don't respond to mentions addressed only to another bot.
  const targets = [...(data.robotIds ?? []), ...(data.atList ?? [])];
  if (group && robotUid && targets.length && data.atType !== 2 && !targets.includes(robotUid)) return null;
  const text = (group ? data.notify.replace(/^@\S+\s+/, '') : data.notify).trim();
  if (!text) return null;
  return { chatType: group ? 'group' : 'direct', chatId, senderId, text,
    senderName: data.fromNick || senderId, messageId: String(data.uuid || event.envelopeId || '') };
}
