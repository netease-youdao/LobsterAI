import { describe, expect, test } from 'vitest';

import { appendClientBannerVersion } from './clientBannerRequest';

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
