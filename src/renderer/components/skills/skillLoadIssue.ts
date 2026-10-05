import { SkillLoadIssue } from '../../../shared/skills/constants';

/** Short card label and full explanation for each reason OpenClaw skips a skill. */
export const SKILL_LOAD_ISSUE_I18N_KEYS: Record<SkillLoadIssue, { label: string; detail: string }> = {
  [SkillLoadIssue.InvalidFrontmatter]: {
    label: 'skillLoadIssueInvalidFrontmatter',
    detail: 'skillLoadIssueInvalidFrontmatterDetail',
  },
  [SkillLoadIssue.MissingDescription]: {
    label: 'skillLoadIssueMissingDescription',
    detail: 'skillLoadIssueMissingDescriptionDetail',
  },
};
