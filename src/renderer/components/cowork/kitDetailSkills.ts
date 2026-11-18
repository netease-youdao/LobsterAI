import type { InstalledKitRecord, LocalizedText } from '../../../shared/kit/constants';
import type { MarketplaceKit } from '../../types/kit';

export interface KitDetailSkill {
  id: string;
  /** Display name when the source carries one; callers fall back to the skill registry. */
  name?: string | LocalizedText;
}

/**
 * Skills to list in a kit's detail card, from the richest source available:
 * the kit store entry, then the installed kit record, then the skill ids the
 * message itself resolved for the kit (offline, or the kit left the store).
 */
export function resolveKitDetailSkills({
  marketplaceKit,
  installedKit,
  messageSkillIds = [],
}: {
  marketplaceKit?: MarketplaceKit;
  installedKit?: InstalledKitRecord;
  messageSkillIds?: string[];
}): KitDetailSkill[] {
  const storeSkills = marketplaceKit?.skills?.list ?? [];
  if (storeSkills.length > 0) {
    return storeSkills.map(skill => ({ id: skill.id, name: skill.name }));
  }
  const installedSkills = installedKit?.skills;
  if (installedSkills && installedSkills.skillIds.length > 0) {
    return installedSkills.skillIds.map(id => ({ id, name: installedSkills.metadata?.[id]?.name }));
  }
  return messageSkillIds.map(id => ({ id }));
}
