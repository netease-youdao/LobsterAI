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

export const CoreSkillId = {
  Docx: 'docx',
  WebSearch: 'web-search',
  Xlsx: 'xlsx',
  Pptx: 'pptx',
  Pdf: 'pdf',
  ImageProcessing: 'lobsterai-image-processing',
  FrontendDesign: 'frontend-design',
  Email: 'imap-smtp-email',
  SkillCreator: 'skill-creator',
} as const;
export type CoreSkillId = typeof CoreSkillId[keyof typeof CoreSkillId];

export const EMAIL_SKILL_CONFIG_DIR_NAME = 'email-skill';
export const SKIN_PACK_RESOURCE_DIR_NAME = 'skin-pack';
