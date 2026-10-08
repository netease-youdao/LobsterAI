import { getBrowserDraftStorage, readDraftSnapshot, writeDraftSnapshot } from '../draftPersistence';

const DRAFT_KEY_PREFIX = 'cowork:interaction-draft:';

/** Best-effort per-request draft storage so answers survive session switches and remounts. */
export function readInteractionDraft<T>(key: string): T | null {
  try {
    const stored = readDraftSnapshot(getBrowserDraftStorage(), `${DRAFT_KEY_PREFIX}${key}`);
    const value = stored ? JSON.parse(stored) : null;
    return value && typeof value === 'object' ? value as T : null;
  } catch {
    return null;
  }
}

export function saveInteractionDraft(key: string, value: unknown): void {
  writeDraftSnapshot(getBrowserDraftStorage(), `${DRAFT_KEY_PREFIX}${key}`, value);
}
