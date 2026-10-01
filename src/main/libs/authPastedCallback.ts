import { AuthCallbackUrlError, type AuthCallbackUrlResult } from '../../shared/auth/constants';
import { readAuthDeepLinkCode } from './authCallbackRouter';
import { type AuthLocalCallback, getActiveAuthLocalCallback } from './authLocalCallbackServer';

const AUTH_CALLBACK_PATH = '/auth/callback';
const AUTH_LOOPBACK_HOST = '127.0.0.1';

const invalid: AuthCallbackUrlResult = { success: false, error: AuthCallbackUrlError.Invalid };
const expired: AuthCallbackUrlResult = { success: false, error: AuthCallbackUrlError.Expired };

/**
 * Reads the login code from a callback address the user copied out of a
 * browser that would not hand it to LobsterAI: an extension blocking
 * http://127.0.0.1, or an organization policy blocking lobsterai://.
 */
export function resolvePastedAuthCallbackUrl(
  input: unknown,
  waitingCallback: Pick<AuthLocalCallback, 'redirectUri' | 'state'> | null,
): AuthCallbackUrlResult {
  if (typeof input !== 'string') return invalid;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return invalid;
  }

  if (url.protocol === 'lobsterai:') {
    const code = readAuthDeepLinkCode(url);
    return code ? { success: true, code } : invalid;
  }

  const code = url.searchParams.get('code')?.trim();
  if (
    url.protocol !== 'http:'
    || url.hostname !== AUTH_LOOPBACK_HOST
    || url.pathname !== AUTH_CALLBACK_PATH
    || !code
  ) {
    return invalid;
  }
  // Only the waiting server's port and state prove the address belongs to this
  // login, which also keeps a pasted link from signing in someone else's account.
  if (!waitingCallback) return expired;
  if (
    url.port !== new URL(waitingCallback.redirectUri).port
    || url.searchParams.get('state') !== waitingCallback.state
  ) {
    return expired;
  }
  return { success: true, code };
}

export async function claimPastedAuthCallbackUrl(input: unknown): Promise<AuthCallbackUrlResult> {
  const waitingCallback = getActiveAuthLocalCallback();
  const result = resolvePastedAuthCallbackUrl(input, waitingCallback);
  // `in` narrows without strictNullChecks, which the main process build lacks.
  if ('error' in result) {
    console.warn(`[Auth] ignored a pasted login callback address (${result.error})`);
    return result;
  }
  console.log('[Auth] received a login code from a pasted callback address');
  // The browser never reached this server, so stop waiting for it.
  await waitingCallback?.close();
  return result;
}
