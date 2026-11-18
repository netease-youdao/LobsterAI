import { describe, expect, test } from 'vitest';

import type { PersistedGeneratedImageAsset } from './mediaAssetPersistence';
import { formatMediaLayerLines, readMediaLayers } from './mediaLayers';

const saved = (outputIndex: number, filePath: string): PersistedGeneratedImageAsset => ({
  type: 'image',
  url: `file://${filePath}`,
  originalUrl: `https://cdn/${outputIndex}`,
  mimeType: 'image/png',
  filename: filePath.split('/').pop() ?? '',
  filePath,
  localPath: filePath,
  outputIndex,
});

describe('formatMediaLayerLines', () => {
  test('describes base image and layers with their saved files', () => {
    const lines = formatMediaLayerLines([
      { url: 'https://cdn/0', size: '2048x2048', outputFormat: 'jpeg', zIndex: 0 },
      {
        url: 'https://cdn/1', size: '1273x265', zIndex: 1, name: '标题',
        boundingBox: { absolute: [383, 120, 1655, 384] }, textRecognition: { text: 'Seedream' },
      },
    ], [saved(1, '/w/title.png'), saved(0, '/w/base.jpeg')]);

    expect(lines).toEqual([
      'Layers (box is [left, top, right, bottom] in base-image pixels; stack layers by ascending zIndex):',
      '  - zIndex 0 base image, 2048x2048, file /w/base.jpeg',
      '  - zIndex 1, "标题", 1273x265, box [383, 120, 1655, 384], text "Seedream", file /w/title.png',
    ]);
  });

  test('returns nothing for ordinary results', () => {
    expect(formatMediaLayerLines(undefined)).toEqual([]);
    expect(formatMediaLayerLines([{ url: 'https://cdn/0' }])).toEqual([]);
    expect(readMediaLayers({ zIndex: 0 })).toEqual([]);
  });
});
