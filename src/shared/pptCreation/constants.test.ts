import { expect, test } from 'vitest';

import { pptCatalogFixture } from '../../../tests/fixtures/pptCreation';
import { ModelPresetId } from '../modelPresets/constants';
import { isPptAssetUrl, parsePptCatalog, PptAssetKind, PptCreation } from './constants';

test('accepts a complete bilingual catalog while preserving operator order and defaults', () => {
  const input = pptCatalogFixture();
  expect(parsePptCatalog(input)).toEqual(input);
});
test('older catalogs default to Fast while operators can change the recommended preset', () => {
  const input = pptCatalogFixture();
  const { recommendedModelPreset: _preset, ...legacy } = input;
  expect(parsePptCatalog(legacy).recommendedModelPreset).toBe(ModelPresetId.Balanced);
  expect(parsePptCatalog({ ...input, recommendedModelPreset: ModelPresetId.Ultimate }).recommendedModelPreset).toBe(ModelPresetId.Ultimate);
  expect(() => parsePptCatalog({ ...input, recommendedModelPreset: 'removed-model' })).toThrow('recommended model');
});
test('accepts the NOS upload service asset host without accepting lookalike hosts', () => {
  expect(isPptAssetUrl('https://ydhardwarebusiness.nosdn.127.net/sample.pptx')).toBe(true);
  expect(isPptAssetUrl('https://ydhardwarebusiness.nosdn.127.net.example.com/sample.pptx')).toBe(false);
});
test.each(['http://ydhardwarecommon.nosdn.127.net/a', 'https://localhost/a', 'https://ydhardwarecommon.nosdn.127.net:8443/a',
  'https://user@ydhardwarecommon.nosdn.127.net/a', 'https://ydhardwarecommon.nosdn.127.net/a?token=secret', 'file:///a.pptx'])('rejects unsafe asset address %s', value => {
  expect(isPptAssetUrl(value)).toBe(false);
});
test('rejects an entire update with duplicate IDs, missing translations or an unknown template', () => {
  const duplicate = pptCatalogFixture(); duplicate.examples.push(duplicate.examples[0]);
  expect(() => parsePptCatalog(duplicate)).toThrow('Duplicate');
  const translation = pptCatalogFixture(); translation.examples[0].prompt.en = '';
  expect(() => parsePptCatalog(translation)).toThrow('text');
  const template = pptCatalogFixture(); template.examples[0].templateId = 'missing';
  expect(() => parsePptCatalog(template)).toThrow('Unknown');
});
test('rejects unsafe names, missing checksums and invalid preview pages', () => {
  const traversal = pptCatalogFixture(); traversal.examples[0].materials[0].name = '../private.csv';
  expect(() => parsePptCatalog(traversal)).toThrow('file');
  const checksum = pptCatalogFixture(); checksum.examples[0].materials[0].sha256 = 'invalid';
  expect(() => parsePptCatalog(checksum)).toThrow('file');
  const page = pptCatalogFixture(); page.examples[0].previews[0].slide = 11;
  expect(() => parsePptCatalog(page)).toThrow('preview');
});

test('rejects an operator update whose materials and template exceed the attachment limit', () => {
  const input = pptCatalogFixture();
  const example = input.examples[0];
  input.templates.push({ id: 'business', title: example.title, description: example.description,
    previewUrl: example.previews[0].url,
    file: { ...example.materials[0], id: 'business-file', name: 'business.pptx', kind: PptAssetKind.Pptx },
  });
  example.templateId = input.templates[0].id;
  example.materials = Array.from({ length: PptCreation.MaxAttachments }, (_, index) => ({
    ...example.materials[0], id: `material-${index}`,
  }));
  expect(() => parsePptCatalog(input)).toThrow('attachments');
});
