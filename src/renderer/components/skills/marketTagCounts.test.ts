import { expect, test } from 'vitest';

import { countMarketplaceSkillsByTag } from './marketTagCounts';

test('counts skills per tag and ignores skills without tags', () => {
  expect(countMarketplaceSkillsByTag([
    { tags: ['document', 'utility'] },
    { tags: ['utility'] },
    { tags: [] },
    {},
  ])).toEqual({ document: 1, utility: 2 });
});

test('counts a skill once even if it lists the same tag twice', () => {
  expect(countMarketplaceSkillsByTag([{ tags: ['media', 'media'] }])).toEqual({ media: 1 });
});

test('returns an empty map for an empty marketplace', () => {
  expect(countMarketplaceSkillsByTag([])).toEqual({});
});
