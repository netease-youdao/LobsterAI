import { randomUUID, randomBytes, createHash } from "node:crypto";
import { shell } from 'electron';
import { t } from '../i18n';

// PKCE (Proof Key for Code Exchange) helpers - exactly matching OpenClaw implementation
function generatePkceVerifierChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
// Qwen官方为第三方客户端提供的公共Client ID，与OpenClaw保持一致
const QWEN_OAUTH_CLIENT_ID = process.env.QWEN_OAUTH_CLIENT_ID || "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_OAUTH_SCOPE = "openid profile email model.completion";
const QWEN_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface QwenDeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface QwenOAuthToken {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
}

type TokenPending = { status: "pending"; slowDown?: boolean };
type DeviceTokenResult =
  | { status: "success"; token: QwenOAuthToken }
  | TokenPending
  | { status: "error"; message: string };

interface ProgressCallback {
  update: (message: string) => void;
  stop: (message?: string) => void;
}


function toFormUrlEncoded(obj: Record<string, string>): string {
  return Object.keys(obj)
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(obj[key]))
    .join('&');
}

async function requestDeviceCode(params: { challenge: string }): Promise<QwenDeviceAuthorization> {
  const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "x-request-id": randomUUID(),
    },
    body: toFormUrlEncoded({
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: QWEN_OAUTH_SCOPE,
      code_challenge: params.challenge,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Qwen device authorization failed: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as QwenDeviceAuthorization & { error?: string };
  if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
    throw new Error(
      payload.error ??
        "Qwen device authorization returned an incomplete payload (missing user_code or verification_uri)."
    );
  }
  return payload;
}

async function pollDeviceToken(params: {
  deviceCode: string;
  verifier: string;
}): Promise<DeviceTokenResult> {
  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: toFormUrlEncoded({
      grant_type: QWEN_OAUTH_GRANT_TYPE,
      client_id: QWEN_OAUTH_CLIENT_ID,
      device_code: params.deviceCode,
      code_verifier: params.verifier,
    }),
  });

  if (!response.ok) {
    let payload: { error?: string; error_description?: string } | undefined;
    try {
      payload = (await response.json()) as { error?: string; error_description?: string };
    } catch {
      const text = await response.text();
      return { status: "error", message: text || response.statusText };
    }

    if (payload?.error === "authorization_pending") {
      return { status: "pending" };
    }

    if (payload?.error === "slow_down") {
      return { status: "pending", slowDown: true };
    }

    return {
      status: "error",
      message: payload?.error_description || payload?.error || response.statusText,
    };
  }

  const tokenPayload = (await response.json()) as {
    access_token?: string | null;
    refresh_token?: string | null;
    expires_in?: number | null;
    token_type?: string;
    resource_url?: string;
  };

  if (!tokenPayload.access_token || !tokenPayload.refresh_token || !tokenPayload.expires_in) {
    return { status: "error", message: "Qwen OAuth returned incomplete token payload." };
  }

  return {
    status: "success",
    token: {
      access: tokenPayload.access_token,
      refresh: tokenPayload.refresh_token,
      expires: Date.now() + tokenPayload.expires_in * 1000,
      resourceUrl: tokenPayload.resource_url,
    },
  };
}

export async function startQwenOAuth(
  progressCallback: ProgressCallback
): Promise<QwenOAuthToken> {
  const { verifier, challenge } = generatePkceVerifierChallenge();
  
  progressCallback.update(t('qwenOAuthRequestingDeviceCode'));
  const device = await requestDeviceCode({ challenge });
  
  const verificationUrl = device.verification_uri_complete || device.verification_uri;
  
  progressCallback.update(t('qwenOAuthOpeningBrowser'));
  
  try {
    await shell.openExternal(verificationUrl);
  } catch (error) {
    console.warn('Failed to open browser:', error);
  }

  const start = Date.now();
  let pollIntervalMs = device.interval ? device.interval * 1000 : 2000;
  const timeoutMs = device.expires_in * 1000;

  while (Date.now() - start < timeoutMs) {
    progressCallback.update(t('qwenOAuthWaitingForUser'));
    const result = await pollDeviceToken({
      deviceCode: device.device_code,
      verifier,
    });

    if (result.status === "success") {
      progressCallback.stop(t('qwenOAuthSuccess'));
      return result.token;
    }

    if (result.status === "error") {
      progressCallback.stop(t('qwenOAuthFailed'));
      throw new Error(`Qwen OAuth failed: ${result.message}`);
    }

    if (result.status === "pending" && result.slowDown) {
      pollIntervalMs = Math.min(pollIntervalMs * 1.5, 10000);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  progressCallback.stop(t('qwenOAuthTimeout'));
  throw new Error("Qwen OAuth timed out waiting for authorization.");
}

export async function refreshQwenOAuthToken(refreshToken: string): Promise<QwenOAuthToken> {
  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: toFormUrlEncoded({
      grant_type: "refresh_token",
      client_id: QWEN_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 400) {
      throw new Error('Qwen OAuth refresh token expired or invalid. Please re-authenticate.');
    }
    throw new Error(`Failed to refresh Qwen OAuth token: ${text || response.statusText}`);
  }

  const tokenPayload = (await response.json()) as {
    access_token?: string | null;
    refresh_token?: string | null;
    expires_in?: number | null;
    token_type?: string;
    resource_url?: string;
  };

  if (!tokenPayload.access_token || !tokenPayload.expires_in) {
    throw new Error("Qwen OAuth refresh returned incomplete token payload.");
  }

  return {
    access: tokenPayload.access_token,
    // RFC 6749 section 6: new refresh token is optional; if present, replace old.
    refresh: tokenPayload.refresh_token || refreshToken,
    expires: Date.now() + tokenPayload.expires_in * 1000,
    resourceUrl: tokenPayload.resource_url,
  };
}

/**
 * Check if OAuth credentials need refreshing and refresh them if needed
 */
export async function ensureFreshQwenOAuthToken(
  oauthCredentials: QwenOAuthToken
): Promise<QwenOAuthToken> {
  // Check if token expires within the next 5 minutes
  const expiryBuffer = 5 * 60 * 1000; // 5 minutes in milliseconds
  const needsRefresh = Date.now() >= (oauthCredentials.expires - expiryBuffer);
  
  if (!needsRefresh) {
    return oauthCredentials;
  }
  
  console.log('[Qwen OAuth] Token expires soon, refreshing...');
  try {
    const refreshedToken = await refreshQwenOAuthToken(oauthCredentials.refresh);
    console.log('[Qwen OAuth] Token refreshed successfully');
    return refreshedToken;
  } catch (error) {
    console.error('[Qwen OAuth] Failed to refresh token:', error);
    throw error;
  }
}
