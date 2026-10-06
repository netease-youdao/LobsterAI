import type { InstalledKitRecord, LocalizedText } from '../../shared/kit/constants';
import type { SkinWorkflowKind } from '../../shared/skin/constants';

export interface KitSkillRef {
  id: string;
  name: string | LocalizedText;
  description?: string | LocalizedText;
}

export interface KitSkillBundle {
  bundle: string;
  list: KitSkillRef[];
}

export interface MarketplaceKit {
  id: string;
  name: string | LocalizedText;
  description: string | LocalizedText;
  icon?: string;
  author?: string;
  version?: string;
  workflowKind?: SkinWorkflowKind;
  downloadCount?: string;
  tryAsking?: (string | LocalizedText)[];
  skills?: KitSkillBundle;
  mcpServers?: unknown[] | null;
  connectors?: unknown[] | null;
}

export type InstalledKit = InstalledKitRecord;
