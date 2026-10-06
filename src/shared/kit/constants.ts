export const KitReferenceKind = {
  Kit: 'kit',
} as const;

export type KitReferenceKind =
  typeof KitReferenceKind[keyof typeof KitReferenceKind];

export const KitReferenceScheme = {
  Kit: 'kit',
} as const;

export const KitReferenceSource = {
  LobsterAiKits: 'lobsterai-kits',
} as const;

export type KitReferenceSource =
  typeof KitReferenceSource[keyof typeof KitReferenceSource];

export interface KitReference {
  kind: typeof KitReferenceKind.Kit;
  id: string;
  name?: string;
  uri: string;
  source?: KitReferenceSource | string;
}

export interface ResolvedKitCapabilities {
  skillIds: string[];
  mcpServers: unknown[];
  connectors: unknown[];
}

export interface LocalizedText {
  en: string;
  zh: string;
}

export interface KitSkillMetadata {
  id: string;
  name?: string | LocalizedText;
  description?: string | LocalizedText;
}

export interface InstalledKitSkills {
  skillIds: string[];
  metadata?: Record<string, KitSkillMetadata>;
}

export interface InstalledKitRecord {
  id: string;
  version: string;
  installedAt: number;
  workflowKind?: SkinWorkflowKind;
  skills: InstalledKitSkills | null;
  mcpServers: unknown[];
  connectors: unknown[];
}

export const KitStoreKey = {
  Installed: 'kits_installed',
} as const;
export type KitStoreKey = typeof KitStoreKey[keyof typeof KitStoreKey];

export const buildKitReferenceUri = (id: string): string =>
  `${KitReferenceScheme.Kit}://${encodeURIComponent(id)}@${KitReferenceSource.LobsterAiKits}`;
import type { SkinWorkflowKind } from '../skin/constants';
