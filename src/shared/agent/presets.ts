export const ExpertUiEvent = {
  OpenPlaza: 'experts:open-plaza',
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
  category: string;
  tags: LocalizedExpertText[];
  starterPrompts: LocalizedExpertText[];
  installed?: boolean;
}

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
