import { expect, test, vi } from 'vitest';

vi.mock('./skill', () => ({ resolveLocalizedText: (value: string | { en: string }) => typeof value === 'string' ? value : value.en }));
import type { MarketplaceSkill } from '../types/skill';
import { CapabilityKind, CatalogSort, parseKitCatalog, sortMarketplaceSkills } from './capabilityCatalog';

test('legacy kits remain expert kits; plugin availability is checked', () => {
  const rows = [{ id: 'office', name: 'Office', description: '', skills: { bundle: 'https://example.com/office.zip', list: [] } },
    { id: 'connector', name: 'Connector', description: '', libraryKind: CapabilityKind.Plugin, category: 'Tools' }];
  const kits = parseKitCatalog({ data: { value: { kits: rows } } });
  expect(kits[0].libraryKind).toBe(CapabilityKind.Expert);
  expect(kits[0].unavailable).toBe(false);
  expect(kits[1].libraryKind).toBe(CapabilityKind.Plugin);
  expect(kits[1].unavailable).toBe(true);
  expect(parseKitCatalog({ kits: rows })).toEqual(kits);
});

test('malformed and duplicate entries fail instead of becoming successful empty catalogs', () => {
  expect(() => parseKitCatalog({})).toThrow();
  expect(() => parseKitCatalog({ kits: [{ id: 'x', name: 42, description: '' }] })).toThrow();
  const row = { id: 'x', name: 'X', description: '' };
  expect(() => parseKitCatalog({ kits: [row, row] })).toThrow();
  expect(parseKitCatalog({ kits: [] })).toEqual([]);
});

test('sorts copies and retains recommended order; absent metrics do not invent popularity', () => {
  const input = [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha', downloadCount: 3 }] as MarketplaceSkill[];
  expect(sortMarketplaceSkills(input, CatalogSort.Name).map(item => item.id)).toEqual(['a', 'b']);
  expect(sortMarketplaceSkills(input, CatalogSort.Downloads).map(item => item.id)).toEqual(['a', 'b']);
  expect(sortMarketplaceSkills(input, CatalogSort.Recommended).map(item => item.id)).toEqual(['b', 'a']);
  expect(input[0].id).toBe('b');
});
