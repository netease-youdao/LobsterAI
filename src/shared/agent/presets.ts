import type { DshProgressiveCapability } from '../dshEngine/hostConstants';

export const ExpertUiEvent = {
  OpenPlaza: 'experts:open-plaza',
  Preparing: 'experts:preparing',
} as const;

export const ExpertCatalogSchemaVersion = 1;

export const ExpertScenarioAccent = {
  Teal: 'teal', Orange: 'orange', Indigo: 'indigo', Stone: 'stone', Amber: 'amber',
  Sky: 'sky', Blue: 'blue', Violet: 'violet', Emerald: 'emerald', Rose: 'rose', Cyan: 'cyan',
} as const;
export type ExpertScenarioAccent = typeof ExpertScenarioAccent[keyof typeof ExpertScenarioAccent];

export interface LocalizedExpertText {
  zh: string;
  en: string;
}

export interface PresetAgent {
  id: string;
  name: string;
  nameEn: string;
  icon: string;
  description: string;
  descriptionEn: string;
  identity: string;
  identityEn: string;
  systemPrompt: string;
  systemPromptEn: string;
  skillIds: string[];
  hostCapabilities?: DshProgressiveCapability[];
  category: string;
  tags: LocalizedExpertText[];
  starterPrompts: LocalizedExpertText[];
  isNew?: boolean;
  revision?: number;
  installed?: boolean;
}

export function hasExpertUpdate(installed: number | undefined, published: number | undefined): boolean {
  return typeof published === 'number' && (installed === undefined || published > installed);
}

export function expertReminderRevision(installed?: number, published?: number, dismissed?: number): number | undefined {
  return published !== undefined && hasExpertUpdate(installed, published) && published > (dismissed ?? 0)
    ? published : undefined;
}

export const ExpertUpgradeStatus = {
  Updated: 'updated', Busy: 'busy', Unavailable: 'unavailable',
} as const;
export type ExpertUpgradeStatus = typeof ExpertUpgradeStatus[keyof typeof ExpertUpgradeStatus];

export interface ExpertCategoryDefinition {
  id: string;
  label: LocalizedExpertText;
}

export interface ExpertScenario {
  id: string;
  title: LocalizedExpertText;
  description: LocalizedExpertText;
  accent: ExpertScenarioAccent;
  expertIds: string[];
}

export interface ExpertCatalog {
  schemaVersion: typeof ExpertCatalogSchemaVersion;
  version: string;
  categories: ExpertCategoryDefinition[];
  scenarios: ExpertScenario[];
  experts: PresetAgent[];
}

export interface ExpertStoreManifest {
  schemaVersion: typeof ExpertCatalogSchemaVersion;
  version: string;
  catalogUrl: string;
  sha256: string;
}
