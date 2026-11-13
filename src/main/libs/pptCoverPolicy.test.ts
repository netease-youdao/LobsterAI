import { expect, test } from 'vitest';

import { pptCatalogFixture } from '../../../tests/fixtures/pptCreation';
import { type MediaSelection,MediaSelectionMode } from '../../shared/media/defaultPolicy';
import { PptAssetKind } from '../../shared/pptCreation/constants';
import { PptCover } from '../../shared/pptCreation/cover';
import { applyMediaDefaultParameters, MediaDefaultImageBudget } from '../mediaDefaultExecution';
import { applyCoverMediaPolicy } from './pptCoverPolicy';

const catalog = pptCatalogFixture();
const text = { zh: '封面', en: 'Cover' };
catalog.examples[0].cover = { file: { ...catalog.examples[0].materials[0], name: 'cover.pptx', kind: PptAssetKind.Pptx }, title: text, subtitle: text, footer: text, subject: text };
const request = { version: catalog.version, exampleId: catalog.examples[0].id };
const selection: MediaSelection = { mode: MediaSelectionMode.Image, imageModelId: PptCover.DefaultImageModel };
test('enforces one output and an extra-call confirmation through the native media budget', () => {
  const result = applyCoverMediaPolicy(catalog, request, selection);
  expect(result.videoModelId).toBeUndefined();
  expect(applyMediaDefaultParameters({ n: 10, count: 10 }, result.imageDefault, 'image')).toMatchObject({ n: 1, count: 1, sequential_image_generation: 'disabled' });
  const budget = new MediaDefaultImageBudget();
  expect(budget.needsConfirmation(result.imageDefault, 'first')).toBe(false);
  expect(budget.needsConfirmation(result.imageDefault, 'second')).toBe(true);
});
test('rejects stale catalog, missing example, disabled media and model fallback', () => {
  expect(() => applyCoverMediaPolicy(catalog, { ...request, version: 'stale' }, selection)).toThrow();
  expect(() => applyCoverMediaPolicy(catalog, { ...request, exampleId: 'missing' }, selection)).toThrow();
  expect(() => applyCoverMediaPolicy(catalog, request, { mode: MediaSelectionMode.None })).toThrow();
  expect(() => applyCoverMediaPolicy(catalog, request, { ...selection, imageModelId: 'other' })).toThrow();
});
