import { describe, expect, test } from 'vitest';

import { DefaultAgentAvatarIcon } from './avatar';
import { createExpertCatalogFixture, ExpertFixtureId } from './expertCatalogFixture';
import { parseExpertCatalog, parseExpertStoreManifest } from './expertCatalogValidation';

describe('expert catalog protocol', () => {
  test('accepts bilingual remote content and ignores unexpected fields', () => {
    const fixture = createExpertCatalogFixture();
    expect(parseExpertCatalog({ ...fixture, ignored: true })).toEqual(fixture);
  });

  test.each([
    ['schema', (value: any) => { value.schemaVersion = 99; }],
    ['duplicate ID', (value: any) => { value.experts.push(value.experts[0]); }],
    ['reserved ID', (value: any) => { value.experts[0].id = 'main'; }],
    ['missing translation', (value: any) => { value.experts[0].nameEn = ''; }],
    ['missing starters', (value: any) => { value.experts[0].starterPrompts = []; }],
    ['unknown category', (value: any) => { value.experts[0].category = 'missing'; }],
    ['dangling featured ID', (value: any) => { value.scenarios[0].expertIds = ['missing']; }],
    ['duplicate featured ID', (value: any) => { value.scenarios[0].expertIds = [ExpertFixtureId.Data, ExpertFixtureId.Data]; }],
    ['arbitrary CSS', (value: any) => { value.scenarios[0].accent = 'url(https://example.com)'; }],
    ['path traversal', (value: any) => { value.experts[0].skillIds = ['../private']; }],
    ['oversized prompt', (value: any) => { value.experts[0].systemPrompt = 'x'.repeat(50001); }],
  ])('rejects %s', (_name, mutate) => {
    const fixture = createExpertCatalogFixture();
    mutate(fixture);
    expect(() => parseExpertCatalog(fixture)).toThrow();
  });

  test('invalid avatars fall back without losing usable expert content', () => {
    const fixture = createExpertCatalogFixture();
    fixture.experts[0].icon = 'file:///private/avatar.png';
    expect(parseExpertCatalog(fixture).experts[0].icon).toBe(DefaultAgentAvatarIcon);
  });

  test('manifest permits only supported HTTPS CDN assets and a SHA-256 digest', () => {
    const manifest = { schemaVersion: 1, version: 'v1', catalogUrl: 'https://ydhardwarecommon.nosdn.127.net/catalog.json', sha256: 'a'.repeat(64) };
    expect(parseExpertStoreManifest(manifest)).toEqual(manifest);
    for (const catalogUrl of ['http://ydhardwarecommon.nosdn.127.net/a.json', 'https://localhost/a.json', 'https://ydhardwarecommon.nosdn.127.net.evil.test/a.json', 'https://user:pass@ydhardwarecommon.nosdn.127.net/a.json']) {
      expect(() => parseExpertStoreManifest({ ...manifest, catalogUrl })).toThrow();
    }
    expect(() => parseExpertStoreManifest({ ...manifest, sha256: 'invalid' })).toThrow();
  });
});
