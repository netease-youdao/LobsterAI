export const ArtifactPreviewIpc = {
  CreateSession: 'artifact:createPreviewSession',
  CreateOfficeSession: 'artifact:createOfficePreviewSession',
  DestroySession: 'artifact:destroyPreviewSession',
  ClearBrowserCookies: 'artifact:browser:clearCookies',
  ClearBrowserCache: 'artifact:browser:clearCache',
  BrowserWindowOpen: 'artifact:browser:windowOpen',
  SaveBrowserAnnotationAsset: 'artifact:browserAnnotation:asset:save',
  ReadBrowserAnnotationAsset: 'artifact:browserAnnotation:asset:read',
  DeleteBrowserAnnotationAsset: 'artifact:browserAnnotation:asset:delete',
  DeleteBrowserAnnotationBatchAssets: 'artifact:browserAnnotation:asset:deleteBatch',
  WatchFile: 'artifact:watchFile',
  UnwatchFile: 'artifact:unwatchFile',
  FileChanged: 'artifact:file:changed',
  FileRenamed: 'artifact:file:renamed',
} as const;

export type ArtifactPreviewIpc = typeof ArtifactPreviewIpc[keyof typeof ArtifactPreviewIpc];

export interface ArtifactFileRenamedEvent {
  oldFilePath: string;
  newFilePath: string;
  newFileName: string;
}

export const ArtifactBrowserWindowOpenDisposition = {
  Default: 'default',
  ForegroundTab: 'foreground-tab',
  BackgroundTab: 'background-tab',
  NewWindow: 'new-window',
  Other: 'other',
} as const;

export type ArtifactBrowserWindowOpenDisposition =
  typeof ArtifactBrowserWindowOpenDisposition[keyof typeof ArtifactBrowserWindowOpenDisposition];

export interface ArtifactBrowserWindowOpenEvent {
  webContentsId: number;
  url: string;
  disposition: ArtifactBrowserWindowOpenDisposition;
  referrer?: string;
}

export const ArtifactPreviewProtocol = {
  LocalFile: 'localfile',
} as const;

export type ArtifactPreviewProtocol = typeof ArtifactPreviewProtocol[keyof typeof ArtifactPreviewProtocol];

export const ArtifactPreviewHost = {
  LocalFile: 'local',
} as const;

export const ArtifactBrowserPartition = {
  Default: 'persist:lobster-artifact-browser',
} as const;

export type ArtifactBrowserPartition = typeof ArtifactBrowserPartition[keyof typeof ArtifactBrowserPartition];
