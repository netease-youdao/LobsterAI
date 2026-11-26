/**
 * Native Feishu / Lark OAuth Device Flow app registration and credential validation.
 *
 * Replaces `@larksuite/openclaw-lark-tools/dist/utils/feishu-auth.js` using Node's
 * built-in `fetch` with zero external runtime dependencies.
 */

export const FEISHU_ENV_URLS = {
  prod: 'https://accounts.feishu.cn',
  boe: 'https://accounts.feishu-boe.cn',
  pre: 'https://accounts.feishu-pre.cn',
} as const;

export const LARK_ENV_URLS = {
  prod: 'https://accounts.larksuite.com',
  boe: 'https://accounts.larksuite-boe.com',
  pre: 'https://accounts.larksuite-pre.com',
} as const;

export type FeishuEnv = keyof typeof FEISHU_ENV_URLS;

export const FeishuRegistrationAction = {
  Init: 'init',
  Begin: 'begin',
  Poll: 'poll',
} as const;
export type FeishuRegistrationAction =
  typeof FeishuRegistrationAction[keyof typeof FeishuRegistrationAction];

export const FeishuPollError = {
  AuthorizationPending: 'authorization_pending',
  SlowDown: 'slow_down',
  AccessDenied: 'access_denied',
  ExpiredToken: 'expired_token',
} as const;
export type FeishuPollError = typeof FeishuPollError[keyof typeof FeishuPollError];

export const FeishuTenantBrand = {
  Feishu: 'feishu',
  Lark: 'lark',
} as const;
export type FeishuTenantBrand = typeof FeishuTenantBrand[keyof typeof FeishuTenantBrand];

export const FEISHU_REGISTRATION_PATH = '/oauth/v1/app/registration';
export const FEISHU_TENANT_ACCESS_TOKEN_URL =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface FeishuAuthOptions {
  env?: FeishuEnv;
  lane?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface InitResponse {
  nonce: string;
  supported_auth_methods: string[];
}

export interface BeginResponse {
  device_code: string;
  verification_uri: string;
  user_code: string;
  verification_uri_complete: string;
  interval: number;
  expire_in: number;
}

export interface PollResponse {
  client_id?: string;
  client_secret?: string;
  user_info?: {
    open_id?: string;
    tenant_brand?: FeishuTenantBrand;
  };
  error?: string;
  error_description?: string;
}

export interface ValidateAppCredentialsOptions {
  endpointUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(rawText: string): unknown {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Feishu auth request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class FeishuAuth {
  readonly env: FeishuEnv;
  private baseUrl: string;
  private readonly lane?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FeishuAuthOptions = {}) {
    this.env = options.env ?? 'prod';
    this.baseUrl = options.baseUrl ?? FEISHU_ENV_URLS[this.env];
    this.lane = options.lane;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setDomain(isLark: boolean): void {
    const urls = isLark ? LARK_ENV_URLS : FEISHU_ENV_URLS;
    this.baseUrl = urls[this.env];
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (this.lane) {
      headers['x-tt-env'] = this.lane;
    }
    return headers;
  }

  private async postRegistration<T>(
    params: Record<string, string>,
    options: { allowErrorPayload?: boolean } = {},
  ): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}${FEISHU_REGISTRATION_PATH}`;
    const body = new URLSearchParams(params).toString();
    const response = await fetchWithTimeout(
      this.fetchImpl,
      url,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body,
      },
      this.timeoutMs,
    );

    const rawText = await response.text();
    const parsed = tryParseJson(rawText);

    if (!response.ok) {
      // RFC 8628 device flow returns HTTP 400 with JSON `{ error, error_description }`
      // for expected states like authorization_pending, slow_down, access_denied, expired_token.
      if (options.allowErrorPayload && isPlainRecord(parsed) && typeof parsed.error === 'string') {
        return parsed as T;
      }
      const detail = isPlainRecord(parsed)
        ? String(parsed.error_description || parsed.error || parsed.message || rawText)
        : (rawText.slice(0, 200) || response.statusText || 'request failed');
      throw new Error(`Feishu registration ${params.action} failed (HTTP ${response.status}): ${detail}`);
    }

    if (!isPlainRecord(parsed)) {
      throw new Error(
        `Feishu registration ${params.action} returned non-JSON response: ${rawText.slice(0, 120)}`,
      );
    }

    return parsed as T;
  }

  async init(): Promise<InitResponse> {
    return this.postRegistration<InitResponse>({
      action: FeishuRegistrationAction.Init,
    });
  }

  async begin(): Promise<BeginResponse> {
    return this.postRegistration<BeginResponse>({
      action: FeishuRegistrationAction.Begin,
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    });
  }

  async poll(deviceCode: string): Promise<PollResponse> {
    return this.postRegistration<PollResponse>(
      {
        action: FeishuRegistrationAction.Poll,
        device_code: deviceCode,
      },
      { allowErrorPayload: true },
    );
  }
}

/**
 * Validate Feishu app credentials (App ID + App Secret) by requesting an
 * internal tenant_access_token. Returns true iff the API returns code 0 and a token.
 */
export async function validateAppCredentials(
  appId: string,
  appSecret: string,
  options: ValidateAppCredentialsOptions = {},
): Promise<boolean> {
  const cleanAppId = appId ? appId.trim() : '';
  const cleanAppSecret = appSecret ? appSecret.trim() : '';
  if (!cleanAppId || !cleanAppSecret) {
    return false;
  }

  const endpointUrl = options.endpointUrl ?? FEISHU_TENANT_ACCESS_TOKEN_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      endpointUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          app_id: cleanAppId,
          app_secret: cleanAppSecret,
        }),
      },
      timeoutMs,
    );

    if (!response.ok) {
      return false;
    }

    const parsed = tryParseJson(await response.text());
    if (
      isPlainRecord(parsed)
      && parsed.code === 0
      && typeof parsed.tenant_access_token === 'string'
      && parsed.tenant_access_token.length > 0
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
