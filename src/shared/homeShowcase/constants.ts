export const HomeShowcaseCategoryId = {
  DataAnalysis: 'data-analysis',
  DeepResearch: 'deep-research',
  Website: 'website',
  ImageCreation: 'image-creation',
  Pptx: 'pptx',
  DocWriting: 'doc-writing',
} as const;
export type HomeShowcaseCategoryId = typeof HomeShowcaseCategoryId[keyof typeof HomeShowcaseCategoryId];

export const HOME_SHOWCASE_EXPLORE_MORE_ID = 'explore-more' as const;
export type HomeShowcasePrimaryEntryId =
  | typeof HomeShowcaseCategoryId.DataAnalysis
  | typeof HomeShowcaseCategoryId.DeepResearch
  | typeof HomeShowcaseCategoryId.Website
  | typeof HomeShowcaseCategoryId.ImageCreation
  | typeof HOME_SHOWCASE_EXPLORE_MORE_ID;

/** The 4 default homepage quick-entry categories plus the 5th Explore More card. */
export const HOME_SHOWCASE_PRIMARY_ORDER: readonly HomeShowcasePrimaryEntryId[] = [
  HomeShowcaseCategoryId.DataAnalysis,
  HomeShowcaseCategoryId.DeepResearch,
  HomeShowcaseCategoryId.Website,
  HomeShowcaseCategoryId.ImageCreation,
  HOME_SHOWCASE_EXPLORE_MORE_ID,
];

export const HOME_SHOWCASE_EXPLORE_RECOMMENDED_ID = 'recommended' as const;
export type HomeShowcaseExploreTabId =
  | typeof HOME_SHOWCASE_EXPLORE_RECOMMENDED_ID
  | HomeShowcaseCategoryId;

/** Tabs displayed inside the Explore More discovery bar (Slides & Docs featured upfront). */
export const HOME_SHOWCASE_EXPLORE_TAB_ORDER: readonly HomeShowcaseExploreTabId[] = [
  HOME_SHOWCASE_EXPLORE_RECOMMENDED_ID,
  HomeShowcaseCategoryId.Pptx,
  HomeShowcaseCategoryId.DocWriting,
  HomeShowcaseCategoryId.DataAnalysis,
  HomeShowcaseCategoryId.DeepResearch,
  HomeShowcaseCategoryId.Website,
  HomeShowcaseCategoryId.ImageCreation,
];

export const HOME_SHOWCASE_CATEGORY_ORDER: readonly HomeShowcaseCategoryId[] = [
  HomeShowcaseCategoryId.DataAnalysis,
  HomeShowcaseCategoryId.DeepResearch,
  HomeShowcaseCategoryId.Website,
  HomeShowcaseCategoryId.ImageCreation,
  HomeShowcaseCategoryId.Pptx,
  HomeShowcaseCategoryId.DocWriting,
];

export const ShowcasePreviewKind = {
  ResearchReport: 'research-report',
  SlidesTemplate: 'slides-template',
  DataDashboard: 'data-dashboard',
  DocumentTransform: 'document-transform',
  WebsiteLive: 'website-live',
} as const;
export type ShowcasePreviewKind = typeof ShowcasePreviewKind[keyof typeof ShowcasePreviewKind];

export const ShowcaseRemixMode = {
  Custom: 'custom',
  Demo: 'demo',
} as const;
export type ShowcaseRemixMode = typeof ShowcaseRemixMode[keyof typeof ShowcaseRemixMode];

export const ShowcaseAccent = {
  Indigo: 'indigo',
  Rose: 'rose',
  Emerald: 'emerald',
  Violet: 'violet',
  Blue: 'blue',
  Amber: 'amber',
  Slate: 'slate',
  Teal: 'teal',
} as const;
export type ShowcaseAccent = typeof ShowcaseAccent[keyof typeof ShowcaseAccent];

export interface LocalizedText {
  zh: string;
  en: string;
}

export interface ShowcaseSampleFile {
  name: string;
  mimeType: string;
  content: string;
  /** Short human-readable lines shown in the preview tab when inspecting raw input. */
  previewLines?: LocalizedText[];
}

export interface ShowcaseOptionChoice {
  id: string;
  label: LocalizedText;
  promptFragment: LocalizedText;
  /** Optional additional skills to activate when this choice is selected (e.g. docx / pptx). */
  extraSkillIds?: string[];
  /** Optional Plan mode trigger (e.g. PPT outline confirmation). */
  usePlanMode?: boolean;
}

export interface ShowcaseOptionGroup {
  id: string;
  label: LocalizedText;
  defaultChoiceId: string;
  choices: ShowcaseOptionChoice[];
}

export interface ShowcaseCustomSlot {
  label: LocalizedText;
  placeholder: LocalizedText;
  /** Default example topic shown as reference when using demo mode. */
  demoValue: LocalizedText;
  multiline?: boolean;
}

export interface ResearchPreviewData {
  kind: typeof ShowcasePreviewKind.ResearchReport;
  sourceCount: number;
  kicker: LocalizedText;
  headline: LocalizedText;
  summary: LocalizedText;
  tableHeaders: LocalizedText[];
  tableRows: Array<{ cells: LocalizedText[]; highlight?: boolean }>;
  citations: LocalizedText[];
}

export interface SlideTemplatePagePreview {
  label: LocalizedText;
  heading: LocalizedText;
  bullets: LocalizedText[];
  statValue?: string;
  statLabel?: LocalizedText;
}

export interface SlidesTemplatePreviewData {
  kind: typeof ShowcasePreviewKind.SlidesTemplate;
  theme: 'mckinsey' | 'emerald-kpi' | 'dark-keynote' | 'warm-editorial' | 'academic' | 'playful-edu' | 'pitch-bold' | 'makeover';
  slideCount: number;
  coverTitle: LocalizedText;
  coverSubtitle: LocalizedText;
  pages: SlideTemplatePagePreview[];
}

export interface DataDashboardPreviewData {
  kind: typeof ShowcasePreviewKind.DataDashboard;
  kicker: LocalizedText;
  metrics: Array<{ label: LocalizedText; value: string; delta?: string }>;
  bars: Array<{ label: LocalizedText; percent: number; valueText: string }>;
  insight: LocalizedText;
}

export interface DocumentTransformPreviewData {
  kind: typeof ShowcasePreviewKind.DocumentTransform;
  docTypeBadge: LocalizedText;
  docTitle: LocalizedText;
  sections: Array<{ heading: LocalizedText; items: LocalizedText[]; tone?: 'default' | 'warning' | 'success' }>;
  rawInputExcerpt: LocalizedText;
}

export interface WebsiteLivePreviewData {
  kind: typeof ShowcasePreviewKind.WebsiteLive;
  layout: 'resume' | 'travel' | 'invitation' | 'shop' | 'calculator' | 'science' | 'launch' | 'gallery';
  urlSlug: string;
  heroTitle: LocalizedText;
  heroSubtitle: LocalizedText;
  ctaLabel: LocalizedText;
  cards: Array<{ title: LocalizedText; meta: LocalizedText }>;
  publishable?: boolean;
}

export type ShowcasePreviewData =
  | ResearchPreviewData
  | SlidesTemplatePreviewData
  | DataDashboardPreviewData
  | DocumentTransformPreviewData
  | WebsiteLivePreviewData;

export interface HomeShowcaseFilterOption {
  id: string;
  label: LocalizedText;
}

export interface HomeShowcaseExample {
  id: string;
  categoryId: Exclude<HomeShowcaseCategoryId, typeof HomeShowcaseCategoryId.ImageCreation>;
  filterTag: string;
  accent: ShowcaseAccent;
  title: LocalizedText;
  subtitle: LocalizedText;
  badge: LocalizedText;
  description: LocalizedText;
  skillId?: string;
  acceptsUpload?: boolean;
  uploadAccept?: string;
  uploadHint?: LocalizedText;
  customSlot: ShowcaseCustomSlot;
  optionGroups: ShowcaseOptionGroup[];
  demoPrompt: LocalizedText;
  customPromptTemplate: LocalizedText;
  sampleFiles?: ShowcaseSampleFile[];
  preview: ShowcasePreviewData;
}

export const HOME_SHOWCASE_DRAFT_KEY = '__home__';
export const HOME_SHOWCASE_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const HOME_SHOWCASE_MAX_ATTACHMENTS = 5;
