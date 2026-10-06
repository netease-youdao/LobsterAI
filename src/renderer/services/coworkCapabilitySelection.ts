import type {
  KitReference,
  ResolvedKitCapabilities,
} from '../../shared/kit/constants';
import type { InstalledKit, MarketplaceKit } from '../types/kit';
import type { Skill } from '../types/skill';
import {
  buildKitReferences,
  resolveSelectedKitCapabilities,
} from './kitCapability';

export interface CoworkCapabilitySelection {
  directSkillIds: string[];
  runtimeSkillIds: string[];
  kitReferences: KitReference[];
  resolvedKitCapabilities: ResolvedKitCapabilities;
}

export const buildCoworkCapabilitySelection = (
  skillIds: string[],
  kitIds: string[],
  skills: Skill[],
  installedKits: Record<string, InstalledKit>,
  marketplaceKits: MarketplaceKit[],
): CoworkCapabilitySelection => {
  const resolveRoutableSkillIds = (candidateIds: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const skillId of candidateIds) {
      if (seen.has(skillId)) continue;
      seen.add(skillId);
      const skill = skills.find(item => item.id === skillId);
      if (!skill?.enabled || !skill.skillPath.trim()) continue;
      result.push(skillId);
    }
    return result;
  };

  const directSkillIds = resolveRoutableSkillIds(skillIds);
  const resolvedKitCapabilities = resolveSelectedKitCapabilities(kitIds, installedKits);
  const runtimeSkillIds = resolveRoutableSkillIds([
    ...directSkillIds,
    ...resolvedKitCapabilities.skillIds,
  ]);

  return {
    directSkillIds,
    runtimeSkillIds,
    kitReferences: buildKitReferences(kitIds, marketplaceKits),
    resolvedKitCapabilities,
  };
};
