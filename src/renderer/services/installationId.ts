import { store } from '../store';
import { localStore } from './store';

const INSTALLATION_UUID_KEY = 'installation_uuid';

let cachedId: string | null = null;

/**
 * Get or create a persistent installation UUID.
 * - Returns from memory cache if available (zero I/O).
 * - Otherwise reads from SQLite KV store; generates and persists a new one if absent.
 * - Never throws — returns null on any failure so the caller can degrade gracefully.
 */
export const getInstallationId = async (): Promise<string | null> => {
  try {
    if (cachedId) {
      return cachedId;
    }

    const existing = await localStore.getItem<string>(INSTALLATION_UUID_KEY);
    if (existing) {
      cachedId = existing;
      console.log(`[InstallationId] loaded from store: ${cachedId}`);
      return cachedId;
    }

    const newId = crypto.randomUUID();

    try {
      await localStore.setItem(INSTALLATION_UUID_KEY, newId);
      console.log(`[InstallationId] generated and persisted new id: ${newId}`);
    } catch (writeError) {
      // Persist failed (SQLite corruption, overlay install, etc.)
      // Still cache in memory so the current session has a usable id.
      console.warn('[InstallationId] generated new id but failed to persist:', writeError);
    }

    cachedId = newId;
    return cachedId;
  } catch (error) {
    console.warn('[InstallationId] failed to get installation uuid:', error);
    return null;
  }
};

/**
 * Build the query string for update-check requests.
 * - Appends `uuid=<installationId>` when available.
 * - Appends `userId=<userId>` when the user is logged in.
 * - Returns an empty string on total failure so the caller can fall back to the bare URL.
 */
export const getUpdateQueryString = async (): Promise<string> => {
  try {
    const params = new URLSearchParams();

    const installationId = await getInstallationId();
    if (installationId) {
      params.append('uuid', installationId);
    }

    const authUser = store.getState().auth.user;
    const userId = authUser?.yid;
    if (userId && typeof userId === 'string') {
      params.append('userId', userId);
    }

    return params.toString();
  } catch (error) {
    console.warn('[InstallationId] failed to build update query string:', error);
    return '';
  }
};
