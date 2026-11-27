import {
  HomeShowcaseCategoryId,
  type HomeShowcaseExample,
  type HomeShowcaseFilterOption,
} from '../constants';
import { DATA_EXAMPLES, DATA_FILTERS } from './dataCatalog';
import { DOC_EXAMPLES, DOC_FILTERS } from './docCatalog';
import { PPT_TEMPLATE_EXAMPLES, PPT_TEMPLATE_FILTERS } from './pptTemplatesCatalog';
import { RESEARCH_EXAMPLES, RESEARCH_FILTERS } from './researchCatalog';
import { WEBSITE_EXAMPLES, WEBSITE_FILTERS } from './websiteCatalog';

export type BuiltinShowcaseCategoryId = Exclude<
  HomeShowcaseCategoryId,
  typeof HomeShowcaseCategoryId.ImageCreation
>;

export interface BuiltinShowcaseCatalogEntry {
  categoryId: BuiltinShowcaseCategoryId;
  headingKey: string;
  hintKey: string;
  filters: HomeShowcaseFilterOption[];
  examples: HomeShowcaseExample[];
}

export const BUILTIN_SHOWCASE_CATALOGS: Record<BuiltinShowcaseCategoryId, BuiltinShowcaseCatalogEntry> = {
  [HomeShowcaseCategoryId.DeepResearch]: {
    categoryId: HomeShowcaseCategoryId.DeepResearch,
    headingKey: 'homeShowcaseHeadingDeepResearch',
    hintKey: 'homeShowcaseHintDeepResearch',
    filters: RESEARCH_FILTERS,
    examples: RESEARCH_EXAMPLES,
  },
  [HomeShowcaseCategoryId.Pptx]: {
    categoryId: HomeShowcaseCategoryId.Pptx,
    headingKey: 'homeShowcaseHeadingPptx',
    hintKey: 'homeShowcaseHintPptx',
    filters: PPT_TEMPLATE_FILTERS,
    examples: PPT_TEMPLATE_EXAMPLES,
  },
  [HomeShowcaseCategoryId.DataAnalysis]: {
    categoryId: HomeShowcaseCategoryId.DataAnalysis,
    headingKey: 'homeShowcaseHeadingDataAnalysis',
    hintKey: 'homeShowcaseHintDataAnalysis',
    filters: DATA_FILTERS,
    examples: DATA_EXAMPLES,
  },
  [HomeShowcaseCategoryId.DocWriting]: {
    categoryId: HomeShowcaseCategoryId.DocWriting,
    headingKey: 'homeShowcaseHeadingDocWriting',
    hintKey: 'homeShowcaseHintDocWriting',
    filters: DOC_FILTERS,
    examples: DOC_EXAMPLES,
  },
  [HomeShowcaseCategoryId.Website]: {
    categoryId: HomeShowcaseCategoryId.Website,
    headingKey: 'homeShowcaseHeadingWebsite',
    hintKey: 'homeShowcaseHintWebsite',
    filters: WEBSITE_FILTERS,
    examples: WEBSITE_EXAMPLES,
  },
};

export function isBuiltinShowcaseCategory(
  id: string | null | undefined,
): id is BuiltinShowcaseCategoryId {
  return Boolean(id && Object.prototype.hasOwnProperty.call(BUILTIN_SHOWCASE_CATALOGS, id));
}

export function getBuiltinShowcaseCatalog(
  categoryId: BuiltinShowcaseCategoryId,
): BuiltinShowcaseCatalogEntry {
  return BUILTIN_SHOWCASE_CATALOGS[categoryId];
}

export function getBuiltinShowcaseExamples(
  categoryId: BuiltinShowcaseCategoryId,
  filterTag?: string,
): HomeShowcaseExample[] {
  const { examples } = BUILTIN_SHOWCASE_CATALOGS[categoryId];
  if (!filterTag || filterTag === 'all') return examples;
  return examples.filter(example => example.filterTag === filterTag);
}

const RECOMMENDED_EXAMPLE_IDS: readonly string[] = [
  'ppt-tpl-dark-keynote',
  'ppt-tpl-warm-editorial',
  'doc-meeting-minutes',
  'doc-contract-review',
  'web-family-trip',
  'web-interactive-explainer',
  'research-appliance-buy',
  'data-personal-bill',
];

export function getRecommendedShowcaseExamples(): HomeShowcaseExample[] {
  const byId = new Map<string, HomeShowcaseExample>();
  for (const entry of Object.values(BUILTIN_SHOWCASE_CATALOGS)) {
    for (const example of entry.examples) {
      byId.set(example.id, example);
    }
  }
  return RECOMMENDED_EXAMPLE_IDS
    .map(id => byId.get(id))
    .filter((item): item is HomeShowcaseExample => Boolean(item));
}

export function getAllBuiltinShowcaseExamples(): HomeShowcaseExample[] {
  return [
    ...PPT_TEMPLATE_EXAMPLES,
    ...DOC_EXAMPLES,
    ...DATA_EXAMPLES,
    ...RESEARCH_EXAMPLES,
    ...WEBSITE_EXAMPLES,
  ];
}
