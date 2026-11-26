import { configureStore } from '@reduxjs/toolkit';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { describe, expect, test, vi } from 'vitest';

import { pptCatalogFixture } from '../../../../tests/fixtures/pptCreation';
import {
  getAllBuiltinShowcaseExamples,
  getBuiltinShowcaseExamples,
} from '../../../shared/homeShowcase/catalogs';
import {
  HOME_SHOWCASE_EXPLORE_MORE_ID,
  HomeShowcaseCategoryId,
} from '../../../shared/homeShowcase/constants';
import { i18nService } from '../../services/i18n';
import { store as applicationStore } from '../../store';
import HomePptCreation from '../pptCreation/HomePptCreation';
import { SHOWCASE_COVER_IMAGES } from './coverImages';
import HomeShowcaseHub from './HomeShowcaseHub';
import RemixExampleDialog from './RemixExampleDialog';

const mockedPptCatalog = vi.hoisted(() => ({ value: null as ReturnType<typeof pptCatalogFixture> | null }));

vi.hoisted(() => {
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electron: {},
  });
});

vi.mock('../imageCreation/useImageCreationCatalog', () => ({
  useImageCreationCatalog: () => ({
    catalog: {
      schemaVersion: 1,
      version: 'test',
      enabled: true,
      expertPresetId: 'image-partner',
      examples: [
        {
          id: 'poster-demo',
          title: { zh: '做一张活动海报', en: 'Event Poster' },
          prompt: { zh: '画一张周末读书会海报', en: 'Create an event poster' },
          imageUrl: 'https://example.com/poster.jpg',
        },
      ],
    },
    failed: false,
    retry: vi.fn(),
  }),
}));

vi.mock('../pptCreation/usePptCatalog', () => ({
  usePptCatalog: () => ({
    catalog: mockedPptCatalog.value,
    failed: false,
    retry: vi.fn(),
  }),
}));

function renderWithStore(node: React.ReactElement) {
  const base = applicationStore.getState();
  const store = configureStore({
    reducer: (state = base) => state,
  });
  return renderToStaticMarkup(React.createElement(Provider, { store, children: node }));
}

describe('HomeShowcaseHub single-row Manus layout & cover image gallery', () => {
  test('maps a real cover image asset for every single built-in showcase example', () => {
    const allExamples = getAllBuiltinShowcaseExamples();
    expect(allExamples).toHaveLength(40);
    for (const example of allExamples) {
      expect(SHOWCASE_COVER_IMAGES[example.id]).toBeTruthy();
    }
  });

  test('renders single-row 5 cards in exact order: Data, Deep Research, Website, Image, Explore More', () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderWithStore(
      React.createElement(HomeShowcaseHub, {
        selectedCategoryId: null,
        onCategorySelect: vi.fn(),
        onDraftReady: vi.fn(),
      }),
    );

    expect(html).toContain('data-home-showcase-hub="overview"');
    expect(html).toContain('md:grid-cols-5');

    const dataIdx = html.indexOf('data-home-category-card="data-analysis"');
    const researchIdx = html.indexOf('data-home-category-card="deep-research"');
    const websiteIdx = html.indexOf('data-home-category-card="website"');
    const imageIdx = html.indexOf('data-home-category-card="image-creation"');
    const moreIdx = html.indexOf('data-home-category-card="explore-more"');

    expect(dataIdx).toBeGreaterThan(-1);
    expect(researchIdx).toBeGreaterThan(dataIdx);
    expect(websiteIdx).toBeGreaterThan(researchIdx);
    expect(imageIdx).toBeGreaterThan(websiteIdx);
    expect(moreIdx).toBeGreaterThan(imageIdx);

    expect(html).toContain('数据分析');
    expect(html).toContain('深度调研');
    expect(html).toContain('创建网站');
    expect(html).toContain('图像创作');
    expect(html).toContain('探索更多');
    // Primary cards use scalable text-sm typography, 24px icons, and crisp input-level borders.
    expect(html).toContain('min-h-[112px]');
    expect(html).toContain('border-border-input');
    expect(html).toContain('line-clamp-2 w-full text-sm font-medium leading-snug text-foreground');
    expect(html).toContain('h-6 w-6');
    expect(html).not.toContain('text-[13.5px]');
    // Slides and Docs are housed inside Explore More, not in the primary 5-card row.
    expect(html).not.toContain('data-home-category-card="pptx"');
    expect(html).not.toContain('data-home-category-card="doc-writing"');
  });

  test('renders pure full-bleed cover image cards when a primary category is selected', () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderWithStore(
      React.createElement(HomeShowcaseHub, {
        selectedCategoryId: HomeShowcaseCategoryId.DataAnalysis,
        onCategorySelect: vi.fn(),
        onDraftReady: vi.fn(),
      }),
    );

    expect(html).toContain('data-home-showcase-hub="expanded"');
    expect(html).toContain('data-home-showcase-gallery="data-analysis"');
    expect(html).toContain('data-showcase-example="data-personal-bill"');
    expect(html).toContain('<img ');
    expect(html).toContain('data-personal-bill.jpg');
    expect(html).toContain('text-xs font-medium leading-5 text-foreground');
    expect(html).not.toContain('text-[13px]');
  });

  test('renders multi-category Explore More discovery bar featuring Slides and Document Writing', () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderWithStore(
      React.createElement(HomeShowcaseHub, {
        selectedCategoryId: HOME_SHOWCASE_EXPLORE_MORE_ID,
        onCategorySelect: vi.fn(),
        onDraftReady: vi.fn(),
      }),
    );

    expect(html).toContain('data-home-showcase-gallery="explore-more"');
    expect(html).toContain('data-explore-tab="recommended"');
    expect(html).toContain('data-explore-tab="pptx"');
    expect(html).toContain('data-explore-tab="doc-writing"');
    expect(html).toContain('为你推荐');
    expect(html).toContain('幻灯片');
    expect(html).toContain('文档写作');
    // Recommended feed includes curated Slides, Docs, Web, Research, and Data covers.
    expect(html).toContain('data-showcase-example="ppt-tpl-dark-keynote"');
    expect(html).toContain('data-showcase-example="doc-contract-review"');
  });

  test('renders RemixExampleDialog with full cover image preview and dual remix CTAs', () => {
    i18nService.setLanguage('zh', { persist: false });
    const example = getBuiltinShowcaseExamples(HomeShowcaseCategoryId.DeepResearch)[0];
    const html = renderToStaticMarkup(
      React.createElement(RemixExampleDialog, {
        example,
        onClose: vi.fn(),
        onApply: vi.fn(async () => true),
      }),
    );

    expect(html).toContain(`data-home-showcase-dialog="${example.id}"`);
    expect(html).toContain('research-appliance-buy.jpg');
    expect(html).toContain('用示例直接试做');
    expect(html).toContain('用我的内容做同款');
    expect(html).toContain('参考 28 篇信源');
  });

  test('renders direct Image Creation gallery with the same header bar and borderless rounded-2xl cover grid', () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderWithStore(
      React.createElement(HomeShowcaseHub, {
        selectedCategoryId: HomeShowcaseCategoryId.ImageCreation,
        onCategorySelect: vi.fn(),
        onDraftReady: vi.fn(),
      }),
    );

    expect(html).toContain('data-home-showcase-gallery="image-creation"');
    expect(html).toContain('全部');
    expect(html).toContain('浏览全部');
    expect(html).toContain('收起');
    expect(html).toContain('data-image-example="poster-demo"');
    expect(html).toContain('gap-x-4 gap-y-5');
    expect(html).toContain('rounded-2xl');
    expect(html).toContain('font-medium leading-5 text-foreground');
    // No separate footer link below the image shelf.
    expect(html).not.toContain('去专家广场，更多灵感');
  });

  test('renders embedded HomePptCreation without duplicate intro copy, bordered card boxes, or bottom collapse', () => {
    i18nService.setLanguage('zh', { persist: false });
    mockedPptCatalog.value = pptCatalogFixture();
    try {
      const html = renderWithStore(
        React.createElement(HomePptCreation, {
          active: true,
          embedded: true,
          onClose: vi.fn(),
          onDraftReady: vi.fn(),
          children: null,
        }),
      );

      expect(html).toContain('data-ppt-creation-home');
      expect(html).toContain('data-ppt-example="quarterly-report"');
      expect(html).toContain('aspect-[16/10]');
      expect(html).toContain('gap-x-4 gap-y-5');
      expect(html).toContain('text-xs font-medium leading-5 text-foreground');
      // Embedded PPT gallery must not render standalone heading/intro/browse-all/collapse chrome or white card frames.
      expect(html).not.toContain('从一份好演示开始');
      expect(html).not.toContain('查看全部示例');
      expect(html).not.toContain('收起');
      expect(html).not.toContain('border border-border bg-surface');
    } finally {
      mockedPptCatalog.value = null;
    }
  });
});
