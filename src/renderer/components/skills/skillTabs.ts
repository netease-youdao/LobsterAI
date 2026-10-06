/**
 * Skill management tabs.
 *
 * Marketplace leads and the page always reopens there, matching the MCP page:
 * the active tab is deliberately not persisted across visits.
 */
export const SkillTab = {
  Mine: 'mine',
  Marketplace: 'marketplace',
  BuiltIn: 'builtIn',
} as const;
export type SkillTab = typeof SkillTab[keyof typeof SkillTab];

export const SKILL_TAB_ORDER: readonly SkillTab[] = [SkillTab.Marketplace, SkillTab.BuiltIn, SkillTab.Mine];

export const SKILL_TAB_LABEL_KEYS: Record<SkillTab, string> = {
  [SkillTab.Mine]: 'skillGroupMine',
  [SkillTab.Marketplace]: 'skillMarketplace',
  [SkillTab.BuiltIn]: 'skillGroupBuiltIn',
};
