import type { MarketplaceSkill } from '../../types/skill';

/**
 * Count marketplace skills per tag ID. A skill listing the same tag twice is
 * counted once. Tags without any skill are absent from the result (read as 0).
 */
export const countMarketplaceSkillsByTag = (
  skills: ReadonlyArray<Pick<MarketplaceSkill, 'tags'>>,
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const skill of skills) {
    for (const tagId of new Set(skill.tags ?? [])) {
      counts[tagId] = (counts[tagId] ?? 0) + 1;
    }
  }
  return counts;
};
