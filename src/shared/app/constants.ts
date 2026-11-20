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

export const WindowIpcChannel = {
  /** Renderer asks whether the main window is in full screen (macOS hides the traffic lights then). */
  IsFullscreen: 'window:isFullscreen',
  /** Main → preload: apply a per-window zoom factor via webFrame after the window has painted. */
  ApplyZoom: 'window:applyZoom',
  /** Main → renderer: the main window zoom changed after a shortcut or Ctrl/Cmd + wheel. */
  ZoomChanged: 'window:zoomChanged',
} as const;

export type WindowIpcChannel = (typeof WindowIpcChannel)[keyof typeof WindowIpcChannel];

export interface WindowZoomChangedPayload {
  zoomFactor: number;
}

/** Settings tabs the main process can open through AppIpcChannel.OpenSettings. */
export const OpenSettingsTab = {
  DesktopCompanion: 'desktopCompanion',
} as const;

export type OpenSettingsTab = (typeof OpenSettingsTab)[keyof typeof OpenSettingsTab];

export interface OpenSettingsRequest {
  tab?: OpenSettingsTab;
}
