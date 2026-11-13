import type { PersistedGeneratedImageAsset } from './mediaAssetPersistence';

/** One image of a layer decomposition result, as returned by the server's v2 task `layers` field. */
export interface MediaImageLayer {
  url?: string;
  size?: string;
  outputFormat?: string;
  zIndex: number;
  name?: string;
  description?: string;
  boundingBox?: { absolute?: number[]; normalized?: number[] };
  textRecognition?: { text?: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Keeps entries that carry a numeric zIndex; anything else is not a layer. */
export function readMediaLayers(value: unknown): MediaImageLayer[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MediaImageLayer => isRecord(item) && typeof item.zIndex === 'number');
}

/**
 * Describes each layer for the agent. Layers share the order of `resultUrls`, so the saved file of
 * layer i is the persisted asset with outputIndex i.
 */
export function formatMediaLayerLines(value: unknown, saved: PersistedGeneratedImageAsset[] = []): string[] {
  const layers = readMediaLayers(value);
  if (layers.length === 0) return [];
  const files = new Map(saved.filter(asset => Number.isInteger(asset.outputIndex))
    .map(asset => [asset.outputIndex as number, asset.filePath]));
  const lines = layers.map((layer, index) => {
    const parts = [layer.zIndex === 0 ? `zIndex 0 base image` : `zIndex ${layer.zIndex}`];
    if (layer.zIndex !== 0 && layer.name) parts.push(`"${layer.name}"`);
    if (layer.size) parts.push(layer.size);
    const box = layer.boundingBox?.absolute;
    if (Array.isArray(box) && box.length === 4) parts.push(`box [${box.join(', ')}]`);
    const text = layer.textRecognition?.text;
    if (text) parts.push(`text ${JSON.stringify(text)}`);
    if (layer.description) parts.push(`description ${JSON.stringify(layer.description)}`);
    const file = files.get(index);
    if (file) parts.push(`file ${file}`);
    return `  - ${parts.join(', ')}`;
  });
  return [
    'Layers (box is [left, top, right, bottom] in base-image pixels; stack layers by ascending zIndex):',
    ...lines,
  ];
}
