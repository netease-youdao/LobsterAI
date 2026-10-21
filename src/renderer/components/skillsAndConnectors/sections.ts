/**
 * Kits, skills and connectors share a directory; their managers stay independent.
 */
export const SkillsConnectorsSection = {
  Kits: 'kits',
  Skills: 'skills',
  Connectors: 'connectors',
} as const;
export type SkillsConnectorsSection = typeof SkillsConnectorsSection[keyof typeof SkillsConnectorsSection];

/** Kits is the default section when opening the directory from the sidebar. */
export const SKILLS_CONNECTORS_SECTION_ORDER: readonly SkillsConnectorsSection[] = [
  SkillsConnectorsSection.Kits,
  SkillsConnectorsSection.Skills,
  SkillsConnectorsSection.Connectors,
];

export const SKILLS_CONNECTORS_SECTION_LABEL_KEYS: Record<SkillsConnectorsSection, string> = {
  [SkillsConnectorsSection.Kits]: 'kits',
  [SkillsConnectorsSection.Skills]: 'skills',
  [SkillsConnectorsSection.Connectors]: 'connectors',
};
