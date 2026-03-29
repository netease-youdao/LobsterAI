/**
 * Centralized constants for the prompt-template module.
 */

// ─── IPC Channels ───────────────────────────────────────────────────────────
export const IpcChannel = {
  List: 'promptTemplate:list',
  Get: 'promptTemplate:get',
  Create: 'promptTemplate:create',
  Update: 'promptTemplate:update',
  Delete: 'promptTemplate:delete',
  IncrementUsedCount: 'promptTemplate:incrementUsedCount',
} as const;
export type IpcChannel = typeof IpcChannel[keyof typeof IpcChannel];

export interface RawPromptTemplate {
  id: string;
  title: string;
  content: string;
  description: string | null;
  category: string | null;
  variables: string;
  is_starred: number;
  used_count: number;
  created_at: string;
  updated_at: string;
}

export interface RawCreateInput {
  title: string;
  content: string;
  description?: string;
  category?: string;
  variables: string;
}

export interface RawUpdateInput {
  title?: string;
  content?: string;
  description?: string;
  category?: string;
  variables?: string;
  is_starred?: number;
}
