import type {
  PresentedSkin,
  PresentedSkinAsset,
} from '../../shared/skin/types';
import { buildSkinAssetUrl } from './skinProtocol';
import type { SkinAssetRecord, SkinRecord } from './skinStore';

const presentAsset = (skinId: string, asset: SkinAssetRecord): PresentedSkinAsset => ({
  url: buildSkinAssetUrl(skinId, asset.slot, asset.contentHash),
  cacheKey: asset.contentHash,
  mimeType: asset.mimeType,
  width: asset.width,
  height: asset.height,
});

export function presentSkin(record: SkinRecord): PresentedSkin {
  const assets: PresentedSkin['assets'] = {};
  for (const asset of Object.values(record.assets)) {
    if (asset) assets[asset.slot] = presentAsset(record.id, asset);
  }

  return {
    id: record.id,
    ...(record.name === undefined ? {} : { name: record.name }),
    workflowKind: record.workflowKind,
    ...(record.baseThemeId === undefined ? {} : { baseThemeId: record.baseThemeId }),
    ...(record.boundThemeId === undefined ? {} : { boundThemeId: record.boundThemeId }),
    ...(record.presentation === undefined ? {} : { presentation: record.presentation }),
    status: record.status,
    assets,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.appliedAt === undefined ? {} : { appliedAt: record.appliedAt }),
  };
}
