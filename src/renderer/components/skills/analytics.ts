import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import type { MarketplaceSkill, Skill } from '../../types/skill';

type AnalyticsValue = string | number | boolean | null | undefined;
type AnalyticsParams = Record<string, AnalyticsValue>;

export function serializeSkillAnalyticsList(values: Array<string | number | null | undefined>): string {
  return values
    .filter((value): value is string | number => value !== null && value !== undefined && value !== '')
    .map(String)
    .join(',');
}

export function getSkillSource(skill: Skill): string {
  if (skill.isBuiltIn) return 'built_in';
  if (skill.isOfficial) return 'official';
  return 'custom';
}

export function getInstalledSkillAnalyticsParams(
  skill: Skill,
  marketplaceSkill?: MarketplaceSkill,
): AnalyticsParams {
  const hasUpdate = Boolean(
    marketplaceSkill?.version
    && skill.version
    && marketplaceSkill.version !== skill.version,
  );
  return {
    skillId: skill.id,
    skillName: skill.name,
    skillSource: getSkillSource(skill),
    isBuiltIn: skill.isBuiltIn,
    isOfficial: skill.isOfficial,
    version: skill.version,
    marketplaceVersion: marketplaceSkill?.version,
    hasUpdate,
    tags: serializeSkillAnalyticsList(marketplaceSkill?.tags ?? []),
  };
}

export function getMarketplaceSkillAnalyticsParams(
  skill: MarketplaceSkill,
  installedSkill?: Skill,
): AnalyticsParams {
  const hasUpdate = Boolean(
    installedSkill?.version
    && skill.version
    && installedSkill.version !== skill.version,
  );
  return {
    skillId: skill.id,
    skillName: skill.name,
    skillSource: 'marketplace',
    version: installedSkill?.version,
    marketplaceVersion: skill.version,
    hasUpdate,
    tags: serializeSkillAnalyticsList(skill.tags ?? []),
    sourceType: 'marketplace',
  };
}

export function reportSkillAction(
  actionType: string,
  params: AnalyticsParams = {},
): void {
  console.debug('[Skills] reporting analytics action', actionType);
  void reportYdAnalyzer({
    action: LogReporterAction.SkillAction,
    actionType,
    ...params,
  });
}
