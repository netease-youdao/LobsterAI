import type {
  SkinAssetSlot,
  SkinRecordStatus,
  SkinWorkflowKind,
} from './constants';
import type { SkinPresentation } from './presentation';

export interface PresentedSkinAsset {
  url: string;
  cacheKey: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface PresentedSkin {
  id: string;
  name?: string;
  workflowKind: SkinWorkflowKind;
  baseThemeId?: string;
  boundThemeId?: string;
  presentation?: SkinPresentation;
  status: SkinRecordStatus;
  assets: Partial<Record<SkinAssetSlot, PresentedSkinAsset>>;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export type SkinGetActiveResponse =
  | { success: true; activeSkin: PresentedSkin | null }
  | { success: false; error: string };

export type SkinListResponse =
  | { success: true; skins: PresentedSkin[] }
  | { success: false; error: string };

export type SkinApplyResponse =
  | { success: true; activeSkin: PresentedSkin }
  | { success: false; error: string };

export type SkinBindThemeResponse =
  | { success: true; skin: PresentedSkin }
  | { success: false; error: string };

export type SkinDeactivateResponse =
  | { success: true }
  | { success: false; error: string };

export type SkinDeleteResponse =
  | { success: true; wasActive: boolean }
  | { success: false; error: string };
