export const AppIpcChannel = {
  GetKeyfromAttribution: 'app:getKeyfromAttribution',
  OpenSettings: 'app:openSettings',
  OpenSystemNotificationSettings: 'app:openSystemNotificationSettings',
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
