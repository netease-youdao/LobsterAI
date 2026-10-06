export const SkinWorkflowKind = {
  SkinPack: 'skin_pack',
} as const;

export type SkinWorkflowKind = typeof SkinWorkflowKind[keyof typeof SkinWorkflowKind];

export const SkinAssetSlot = {
  WorkspaceBackdrop: 'workspace.backdrop',
  HomeEmblem: 'home.emblem',
} as const;

export type SkinAssetSlot = typeof SkinAssetSlot[keyof typeof SkinAssetSlot];

export const SKIN_ASSET_SLOTS: readonly SkinAssetSlot[] = [
  SkinAssetSlot.WorkspaceBackdrop,
  SkinAssetSlot.HomeEmblem,
];

export const SkinRecordStatus = {
  Draft: 'draft',
  Ready: 'ready',
} as const;

export type SkinRecordStatus = typeof SkinRecordStatus[keyof typeof SkinRecordStatus];

export const SkinPresentationMode = {
  ImmersiveShell: 'immersive_shell',
} as const;

export type SkinPresentationMode = typeof SkinPresentationMode[keyof typeof SkinPresentationMode];

export const SkinPreferredAppearance = {
  Light: 'light',
  Dark: 'dark',
} as const;

export type SkinPreferredAppearance =
  typeof SkinPreferredAppearance[keyof typeof SkinPreferredAppearance];

export const SkinParticleDensity = {
  None: 'none',
  Sparse: 'sparse',
} as const;

export type SkinParticleDensity = typeof SkinParticleDensity[keyof typeof SkinParticleDensity];

export const SkinAssetFormat = {
  Png: 'png',
  Jpeg: 'jpeg',
  Webp: 'webp',
} as const;

export type SkinAssetFormat = typeof SkinAssetFormat[keyof typeof SkinAssetFormat];

export const SkinAssetExtension = {
  Png: 'png',
  Jpeg: 'jpg',
  Webp: 'webp',
} as const;

export type SkinAssetExtension = typeof SkinAssetExtension[keyof typeof SkinAssetExtension];

export const SkinAssetMimeType = {
  Png: 'image/png',
  Jpeg: 'image/jpeg',
  Webp: 'image/webp',
} as const;

export type SkinAssetMimeType = typeof SkinAssetMimeType[keyof typeof SkinAssetMimeType];

export const SkinProtocol = {
  Scheme: 'lobster-skin',
  Host: 'asset',
} as const;

export const SkinIpc = {
  GetActive: 'skin:getActive',
  List: 'skin:list',
  Apply: 'skin:apply',
  BindTheme: 'skin:bindTheme',
  Deactivate: 'skin:deactivate',
  Delete: 'skin:delete',
  Changed: 'skin:changed',
} as const;

export type SkinIpc = typeof SkinIpc[keyof typeof SkinIpc];

export const SkinToolName = {
  Manage: 'lobsterai_skin_manage',
} as const;

export type SkinToolName = typeof SkinToolName[keyof typeof SkinToolName];

export const SkinToolAction = {
  CreateDraft: 'create_draft',
  RegisterAsset: 'register_asset',
  Status: 'status',
  Apply: 'apply',
  Deactivate: 'deactivate',
} as const;

export type SkinToolAction = typeof SkinToolAction[keyof typeof SkinToolAction];

export const SkinStoreErrorCode = {
  InvalidRegistry: 'invalid_registry',
  InvalidDraft: 'invalid_draft',
  InvalidSkinId: 'invalid_skin_id',
  InvalidSlot: 'invalid_slot',
  InvalidSource: 'invalid_source',
  UnsupportedSourceScheme: 'unsupported_source_scheme',
  SourceNotFound: 'source_not_found',
  SourceNotRegularFile: 'source_not_regular_file',
  AssetTooLarge: 'asset_too_large',
  UnsupportedAssetFormat: 'unsupported_asset_format',
  InvalidAssetDimensions: 'invalid_asset_dimensions',
  SkinNotFound: 'skin_not_found',
  SkinIncomplete: 'skin_incomplete',
  SlotOutOfOrder: 'slot_out_of_order',
  SlotAlreadyRegistered: 'slot_already_registered',
  ActiveSkinImmutable: 'active_skin_immutable',
  InvalidThemeId: 'invalid_theme_id',
  UnsafeAssetPath: 'unsafe_asset_path',
} as const;

export type SkinStoreErrorCode = typeof SkinStoreErrorCode[keyof typeof SkinStoreErrorCode];

export const SKIN_REGISTRY_VERSION = 1;
