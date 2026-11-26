import { describe, expect, test } from 'vitest';

import {
  BUILTIN_SHOWCASE_CATALOGS,
  getBuiltinShowcaseExamples,
} from './catalogs';
import { HomeShowcaseCategoryId } from './constants';
import { homeShowcaseTranslations } from './copy';

describe('homeShowcase catalogs and translations', () => {
  test('provides 8 unique bilingual remixable examples for each built-in vertical', () => {
    const categories = [
      HomeShowcaseCategoryId.DeepResearch,
      HomeShowcaseCategoryId.Pptx,
      HomeShowcaseCategoryId.DataAnalysis,
      HomeShowcaseCategoryId.DocWriting,
      HomeShowcaseCategoryId.Website,
    ] as const;

    const allIds = new Set<string>();
    for (const categoryId of categories) {
      const entry = BUILTIN_SHOWCASE_CATALOGS[categoryId];
      expect(entry.examples).toHaveLength(8);
      const validFilterIds = new Set(entry.filters.map(f => f.id));

      for (const example of entry.examples) {
        expect(allIds.has(example.id)).toBe(false);
        allIds.add(example.id);
        expect(example.categoryId).toBe(categoryId);
        expect(validFilterIds.has(example.filterTag)).toBe(true);
        expect(example.title.zh.trim()).not.toBe('');
        expect(example.title.en.trim()).not.toBe('');
        expect(example.demoPrompt.zh.trim()).not.toBe('');
        expect(example.demoPrompt.en.trim()).not.toBe('');
        expect(example.customPromptTemplate.zh).toContain('{{input}}');
        expect(example.customPromptTemplate.en).toContain('{{input}}');
      }
    }
  });

  test('bundles real sample datasets for every data analysis example and hybrid local research', () => {
    const dataExamples = getBuiltinShowcaseExamples(HomeShowcaseCategoryId.DataAnalysis);
    for (const example of dataExamples) {
      expect(example.sampleFiles?.length ?? 0).toBeGreaterThan(0);
      expect(example.sampleFiles?.[0]?.content.trim().length ?? 0).toBeGreaterThan(40);
    }

    const hybridResearch = getBuiltinShowcaseExamples(HomeShowcaseCategoryId.DeepResearch)
      .find(item => item.id === 'research-hybrid-local');
    expect(hybridResearch?.sampleFiles?.[0]?.name).toContain('.md');
  });

  test('filters examples cleanly by tag', () => {
    const makeover = getBuiltinShowcaseExamples(HomeShowcaseCategoryId.Pptx, 'makeover');
    expect(makeover).toHaveLength(1);
    expect(makeover[0]?.id).toBe('ppt-tpl-makeover');

    const allPpt = getBuiltinShowcaseExamples(HomeShowcaseCategoryId.Pptx, 'all');
    expect(allPpt).toHaveLength(8);
  });

  test('keeps zh and en translation keys strictly in sync', () => {
    const zhKeys = Object.keys(homeShowcaseTranslations.zh).sort();
    const enKeys = Object.keys(homeShowcaseTranslations.en).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});
