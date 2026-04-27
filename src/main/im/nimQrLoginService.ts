import {
  buildQrPayload,
  DEFAULT_NIM_QR_BASE_URL,
  DEFAULT_NIM_QR_EXPIRES_IN,
  DEFAULT_NIM_QR_POLL_INTERVAL,
  isPendingBindResult,
  NimQrLoginErrorCode,
  type NimQrLoginPollResult,
  type NimQrLoginStartResult,
  NimQrLoginStatus,
  normalizeBindResult,
} from '../../shared/im/nimQrLogin';

interface NimQrLoginRequestOptions {
  baseUrl?: string;
  timeoutMs?: number;
  payloadTemplate?: string;
  expiresIn?: number;
  pollInterval?: number;
}

interface NimQrStartResponseShape {
  code?: unknown;
  msg?: unknown;
  data?: Record<string, unknown> | null;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('QR binding base URL is required.');
  }
  return trimmed.replace(/\/+$/, '');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestJson(
  url: string,
  body: Record<string, unknown> | null,
  options: NimQrLoginRequestOptions = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'YUNXIN-AI-BOT-SDK',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(NimQrLoginErrorCode.Timeout);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function startNimQrLogin(options: NimQrLoginRequestOptions = {}): Promise<NimQrLoginStartResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_NIM_QR_BASE_URL);
  const rawResult = await requestJson(`${baseUrl}/lbs/getQrCode`, {}, options);
  const result = rawResult && typeof rawResult === 'object' ? rawResult as NimQrStartResponseShape : {};
  const uuid = String(result.data?.uuid || result.data?.qrCode || '').trim();
  if (result.code !== 200 || !uuid) {
    console.warn('[NimQrLogin] start request returned unexpected payload:', result);
    throw new Error(typeof result.msg === 'string' ? result.msg : NimQrLoginErrorCode.RequestFailed);
  }

  const expireAt = Number(result.data?.expireAt || 0);
  const expiresIn = expireAt > 0
    ? Math.max(Math.ceil((expireAt - Date.now()) / 1000), 1)
    : (options.expiresIn ?? DEFAULT_NIM_QR_EXPIRES_IN);

  return {
    uuid,
    qrValue: result.data ? JSON.stringify(result.data) : buildQrPayload(uuid, options.payloadTemplate),
    expiresIn,
    pollInterval: options.pollInterval ?? DEFAULT_NIM_QR_POLL_INTERVAL,
    credentialKind: 'split',
    rawData: result.data ?? null,
  };
}

export async function pollNimQrLogin(
  qrCode: string,
  options: NimQrLoginRequestOptions = {},
): Promise<NimQrLoginPollResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_NIM_QR_BASE_URL);
  const encodedQrCode = encodeURIComponent(String(qrCode));
  try {
    const result = await requestJson(
      `${baseUrl}/lbs/queryBindAiAccountByQrCode?qrCode=${encodedQrCode}`,
      null,
      options,
    );
    if (isPendingBindResult(result)) {
      return { status: NimQrLoginStatus.Pending };
    }
    return {
      status: NimQrLoginStatus.Success,
      credentials: normalizeBindResult(result),
    };
  } catch (error) {
    const message = toErrorMessage(error);
    console.warn('[NimQrLogin] poll request failed for qr code:', qrCode, message);
    const errorCode = Object.values(NimQrLoginErrorCode).includes(message as typeof NimQrLoginErrorCode[keyof typeof NimQrLoginErrorCode])
      ? message as typeof NimQrLoginErrorCode[keyof typeof NimQrLoginErrorCode]
      : NimQrLoginErrorCode.RequestFailed;
    return {
      status: NimQrLoginStatus.Failed,
      errorCode,
      error: message,
    };
  }
}
