/**
 * Direct HTTP calls to WeChat ilink API for QR code login.
 * Bypasses OpenClaw Gateway — works independently.
 */

import fs from 'fs';
import path from 'path';

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const POLL_TIMEOUT_MS = 35_000;

interface IlinkQrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface IlinkStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface WeixinQrCodeResult {
  qrcode: string;
  qrcodeUrl: string;
}

export interface WeixinPollResult {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
}

export async function fetchWeixinQrCode(): Promise<WeixinQrCodeResult> {
  const url = `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`;
  console.log('[WeixinLogin] fetching QR code from ilink API');

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)');
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} body=${body}`);
  }

  const data = await response.json() as IlinkQrCodeResponse;
  console.log('[WeixinLogin] QR code received, url length:', data.qrcode_img_content?.length ?? 0);

  return {
    qrcode: data.qrcode,
    qrcodeUrl: data.qrcode_img_content,
  };
}

export async function pollWeixinQrStatus(qrcode: string): Promise<WeixinPollResult> {
  const url = `${ILINK_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText} body=${body}`);
    }

    const data = await response.json() as IlinkStatusResponse;
    return {
      status: data.status,
      botToken: data.bot_token,
      accountId: data.ilink_bot_id,
      baseUrl: data.baseurl,
      userId: data.ilink_user_id,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  }
}

/**
 * Save weixin account credentials to OpenClaw state directory.
 * Mirrors openclaw-weixin plugin's saveWeixinAccount + registerWeixinAccountId.
 */
export function saveWeixinAccountToOpenClaw(
  stateDir: string,
  accountId: string,
  data: { token?: string; baseUrl?: string; userId?: string },
): void {
  const weixinDir = path.join(stateDir, 'openclaw-weixin');
  const accountsDir = path.join(weixinDir, 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });

  // Save account data (merge with existing)
  const accountPath = path.join(accountsDir, `${accountId}.json`);
  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(accountPath, 'utf-8')); } catch { return {}; }
  })();

  const merged = {
    ...(data.token ? { token: data.token, savedAt: new Date().toISOString() } : existing.token ? { token: existing.token, savedAt: existing.savedAt } : {}),
    ...(data.baseUrl ? { baseUrl: data.baseUrl } : existing.baseUrl ? { baseUrl: existing.baseUrl } : {}),
    ...(data.userId ? { userId: data.userId } : existing.userId ? { userId: existing.userId } : {}),
  };

  fs.writeFileSync(accountPath, JSON.stringify(merged, null, 2), 'utf-8');
  try { fs.chmodSync(accountPath, 0o600); } catch { /* best-effort */ }

  // Register account ID in index
  const indexPath = path.join(weixinDir, 'accounts.json');
  const ids: string[] = (() => {
    try { const arr = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); return Array.isArray(arr) ? arr : []; } catch { return []; }
  })();
  if (!ids.includes(accountId)) {
    ids.push(accountId);
    fs.writeFileSync(indexPath, JSON.stringify(ids, null, 2), 'utf-8');
  }

  console.log(`[WeixinLogin] saved account ${accountId} to ${accountPath}`);
}
