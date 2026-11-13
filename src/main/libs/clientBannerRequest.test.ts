import { describe, expect, test, vi } from 'vitest';

import { AuthSessionStatus } from '../../shared/auth/constants';
import { AuthSessionRequestError } from './authSessionManager';
import {
  appendClientBannerContentTypes,
  appendClientBannerVersion,
  fetchClientBanner,
} from './clientBannerRequest';

describe('appendClientBannerVersion', () => {
  test('adds the current version without changing existing banner query params', () => {
    expect(appendClientBannerVersion(
      'https://server.example/api/client-banners/snapshot?placement=desktop_sidebar',
      '2026.8.26',
    )).toBe(
      'https://server.example/api/client-banners/snapshot?placement=desktop_sidebar&clientVersion=2026.8.26',
    );
  });
});

describe('appendClientBannerContentTypes', () => {
  test('declares HTML banner support so the server returns code banners', () => {
    expect(appendClientBannerContentTypes(
      'https://server.example/api/client-banners/snapshot?placement=desktop_sidebar&clientVersion=2026.11.9',
    )).toBe(
      'https://server.example/api/client-banners/snapshot?placement=desktop_sidebar&clientVersion=2026.11.9&contentTypes=image%2Chtml',
    );
  });
});

describe('fetchClientBanner', () => {
  const ok = new Response('{}');

  test('requests as a guest when there is no session', async () => {
    const deps = { hasAuthTokens: () => false, fetchWithAuth: vi.fn(), fetchPublic: vi.fn().mockResolvedValue(ok) };
    await expect(fetchClientBanner('https://s/api', {}, deps)).resolves.toBe(ok);
    expect(deps.fetchWithAuth).not.toHaveBeenCalled();
  });

  test('sends the session so the server can apply audience targeting', async () => {
    const deps = { hasAuthTokens: () => true, fetchWithAuth: vi.fn().mockResolvedValue(ok), fetchPublic: vi.fn() };
    await expect(fetchClientBanner('https://s/api', {}, deps)).resolves.toBe(ok);
    expect(deps.fetchPublic).not.toHaveBeenCalled();
  });

  test('falls back to a guest request when the session expired', async () => {
    const deps = {
      hasAuthTokens: () => true,
      fetchWithAuth: vi.fn().mockRejectedValue(new AuthSessionRequestError(AuthSessionStatus.Expired, 'expired')),
      fetchPublic: vi.fn().mockResolvedValue(ok),
    };
    await expect(fetchClientBanner('https://s/api', {}, deps)).resolves.toBe(ok);
  });

  test('keeps transient failures as errors', async () => {
    const error = new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable, 'offline');
    const deps = { hasAuthTokens: () => true, fetchWithAuth: vi.fn().mockRejectedValue(error), fetchPublic: vi.fn() };
    await expect(fetchClientBanner('https://s/api', {}, deps)).rejects.toBe(error);
    expect(deps.fetchPublic).not.toHaveBeenCalled();
  });
});
