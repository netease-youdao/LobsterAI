// Skill type definition
export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;       // Whether visible in popover
  isOfficial: boolean;    // "官方" badge
  isBuiltIn: boolean;     // Bundled with app, cannot be deleted
  updatedAt: number;      // Timestamp
  prompt: string;         // SKILL.md body for management; do not inline into Cowork prompts
  skillPath: string;      // Absolute path to SKILL.md
  version?: string;       // Skill version from SKILL.md frontmatter
}

export type LocalizedText = { en: string; zh: string };

/** An imported skill whose ID matches an already installed (non built-in) skill. */
export interface SkillImportConflict {
  id: string;
  installedVersion: string;
  incomingVersion: string;
}

/** Mirrors `SkillDownloadOptions` in the main process skill manager. */
export interface SkillDownloadOptions {
  onConflict?: 'rename' | 'ask' | 'overwrite';
}

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
