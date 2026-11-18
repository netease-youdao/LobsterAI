import { MediaTaskWarning } from './constants';

export const hasLayerDecompositionWarning = (warnings: unknown): boolean =>
  Array.isArray(warnings) && warnings.includes(MediaTaskWarning.LayerDecompositionIncomplete);
