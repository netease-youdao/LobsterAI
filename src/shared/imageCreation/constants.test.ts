import { expect, test } from 'vitest';

import { emptyImageCreationCatalog, isImageExampleUrl, parseImageCreationCatalog } from './constants';

export const imageCatalogFixture = () => ({
  schemaVersion: 1, version: '2026-11-10.1', enabled: true, expertPresetId: 'image-creation-partner',
  examples: [{ id: 'poster', title: { zh: '活动海报', en: 'Event poster' },
    description: { zh: '做一张海报', en: 'Make a poster' }, prompt: { zh: '生成读书活动海报', en: 'Generate a reading event poster' },
    imageUrl: 'https://ydhardwarecommon.nosdn.127.net/poster.webp', modelName: 'Seedream 5.0 Pro' }],
});

test('accepts editable bilingual examples and a valid disabled configuration', () => {
  expect(parseImageCreationCatalog(imageCatalogFixture()).examples[0].prompt.zh).toContain('生成');
  expect(parseImageCreationCatalog(emptyImageCreationCatalog()).enabled).toBe(false);
});
test('rejects duplicate ids, empty enabled galleries and incomplete translations', () => {
  const duplicate = imageCatalogFixture(); duplicate.examples.push(duplicate.examples[0]);
  expect(() => parseImageCreationCatalog(duplicate)).toThrow();
  expect(() => parseImageCreationCatalog({ ...imageCatalogFixture(), examples: [] })).toThrow();
  const untranslated = imageCatalogFixture(); untranslated.examples[0].prompt.en = '';
  expect(() => parseImageCreationCatalog(untranslated)).toThrow();
});
test.each([
  'http://ydhardwarecommon.nosdn.127.net/x.png', 'https://localhost/x.png', 'file:///C:/secret.png',
  'https://ydhardwarecommon.nosdn.127.net.evil.test/x.png', 'https://user@ydhardwarecommon.nosdn.127.net/x.png',
  'https://ydhardwarecommon.nosdn.127.net/x.png?token=secret',
])('rejects untrusted image URLs: %s', url => expect(isImageExampleUrl(url)).toBe(false));
test('validates reference images with the same policy as covers', () => {
  const value = imageCatalogFixture();
  expect(() => parseImageCreationCatalog({ ...value, examples: [{ ...value.examples[0], referenceImageUrl: 'http://127.0.0.1/secret' }] })).toThrow();
});

test('keeps comparison previews optional and requires a reference when enabled', () => {
  const value = imageCatalogFixture();
  const example = value.examples[0];
  expect(parseImageCreationCatalog(value).examples[0].showReferencePreview).toBeUndefined();
  const withReference = { ...example, referenceImageUrl: example.imageUrl, showReferencePreview: true };
  expect(parseImageCreationCatalog({ ...value, examples: [withReference] }).examples[0].showReferencePreview).toBe(true);
  expect(() => parseImageCreationCatalog({ ...value, examples: [{ ...example, showReferencePreview: true }] })).toThrow();
  expect(() => parseImageCreationCatalog({ ...value, examples: [{ ...withReference, showReferencePreview: 'true' }] })).toThrow();
});
