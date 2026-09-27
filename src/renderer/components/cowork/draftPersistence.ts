export interface DraftSnapshotStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const getBrowserDraftStorage = (): DraftSnapshotStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const readDraftSnapshot = (
  storage: DraftSnapshotStorage | null,
  key: string,
): string | null => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

export const writeDraftSnapshot = (
  storage: DraftSnapshotStorage | null,
  key: string,
  value: unknown,
): boolean => {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};
