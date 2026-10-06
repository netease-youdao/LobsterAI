/**
 * Top-level sections of the merged Skills & Connectors page.
 *
 * Skills and MCP servers ("connectors") share one sidebar entry; the page
 * anchors on Skills and switches sections without leaving the view. The two
 * managers underneath stay independent — this is navigation state only.
 */
export const SkillsConnectorsSection = {
  Skills: 'skills',
  Connectors: 'connectors',
} as const;
export type SkillsConnectorsSection = typeof SkillsConnectorsSection[keyof typeof SkillsConnectorsSection];

/** Skills first: it is the default anchor when the sidebar entry is opened. */
export const SKILLS_CONNECTORS_SECTION_ORDER: readonly SkillsConnectorsSection[] = [
  SkillsConnectorsSection.Skills,
  SkillsConnectorsSection.Connectors,
];

export const SKILLS_CONNECTORS_SECTION_LABEL_KEYS: Record<SkillsConnectorsSection, string> = {
  [SkillsConnectorsSection.Skills]: 'skills',
  [SkillsConnectorsSection.Connectors]: 'connectors',
};
