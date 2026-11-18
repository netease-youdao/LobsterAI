import { describe, expect, test } from 'vitest';

import type { InstalledKitRecord } from '../../../shared/kit/constants';
import type { MarketplaceKit } from '../../types/kit';
import { resolveKitDetailSkills } from './kitDetailSkills';

const marketplaceKit: MarketplaceKit = {
  id: 'human-resources',
  name: { zh: '人力资源', en: 'Human Resources' },
  description: 'HR workflows',
  skills: {
    bundle: 'https://example.com/hr.zip',
    list: [{ id: 'draft-offer', name: { zh: '起草 Offer', en: 'Draft offer' } }],
  },
};

const installedKit: InstalledKitRecord = {
  id: 'human-resources',
  version: '1.0.0',
  installedAt: 1,
  skills: {
    skillIds: ['onboarding', 'org-planning'],
    metadata: { onboarding: { id: 'onboarding', name: '入职引导' } },
  },
  mcpServers: [],
  connectors: [],
};

describe('resolveKitDetailSkills', () => {
  test('prefers the kit store list', () => {
    expect(resolveKitDetailSkills({ marketplaceKit, installedKit, messageSkillIds: ['x'] })).toEqual([
      { id: 'draft-offer', name: { zh: '起草 Offer', en: 'Draft offer' } },
    ]);
  });

  test('falls back to the installed kit record, with names when it has them', () => {
    expect(resolveKitDetailSkills({ installedKit, messageSkillIds: ['x'] })).toEqual([
      { id: 'onboarding', name: '入职引导' },
      { id: 'org-planning', name: undefined },
    ]);
  });

  test('falls back to the skill ids the message resolved', () => {
    expect(resolveKitDetailSkills({ messageSkillIds: ['comp-analysis', 'policy-lookup'] })).toEqual([
      { id: 'comp-analysis' },
      { id: 'policy-lookup' },
    ]);
  });

  test('skips an empty store list', () => {
    const emptyStoreKit = { ...marketplaceKit, skills: { bundle: '', list: [] } };
    expect(resolveKitDetailSkills({ marketplaceKit: emptyStoreKit, installedKit })).toHaveLength(2);
  });

  test('returns nothing without any source', () => {
    expect(resolveKitDetailSkills({})).toEqual([]);
  });
});
