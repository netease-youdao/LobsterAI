export const AppIpcChannel = {
  GetKeyfromAttribution: 'app:getKeyfromAttribution',
  OpenSystemNotificationSettings: 'app:openSystemNotificationSettings',
  /** Renderer takes the files/folders the OS asked LobsterAI to open. */
  ConsumeOpenWithPaths: 'app:consumeOpenWithPaths',
  /** Main → renderer: new Open With paths are queued. */
  OpenWithPathsAvailable: 'app:openWithPathsAvailable',
} as const;

export type AppIpcChannel = (typeof AppIpcChannel)[keyof typeof AppIpcChannel];
