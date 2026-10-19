export const AppIpcChannel = {
  GetKeyfromAttribution: 'app:getKeyfromAttribution',
  OpenSettings: 'app:openSettings',
  OpenSystemNotificationSettings: 'app:openSystemNotificationSettings',
  /** Renderer takes the files/folders the OS asked LobsterAI to open. */
  ConsumeOpenWithPaths: 'app:consumeOpenWithPaths',
  /** Main → renderer: new Open With paths are queued. */
  OpenWithPathsAvailable: 'app:openWithPathsAvailable',
} as const;

export type AppIpcChannel = (typeof AppIpcChannel)[keyof typeof AppIpcChannel];

/** Settings tabs the main process can open through AppIpcChannel.OpenSettings. */
export const OpenSettingsTab = {
  DesktopCompanion: 'desktopCompanion',
} as const;

export type OpenSettingsTab = (typeof OpenSettingsTab)[keyof typeof OpenSettingsTab];

export interface OpenSettingsRequest {
  tab?: OpenSettingsTab;
}
