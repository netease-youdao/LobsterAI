import type { SkillLoadIssue } from '../../shared/skills/constants';

// Skill type definition
export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;       // Whether visible in popover
  isOfficial: boolean;    // "官方" badge
  isBuiltIn: boolean;     // Bundled with app, cannot be deleted
  canDisable?: boolean;   // Core built-in skills cannot be disabled (false = always enabled)
  modelInvocable?: boolean; // Whether the model may auto-invoke this skill by default
  userInvocable?: boolean;  // Whether shown in user skill pickers / slash menus
  updatedAt: number;      // Timestamp
  prompt: string;         // SKILL.md body for management; do not inline into Cowork prompts
  skillPath: string;      // Absolute path to SKILL.md
  version?: string;       // Skill version from SKILL.md frontmatter
  loadIssue?: SkillLoadIssue; // Why OpenClaw will not auto-load this skill
}

export type LocalizedText = { en: string; zh: string };

export interface MarketTag {
  id: string;
  en: string;
  zh: string;
}

export interface LocalSkillInfo {
  id: string;
  name: string;
  description: string | LocalizedText;
  version: string;
  displayName?: string | LocalizedText; // Optional: server-provided localized name
  icon?: string;                        // Optional: server-provided icon URL
}

export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string | LocalizedText;
  tags?: string[];
  url: string;              // Download URL (.zip)
  version: string;
  source: {
    from: string;           // e.g. "Github"
    url: string;            // Source repo URL
    author?: string;        // Author name
  };
  // Optional fields the skill store may start sending. Until then the UI
  // falls back to a prettified name and a generated icon tile.
  displayName?: string | LocalizedText;
  icon?: string;
  downloadCount?: number;
}
