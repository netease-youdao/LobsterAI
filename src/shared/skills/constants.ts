/**
 * Why OpenClaw will not auto-load a skill from its SKILL.md. Its loader skips
 * a skill whose frontmatter cannot be parsed or has no description, so the
 * skills manager flags these instead of showing them as working.
 */
export const SkillLoadIssue = {
  InvalidFrontmatter: 'invalid_frontmatter',
  MissingDescription: 'missing_description',
} as const;
export type SkillLoadIssue = typeof SkillLoadIssue[keyof typeof SkillLoadIssue];
