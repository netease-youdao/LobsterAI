export const ArtifactPreviewIpc = {
  CreateSession: 'artifact:createPreviewSession',
  CreateOfficeSession: 'artifact:createOfficePreviewSession',
  DestroySession: 'artifact:destroyPreviewSession',
  ClearBrowserCookies: 'artifact:browser:clearCookies',
  ClearBrowserCache: 'artifact:browser:clearCache',
  SaveBrowserAnnotationAsset: 'artifact:browserAnnotation:asset:save',
  ReadBrowserAnnotationAsset: 'artifact:browserAnnotation:asset:read',
  DeleteBrowserAnnotationAsset: 'artifact:browserAnnotation:asset:delete',
  DeleteBrowserAnnotationBatchAssets: 'artifact:browserAnnotation:asset:deleteBatch',
} as const;

export type ArtifactPreviewIpc = typeof ArtifactPreviewIpc[keyof typeof ArtifactPreviewIpc];

export const ArtifactPreviewProtocol = {
  LocalFile: 'localfile',
} as const;

export type ArtifactPreviewProtocol = typeof ArtifactPreviewProtocol[keyof typeof ArtifactPreviewProtocol];

export const ArtifactBrowserPartition = {
  Default: 'persist:lobster-artifact-browser',
} as const;

export type ArtifactBrowserPartition = typeof ArtifactBrowserPartition[keyof typeof ArtifactBrowserPartition];
