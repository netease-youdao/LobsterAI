export const NimQrLoginStatus = {
  Pending: 'pending',
  Success: 'success',
  Failed: 'failed',
} as const;

export type NimQrLoginStatus = typeof NimQrLoginStatus[keyof typeof NimQrLoginStatus];

export const NimQrLoginErrorCode = {
  RequestFailed: 'request_failed',
  InvalidPayload: 'invalid_payload',
  InvalidUserAgent: 'invalid_user_agent',
  Timeout: 'timeout',
} as const;

export type NimQrLoginErrorCode = typeof NimQrLoginErrorCode[keyof typeof NimQrLoginErrorCode];

export interface NimQrLoginCredentials {
  appKey: string;
  account: string;
  token: string;
}

export interface NimQrLoginStartResult {
  uuid: string;
  qrValue: string;
  expiresIn: number;
  pollInterval: number;
  credentialKind: 'split';
  rawData: Record<string, unknown> | null;
}

export interface NimQrLoginPollResult {
  status: NimQrLoginStatus;
  credentials?: NimQrLoginCredentials;
  errorCode?: NimQrLoginErrorCode;
  error?: string;
}

export const DEFAULT_NIM_QR_BASE_URL = 'https://lbs.netease.im';
export const DEFAULT_NIM_QR_EXPIRES_IN = 180;
export const DEFAULT_NIM_QR_POLL_INTERVAL = 3000;

export function buildQrPayload(uuid: string, template = ''): string {
  const effectiveTemplate = template.trim();
  if (!effectiveTemplate) {
    return uuid;
  }
  return effectiveTemplate.includes('{uuid}')
    ? effectiveTemplate.replace(/\{uuid\}/g, uuid)
    : `${effectiveTemplate}${uuid}`;
}

export function isPendingBindResult(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as { code?: unknown; msg?: unknown; data?: unknown };
  return (
    (candidate.code === 200 && candidate.data === 'not found')
    || (candidate.code === 404 && candidate.msg === 'not found')
  );
}

export function normalizeBindResult(raw: unknown): NimQrLoginCredentials {
  const candidate = raw && typeof raw === 'object' ? raw as {
    code?: unknown;
    msg?: unknown;
    data?: unknown;
  } : {};
  const payload = candidate.data && typeof candidate.data === 'object'
    ? candidate.data as { appkey?: unknown; accid?: unknown; token?: unknown }
    : null;
  if (candidate.data === 'invalid user-agent' || candidate.msg === 'invalid user-agent') {
    throw new Error(NimQrLoginErrorCode.InvalidUserAgent);
  }
  if (candidate.code !== 200) {
    throw new Error(typeof candidate.msg === 'string' ? candidate.msg : NimQrLoginErrorCode.RequestFailed);
  }
  if (payload?.appkey && payload?.accid && payload?.token) {
    return {
      appKey: String(payload.appkey).trim(),
      account: String(payload.accid).trim(),
      token: String(payload.token).trim(),
    };
  }
  throw new Error(NimQrLoginErrorCode.InvalidPayload);
}
