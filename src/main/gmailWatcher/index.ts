/**
 * Gmail Watcher module entry point.
 * Registers IPC handlers and manages the GmailWatchService lifecycle.
 */
import { ipcMain } from 'electron';
import {
  GmailIpcChannel,
  GmailStorageKey,
  DEFAULT_GMAIL_WATCHER_CONFIG,
  type GmailWatcherConfig,
  type GmailOAuthTokens,
} from './constants';
import { startGmailOAuth } from './gmailOAuth';
import { GmailWatchService } from './gmailWatchService';

export { GmailWatchService } from './gmailWatchService';
export { GmailIpcChannel, GmailStorageKey, DEFAULT_GMAIL_WATCHER_CONFIG } from './constants';
export type { GmailWatcherConfig, GmailOAuthTokens } from './constants';

interface GmailWatcherDeps {
  getStore: () => {
    get: <T>(key: string) => T | null;
    set: (key: string, value: unknown) => void;
    delete: (key: string) => void;
  } | null;
  onNewEmail: (prompt: string) => void;
}

let watchService: GmailWatchService | null = null;

export function registerGmailWatcherHandlers(deps: GmailWatcherDeps): GmailWatchService {
  const { getStore, onNewEmail } = deps;

  watchService = new GmailWatchService(getStore, onNewEmail);

  ipcMain.handle(
    GmailIpcChannel.StartOAuth,
    async (_event, config: { clientId: string; clientSecret: string }) => {
      try {
        const tokens = await startGmailOAuth(config.clientId, config.clientSecret);
        const store = getStore();
        if (store) {
          store.set(GmailStorageKey.OAuthTokens, tokens);
          // Save config with the client credentials
          const existingConfig = store.get<GmailWatcherConfig>(GmailStorageKey.Config) || {
            ...DEFAULT_GMAIL_WATCHER_CONFIG,
          };
          existingConfig.clientId = config.clientId;
          existingConfig.clientSecret = config.clientSecret;
          store.set(GmailStorageKey.Config, existingConfig);
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'OAuth failed' };
      }
    },
  );

  ipcMain.handle(GmailIpcChannel.GetStatus, async () => {
    const store = getStore();
    const config =
      store?.get<GmailWatcherConfig>(GmailStorageKey.Config) || DEFAULT_GMAIL_WATCHER_CONFIG;
    const hasTokens = !!store?.get<GmailOAuthTokens>(GmailStorageKey.OAuthTokens)?.refreshToken;
    return {
      ...watchService!.getStatus(),
      enabled: config.enabled,
      connected: hasTokens,
      config,
    };
  });

  ipcMain.handle(GmailIpcChannel.Enable, async (_event, config: Partial<GmailWatcherConfig>) => {
    const store = getStore();
    if (!store) return { success: false, error: 'Store not available' };

    const existing = store.get<GmailWatcherConfig>(GmailStorageKey.Config) || {
      ...DEFAULT_GMAIL_WATCHER_CONFIG,
    };
    const merged: GmailWatcherConfig = { ...existing, ...config, enabled: true };
    store.set(GmailStorageKey.Config, merged);

    // Restart the service with new config
    watchService!.stop();
    watchService!.start();
    return { success: true };
  });

  ipcMain.handle(GmailIpcChannel.Disable, async () => {
    const store = getStore();
    if (store) {
      const config = store.get<GmailWatcherConfig>(GmailStorageKey.Config) || {
        ...DEFAULT_GMAIL_WATCHER_CONFIG,
      };
      config.enabled = false;
      store.set(GmailStorageKey.Config, config);
    }
    watchService!.stop();
    return { success: true };
  });

  ipcMain.handle(GmailIpcChannel.Disconnect, async () => {
    watchService!.stop();
    const store = getStore();
    if (store) {
      store.delete(GmailStorageKey.OAuthTokens);
      store.delete(GmailStorageKey.LastHistoryId);
      const config = store.get<GmailWatcherConfig>(GmailStorageKey.Config) || {
        ...DEFAULT_GMAIL_WATCHER_CONFIG,
      };
      config.enabled = false;
      store.set(GmailStorageKey.Config, config);
    }
    return { success: true };
  });

  return watchService;
}
