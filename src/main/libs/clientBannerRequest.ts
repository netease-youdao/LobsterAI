import { AuthSessionStatus } from '../../shared/auth/constants';
import { resolveAuthSessionStatusFromError } from './authSessionManager';

export const appendClientBannerVersion = (
  url: string,
  clientVersion: string,
): string => {
  const parsed = new URL(url);
  parsed.searchParams.set('clientVersion', clientVersion);
  return parsed.toString();
};

/** Content types this client can render; servers omit HTML banners for clients that do not declare it. */
export const CLIENT_BANNER_SUPPORTED_CONTENT_TYPES = 'image,html';

export const appendClientBannerContentTypes = (url: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set('contentTypes', CLIENT_BANNER_SUPPORTED_CONTENT_TYPES);
  return parsed.toString();
};

export interface ClientBannerFetchDeps {
  hasAuthTokens: () => boolean;
  fetchWithAuth: (url: string, init?: RequestInit) => Promise<Response>;
  fetchPublic: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Banner endpoints are public; sending the session lets the server apply audience
 * targeting. A missing or expired session falls back to a guest request.
 */
export const fetchClientBanner = async (
  url: string,
  init: RequestInit,
  deps: ClientBannerFetchDeps,
): Promise<Response> => {
  if (!deps.hasAuthTokens()) return deps.fetchPublic(url, init);
  try {
    return await deps.fetchWithAuth(url, init);
  } catch (error) {
    const status = resolveAuthSessionStatusFromError(error);
    if (status === AuthSessionStatus.Unauthenticated || status === AuthSessionStatus.Expired) {
      return deps.fetchPublic(url, init);
    }
    throw error;
  }
};
