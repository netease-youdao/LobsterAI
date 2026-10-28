import { expect, test } from 'vitest';

import { imageRegionCoordinates } from './geometry';
import { imageEditMessageMetadata } from './messageSnapshot';
import { imageEditPrompt, imageEditRegionPrompt } from './prompts';
import { ImageEditOperation, type ImageEditRequest } from './types';

function request(): ImageEditRequest {
  return {
    id: 'request-1', createdAt: 2, sourceVersionNumber: 10, operation: ImageEditOperation.Comment,
    source: { id: 'v10', rootId: 'v1', sessionId: 's1', filePath: '/private/request-1.png',
      title: 'cup.png', width: 2048, height: 2048, operation: ImageEditOperation.Comment, createdAt: 1 },
    regions: [
      { id: 'dog', x: 0.4717832957110609, y: 0.510158013544018, width: 0.16930022573363435, height: 0.20767494356659144, text: '在这里加上一只狗' },
      { id: 'cat', x: 0, y: 0, width: 0.25, height: 0.5, text: 'Add a cat' },
    ],
  };
}

test('snapshot copies source and all regions without retaining mutable draft references', () => {
  const edit = request();
  const metadata = imageEditMessageMetadata([{}, { imageEdit: edit }, { imageEdit: edit }]);
  expect(metadata.imageEdits).toHaveLength(1);
  edit.source.title = 'next version.png';
  edit.regions[0].text = 'Revised';
  edit.regions.reverse();
  expect(metadata.imageEdits?.[0]).toMatchObject({ sourceVersionNumber: 10, source: { title: 'cup.png' },
    regions: [{ id: 'dog', text: '在这里加上一只狗' }, { id: 'cat' }] });
  expect(imageEditMessageMetadata([{}])).toEqual({});
  expect(imageEditMessageMetadata()).toEqual({});
});

test('displayed percentages and numbered image-model instructions agree, with source pixels as a secondary view', () => {
  const edit = request();
  expect(imageRegionCoordinates(edit.regions[0], edit.source)).toEqual({
    percent: ['47.2', '51.0', '16.9', '20.8'], pixels: [966, 1045, 347, 425],
  });
  const prompt = imageEditRegionPrompt(edit);
  expect(prompt).toContain('2048 x 2048');
  expect(prompt).toContain('top-left corner');
  expect(prompt).toContain('1. [47.2, 51.0, 16.9, 20.8]: 在这里加上一只狗');
  expect(prompt).toContain('2. [0.0, 0.0, 25.0, 50.0]: Add a cat');
  expect(imageEditPrompt(edit)).toContain(prompt);
});
