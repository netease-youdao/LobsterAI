import { createExpertCatalogFixture, ExpertFixtureCategory, ExpertFixtureId } from '@shared/agent/expertCatalogFixture';
import { expect, test } from 'vitest';

import { expertText, filterExperts } from '../renderer/components/experts/catalog';

test('searches remotely configured names, descriptions and tags with arbitrary category IDs', () => {
  const { experts } = createExpertCatalogFixture();
  expect(filterExperts(experts, '  MINI app ', null, null).map(expert => expert.id)).toEqual([ExpertFixtureId.App]);
  expect(filterExperts(experts, '表格', ExpertFixtureCategory.Research, null).map(expert => expert.id)).toEqual([ExpertFixtureId.Data]);
  expect(filterExperts(experts, '表格', ExpertFixtureCategory.Development, null)).toHaveLength(0);
  expect(filterExperts(experts, '', null, '原型开发').map(expert => expert.id)).toEqual([ExpertFixtureId.App]);
  expect(filterExperts(experts, 'no-matching-expert', null, null)).toEqual([]);
  expect(expertText({ zh: '远程分类', en: 'Remote category' }, 'en')).toBe('Remote category');
});
