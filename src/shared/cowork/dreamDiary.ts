/**
 * Shared read-only historical Dream Diary types and filename constants.
 *
 * Dreaming generation is retired in LobsterAI v2 (DSH cutover), while
 * migrated OpenClaw `DREAMS.md` files are preserved read-only for browsing.
 */

export const LEGACY_DREAM_DIARY_FILENAME = 'DREAMS.md';
export const LEGACY_DREAM_DIARY_LOWERCASE_FILENAME = 'dreams.md';

export interface LegacyAgentDreamDiary {
  agentId: string;
  agentName?: string;
  path: string;
  content: string;
  updatedAtMs?: number;
}

export interface DreamDiaryData {
  found: boolean;
  path: string;
  content?: string;
  updatedAtMs?: number;
  agentId?: string;
  agents?: LegacyAgentDreamDiary[];
}
