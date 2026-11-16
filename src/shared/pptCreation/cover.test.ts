import { expect, test } from 'vitest';

import { pptCatalogFixture } from '../../../tests/fixtures/pptCreation';
import { parsePptCatalog, PptAssetKind } from './constants';
import { buildCoverImagePrompt, layoutCoverText, PptCover } from './cover';

test.each(['小学科学\n水循环教案', '校园读书节活动方案', 'Quarterly business review', '年度项目实施情况与下一年度重点工作计划汇报'])('fits editable text into the left safe area: %s', title => {
  const lines = layoutCoverText({ title, subtitle: '面向五年级学生\n课堂讲解与互动', footer: '2026 年 11 月' });
  expect(lines.map(line => line.text).join('').replace(/\s/g, '')).toContain(title.replace(/\s/g, ''));
  expect(lines.every(line => line.x + line.width <= 640 && line.y + line.height < 720)).toBe(true);
  expect(lines.filter(line => line.bold).every(line => line.size >= 32)).toBe(true);
});
test('rejects empty, overflowing and invalid XML text instead of truncating it', () => {
  for (const title of ['', '字'.repeat(51), '1\n2\n3\n4', 'bad\u0000title']) expect(() => layoutCoverText({ title, subtitle: '', footer: '' })).toThrow();
});
test('curated cover defaults to Seedream Pro and accepts a configured replacement', () => {
  const catalog = pptCatalogFixture(), text = { zh: '封面', en: 'Cover' };
  catalog.examples[0].cover = { file: { ...catalog.examples[0].materials[0], id: 'cover', name: 'cover.pptx', kind: PptAssetKind.Pptx }, title: text, subtitle: text, footer: text, subject: text };
  expect(parsePptCatalog(catalog).coverImageModel).toBe(PptCover.DefaultImageModel);
  expect(parsePptCatalog({ ...catalog, coverImageModel: 'future-image-model' }).coverImageModel).toBe('future-image-model');
  expect(() => parsePptCatalog({ ...catalog, coverImageModel: 'https://invalid' })).toThrow();
  catalog.examples[0].cover.file.kind = PptAssetKind.Csv;
  expect(() => parsePptCatalog(catalog)).toThrow();
});
test('image prompt reserves text space and requests one image without automatic retries', () => {
  const prompt = buildCoverImagePrompt('校园图书馆', '纸艺');
  expect(prompt).toContain('LEFT 52%'); expect(prompt).toContain('n=1');
  expect(prompt).toContain('Do not use other models'); expect(prompt).toContain('No words');
});
