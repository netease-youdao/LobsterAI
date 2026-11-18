import type { ModelPresetId } from '../modelPresets/constants';

export interface CoworkModelChange {
  previousModelRef: string;
  nextModelRef: string;
  previousPresetId?: ModelPresetId | null;
  nextPresetId?: ModelPresetId | null;
}
