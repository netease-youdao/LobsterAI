import { describe, expect, test } from 'vitest';

import { appendClientBannerContentTypes, appendClientBannerVersion } from './clientBannerRequest';

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
