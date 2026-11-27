import { describe, expect, test } from 'vitest';

import {
  isTrustedOfficialMarketplaceUrl,
  MarketplaceTrustRegistry,
  normalizeSha256,
  parseMarketplaceCatalogEntries,
} from './marketplaceTrust';

const VALID_SHA256 = 'a'.repeat(64);

describe('marketplaceTrust', () => {
  test('isTrustedOfficialMarketplaceUrl only accepts HTTPS official CDN zip archives', () => {
    expect(isTrustedOfficialMarketplaceUrl('https://ydlunacommon-cdn.nosdn.127.net/skills/article-writer.zip')).toBe(true);
    expect(isTrustedOfficialMarketplaceUrl('https://static.youdao.com/lobsterai/weather-1.0.0.zip?v=1')).toBe(true);
    expect(isTrustedOfficialMarketplaceUrl('https://cdn.126.net/skills/remotion.zip')).toBe(true);
    expect(isTrustedOfficialMarketplaceUrl('https://cdn.127.net/skills/local-tools.zip')).toBe(true);

    // Reject HTTP, non-zip, lookalike domains, and third-party hosts
    expect(isTrustedOfficialMarketplaceUrl('http://ydlunacommon-cdn.nosdn.127.net/skills/article-writer.zip')).toBe(false);
    expect(isTrustedOfficialMarketplaceUrl('https://ydlunacommon-cdn.nosdn.127.net/skills/article-writer.tar.gz')).toBe(false);
    expect(isTrustedOfficialMarketplaceUrl('https://evil-nosdn.127.net.attacker.com/skills/x.zip')).toBe(false);
    expect(isTrustedOfficialMarketplaceUrl('https://github.com/org/repo/archive/refs/heads/main.zip')).toBe(false);
    expect(isTrustedOfficialMarketplaceUrl('not-a-url')).toBe(false);
  });

  test('normalizeSha256 validates 64-character hex digests', () => {
    expect(normalizeSha256(`  ${VALID_SHA256.toUpperCase()}  `)).toBe(VALID_SHA256);
    expect(normalizeSha256('abc123')).toBeUndefined();
    expect(normalizeSha256('g'.repeat(64))).toBeUndefined();
    expect(normalizeSha256(null)).toBeUndefined();
  });

  test('parseMarketplaceCatalogEntries parses nested Overmind payload and top-level payloads', () => {
    const nested = parseMarketplaceCatalogEntries(JSON.stringify({
      data: {
        value: {
          marketplace: [
            { id: 'article-writer', url: 'https://cdn.nosdn.127.net/a.zip', version: '1.0.0' },
            { id: 'github-skill', url: 'https://github.com/o/r/archive/main.zip', sha256: VALID_SHA256 },
          ],
        },
      },
    }));
    expect(nested).toHaveLength(2);
    expect(nested[0]).toMatchObject({ id: 'article-writer', url: 'https://cdn.nosdn.127.net/a.zip' });
    expect(nested[1]).toMatchObject({ id: 'github-skill', sha256: VALID_SHA256 });

    expect(parseMarketplaceCatalogEntries('{invalid')).toEqual([]);
  });

  test('MarketplaceTrustRegistry bypasses scan ONLY for catalog-verified official CDN or sha256-locked packages', () => {
    const registry = new MarketplaceTrustRegistry();
    registry.updateFromRawResponse(JSON.stringify({
      data: {
        value: {
          marketplace: [
            {
              id: 'article-writer',
              url: 'https://ydlunacommon-cdn.nosdn.127.net/skills/article-writer-1.0.0.zip',
              version: '1.0.0',
            },
            {
              id: 'third-party-locked',
              url: 'https://github.com/org/repo/releases/download/v1.0.0/skill.zip',
              version: '1.0.0',
              sha256: VALID_SHA256,
            },
            {
              id: 'third-party-mutable',
              url: 'https://github.com/org/repo/archive/refs/heads/main.zip',
              version: '1.0.0',
            },
          ],
        },
      },
    }));

    // 1. Official CDN package present in catalog -> bypasses client scan
    expect(registry.resolveTrustedDownload(
      'https://ydlunacommon-cdn.nosdn.127.net/skills/article-writer-1.0.0.zip',
    )).toMatchObject({
      trusted: true,
      entry: { id: 'article-writer' },
    });

    // 2. Third-party package with sha256 lock -> bypasses client scan with checksum verification
    expect(registry.resolveTrustedDownload(
      'https://github.com/org/repo/releases/download/v1.0.0/skill.zip',
    )).toMatchObject({
      trusted: true,
      expectedSha256: VALID_SHA256,
      entry: { id: 'third-party-locked' },
    });

    // 3. Third-party mutable URL without sha256 -> MUST still run client security scan
    expect(registry.resolveTrustedDownload(
      'https://github.com/org/repo/archive/refs/heads/main.zip',
    )).toMatchObject({
      trusted: false,
      entry: { id: 'third-party-mutable' },
    });

    // 4. URL NOT in Overmind catalog (even on official CDN host) -> MUST NOT skip scan
    expect(registry.resolveTrustedDownload(
      'https://ydlunacommon-cdn.nosdn.127.net/skills/unlisted.zip',
    )).toEqual({
      trusted: false,
    });

    // 5. Skill ID mismatch -> rejected for bypass
    expect(registry.resolveTrustedDownload(
      'https://ydlunacommon-cdn.nosdn.127.net/skills/article-writer-1.0.0.zip',
      'different-id',
    )).toEqual({
      trusted: false,
    });
  });
});
