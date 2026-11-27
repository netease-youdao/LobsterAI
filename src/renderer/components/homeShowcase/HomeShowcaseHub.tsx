import {
  ArrowRightIcon,
  ChartBarIcon,
  ChevronUpIcon,
  EllipsisHorizontalIcon,
  GlobeAltIcon,
  MagnifyingGlassCircleIcon,
  PhotoIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { ExpertUiEvent } from '../../../shared/agent/presets';
import {
  BUILTIN_SHOWCASE_CATALOGS,
  type BuiltinShowcaseCategoryId,
  getAllBuiltinShowcaseExamples,
  getBuiltinShowcaseExamples,
  getRecommendedShowcaseExamples,
  isBuiltinShowcaseCategory,
} from '../../../shared/homeShowcase/catalogs';
import {
  HOME_SHOWCASE_EXPLORE_MORE_ID,
  HOME_SHOWCASE_EXPLORE_RECOMMENDED_ID,
  HOME_SHOWCASE_EXPLORE_TAB_ORDER,
  HOME_SHOWCASE_PRIMARY_ORDER,
  HomeShowcaseCategoryId,
  type HomeShowcaseExample,
  type HomeShowcaseExploreTabId,
  type HomeShowcasePrimaryEntryId,
} from '../../../shared/homeShowcase/constants';
import {
  ImageCreation,
  type ImageCreationExample,
  type ImageExampleReference,
} from '../../../shared/imageCreation/constants';
import {
  prepareHomeShowcaseDraft,
  type ShowcaseRemixOptions,
} from '../../services/homeShowcaseDraft';
import { i18nService } from '../../services/i18n';
import { prepareImageCreationDraft } from '../../services/imageCreationDraft';
import type { RootState } from '../../store';
import Modal from '../common/Modal';
import { CoworkUiEvent } from '../cowork/constants';
import { reportPromptTemplateAction } from '../cowork/promptAnalytics';
import ImageExampleDialog from '../imageCreation/ImageExampleDialog';
import ImageExampleShelf from '../imageCreation/ImageExampleShelf';
import { useImageCreationCatalog } from '../imageCreation/useImageCreationCatalog';
import HomePptCreation from '../pptCreation/HomePptCreation';
import { usePptCatalog } from '../pptCreation/usePptCatalog';
import { QuickActionChip } from '../quick-actions';
import RemixExampleDialog from './RemixExampleDialog';
import { ShowcaseCardThumbnail } from './ShowcasePreviewCard';

interface PrimaryCardMeta {
  id: HomeShowcasePrimaryEntryId;
  titleKey: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>;
  iconAccent: string;
}

const PRIMARY_CARDS: Record<HomeShowcasePrimaryEntryId, PrimaryCardMeta> = {
  [HomeShowcaseCategoryId.DataAnalysis]: {
    id: HomeShowcaseCategoryId.DataAnalysis,
    titleKey: 'homeCategoryDataAnalysis',
    icon: ChartBarIcon,
    iconAccent: 'text-emerald-600 dark:text-emerald-400',
  },
  [HomeShowcaseCategoryId.DeepResearch]: {
    id: HomeShowcaseCategoryId.DeepResearch,
    titleKey: 'homeCategoryDeepResearch',
    icon: MagnifyingGlassCircleIcon,
    iconAccent: 'text-indigo-500 dark:text-indigo-400',
  },
  [HomeShowcaseCategoryId.Website]: {
    id: HomeShowcaseCategoryId.Website,
    titleKey: 'homeCategoryWebsite',
    icon: GlobeAltIcon,
    iconAccent: 'text-blue-500 dark:text-blue-400',
  },
  [HomeShowcaseCategoryId.ImageCreation]: {
    id: HomeShowcaseCategoryId.ImageCreation,
    titleKey: 'homeCategoryImageCreation',
    icon: PhotoIcon,
    iconAccent: 'text-amber-500 dark:text-amber-400',
  },
  [HOME_SHOWCASE_EXPLORE_MORE_ID]: {
    id: HOME_SHOWCASE_EXPLORE_MORE_ID,
    titleKey: 'homeCategoryExploreMore',
    icon: EllipsisHorizontalIcon,
    iconAccent: 'text-secondary',
  },
};

const EXPLORE_TAB_LABEL_KEYS: Record<HomeShowcaseExploreTabId, string> = {
  [HOME_SHOWCASE_EXPLORE_RECOMMENDED_ID]: 'homeExploreRecommended',
  [HomeShowcaseCategoryId.Pptx]: 'homeExplorePptTab',
  [HomeShowcaseCategoryId.DocWriting]: 'homeExploreDocTab',
  [HomeShowcaseCategoryId.DataAnalysis]: 'homeExploreDataTab',
  [HomeShowcaseCategoryId.DeepResearch]: 'homeExploreResearchTab',
  [HomeShowcaseCategoryId.Website]: 'homeExploreWebsiteTab',
  [HomeShowcaseCategoryId.ImageCreation]: 'homeExploreImageTab',
};

const CATEGORY_TITLE_KEYS: Record<HomeShowcaseCategoryId, string> = {
  [HomeShowcaseCategoryId.DataAnalysis]: 'homeCategoryDataAnalysis',
  [HomeShowcaseCategoryId.DeepResearch]: 'homeCategoryDeepResearch',
  [HomeShowcaseCategoryId.Website]: 'homeCategoryWebsite',
  [HomeShowcaseCategoryId.ImageCreation]: 'homeCategoryImageCreation',
  [HomeShowcaseCategoryId.Pptx]: 'homeCategoryPptx',
  [HomeShowcaseCategoryId.DocWriting]: 'homeCategoryDocWriting',
};

const HIDE_BELOW_FOUR_COLUMNS = '[@container_(max-width:639px)]:hidden';
const HIDE_BELOW_THREE_COLUMNS = '[@container_(max-width:459px)]:hidden';

function hiddenWhenNarrow(index: number): string {
  if (index >= 6) return HIDE_BELOW_FOUR_COLUMNS;
  if (index >= 4) return HIDE_BELOW_THREE_COLUMNS;
  return '';
}

interface HomeShowcaseHubProps {
  selectedCategoryId: string | null;
  onCategorySelect: (entryId: HomeShowcasePrimaryEntryId | null) => void;
  onDraftReady: (prompt: string) => void;
}

const HomeShowcaseHub: React.FC<HomeShowcaseHubProps> = ({
  selectedCategoryId,
  onCategorySelect,
  onDraftReady,
}) => {
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage();
  const { catalog: imageCatalog, failed: imageFailed, retry: retryImageCatalog } = useImageCreationCatalog();
  const { catalog: remotePptCatalog } = usePptCatalog();
  const owner = useSelector((state: RootState) => `${state.auth.ownerAccountKey}:${state.auth.accountGeneration}`);

  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [exploreTab, setExploreTab] = useState<HomeShowcaseExploreTabId>(HOME_SHOWCASE_EXPLORE_RECOMMENDED_ID);
  const [browseAllOpen, setBrowseAllOpen] = useState(false);
  const [pptBrowseAllTrigger, setPptBrowseAllTrigger] = useState(0);
  const [modalTab, setModalTab] = useState<'all' | BuiltinShowcaseCategoryId>('all');
  const [selectedExample, setSelectedExample] = useState<HomeShowcaseExample | null>(null);
  const [selectedImage, setSelectedImage] = useState<ImageCreationExample | null>(null);

  const mountedRef = useRef(true);
  const preparationRef = useRef(0);

  const hasImageCatalog = Boolean(imageCatalog?.enabled || (!imageCatalog && !imageFailed));
  const activeEntry: HomeShowcasePrimaryEntryId | null = useMemo(() => {
    if (!selectedCategoryId) return null;
    if (HOME_SHOWCASE_PRIMARY_ORDER.includes(selectedCategoryId as HomeShowcasePrimaryEntryId)) {
      return selectedCategoryId as HomeShowcasePrimaryEntryId;
    }
    return null;
  }, [selectedCategoryId]);

  const exploreTabs = useMemo(
    () => HOME_SHOWCASE_EXPLORE_TAB_ORDER.filter(tab => (
      tab !== HomeShowcaseCategoryId.ImageCreation || hasImageCatalog
    )),
    [hasImageCatalog],
  );

  useEffect(() => {
    mountedRef.current = true;
    const reset = () => {
      preparationRef.current += 1;
      setSelectedExample(null);
      setSelectedImage(null);
      setBrowseAllOpen(false);
      setActiveFilter('all');
      setExploreTab(HOME_SHOWCASE_EXPLORE_RECOMMENDED_ID);
    };
    const onFocusInput = (event: Event) => {
      if ((event as CustomEvent<{ clear?: boolean }>).detail?.clear) reset();
    };
    window.addEventListener(CoworkUiEvent.ShortcutNewSession, reset);
    window.addEventListener(CoworkUiEvent.FocusInput, onFocusInput);
    return () => {
      mountedRef.current = false;
      window.removeEventListener(CoworkUiEvent.ShortcutNewSession, reset);
      window.removeEventListener(CoworkUiEvent.FocusInput, onFocusInput);
    };
  }, []);

  useEffect(() => {
    preparationRef.current += 1;
    setSelectedExample(null);
    setSelectedImage(null);
    setBrowseAllOpen(false);
    setActiveFilter('all');
  }, [owner]);

  useEffect(() => {
    setActiveFilter('all');
  }, [activeEntry]);

  useEffect(() => {
    if (!imageCatalog?.enabled) {
      setSelectedImage(null);
    } else if (selectedImage && !imageCatalog.examples.some(item => item.id === selectedImage.id)) {
      setSelectedImage(null);
    }
  }, [imageCatalog, selectedImage]);

  const handleCardClick = (entryId: HomeShowcasePrimaryEntryId) => {
    if (activeEntry === entryId) {
      onCategorySelect(null);
      return;
    }
    onCategorySelect(entryId);
  };

  const handleOpenBrowseAll = (initialCategory?: BuiltinShowcaseCategoryId | 'all') => {
    setModalTab(initialCategory ?? 'all');
    setBrowseAllOpen(true);
  };

  const handleApplyShowcase = async (
    example: HomeShowcaseExample,
    options: ShowcaseRemixOptions,
  ): Promise<boolean> => {
    const request = ++preparationRef.current;
    const result = await prepareHomeShowcaseDraft(
      example,
      options,
      () => mountedRef.current && preparationRef.current === request,
    );
    if (!result) return false;
    setBrowseAllOpen(false);
    onCategorySelect(null);
    onDraftReady(result.prompt);
    reportPromptTemplateAction({
      templateActionType: 'template_prompt_click',
      templateId: example.categoryId,
      templateName: t(CATEGORY_TITLE_KEYS[example.categoryId]),
      mappedSkillId: example.skillId,
      promptId: example.id,
      promptName: example.title[language],
      promptLength: result.prompt.length,
      params: {
        remixMode: options.mode,
        hasUserFiles: options.userFiles.length > 0,
      },
    });
    return true;
  };

  const handleApplyImageExample = async (
    prompt: string,
    reference?: ImageExampleReference,
  ): Promise<boolean> => {
    if (!imageCatalog?.enabled) return false;
    const request = ++preparationRef.current;
    const previous = await prepareImageCreationDraft(
      imageCatalog.expertPresetId,
      prompt,
      reference,
      () => mountedRef.current && preparationRef.current === request,
    );
    if (!previous) return false;
    onCategorySelect(null);
    onDraftReady(prompt);
    return true;
  };

  const activeDirectBuiltinCategory: BuiltinShowcaseCategoryId | null = (
    activeEntry
    && activeEntry !== HOME_SHOWCASE_EXPLORE_MORE_ID
    && activeEntry !== HomeShowcaseCategoryId.ImageCreation
    && isBuiltinShowcaseCategory(activeEntry)
  ) ? activeEntry : null;

  const isDirectImageCreation = activeEntry === HomeShowcaseCategoryId.ImageCreation;
  const isExploreMore = activeEntry === HOME_SHOWCASE_EXPLORE_MORE_ID;
  const useRemotePptInExplore = (
    isExploreMore
    && exploreTab === HomeShowcaseCategoryId.Pptx
    && Boolean(remotePptCatalog?.enabled)
  );
  const isExploreImageTab = isExploreMore && exploreTab === HomeShowcaseCategoryId.ImageCreation;

  const handleOpenImagePlaza = () => {
    if (!imageCatalog?.enabled) return;
    window.dispatchEvent(
      new CustomEvent(ExpertUiEvent.OpenPlaza, { detail: { presetId: imageCatalog.expertPresetId } }),
    );
  };

  const handleExploreBrowseAll = () => {
    if (useRemotePptInExplore) {
      setPptBrowseAllTrigger(count => count + 1);
      return;
    }
    if (isExploreImageTab) {
      handleOpenImagePlaza();
      return;
    }
    handleOpenBrowseAll(isBuiltinShowcaseCategory(exploreTab) ? exploreTab : 'all');
  };

  const directExamples = useMemo(
    () => (activeDirectBuiltinCategory ? getBuiltinShowcaseExamples(activeDirectBuiltinCategory, activeFilter) : []),
    [activeDirectBuiltinCategory, activeFilter],
  );

  const exploreExamples = useMemo(() => {
    if (!isExploreMore || useRemotePptInExplore || isExploreImageTab) {
      return [];
    }
    if (exploreTab === HOME_SHOWCASE_EXPLORE_RECOMMENDED_ID) {
      return getRecommendedShowcaseExamples();
    }
    if (isBuiltinShowcaseCategory(exploreTab)) {
      return getBuiltinShowcaseExamples(exploreTab);
    }
    return [];
  }, [exploreTab, isExploreImageTab, isExploreMore, useRemotePptInExplore]);

  const modalExamples = useMemo(() => {
    if (modalTab === 'all') return getAllBuiltinShowcaseExamples();
    return getBuiltinShowcaseExamples(modalTab);
  }, [modalTab]);

  const renderImageShelfBody = () => {
    if (imageCatalog?.enabled) {
      return <ImageExampleShelf catalog={imageCatalog} onSelect={setSelectedImage} />;
    }
    if (!imageCatalog && !imageFailed) {
      return (
        <div className="[container-type:inline-size]">
          <div
            className="grid grid-cols-4 gap-x-4 gap-y-5 [@container_(max-width:459px)]:grid-cols-2 [@container_(min-width:460px)_and_(max-width:639px)]:grid-cols-3"
            aria-label={t('loading')}
          >
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="aspect-[16/10] animate-pulse rounded-2xl bg-surface-raised" />
            ))}
          </div>
        </div>
      );
    }
    return (
      <p className="mt-3 text-center text-xs text-muted">
        {t('imageCreationLoadFailed')}{' '}
        <button type="button" className="text-primary hover:underline" onClick={() => void retryImageCatalog()}>
          {t('retry')}
        </button>
      </p>
    );
  };

  const renderCoverGrid = (examples: HomeShowcaseExample[], full = false) => (
    <div className="[container-type:inline-size]">
      <div className="grid grid-cols-4 gap-x-4 gap-y-5 [@container_(max-width:459px)]:grid-cols-2 [@container_(min-width:460px)_and_(max-width:639px)]:grid-cols-3">
        {(full ? examples : examples.slice(0, 8)).map((example, index) => (
          <button
            key={example.id}
            type="button"
            data-showcase-example={example.id}
            title={example.title[language]}
            aria-label={`${example.title[language]} · ${t('homeShowcasePreviewAria')}`}
            onClick={() => setSelectedExample(example)}
            className={`group min-w-0 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background ${
              !full && activeFilter === 'all' ? hiddenWhenNarrow(index) : ''
            }`}
          >
            <ShowcaseCardThumbnail example={example} />
            <p className="mt-2 truncate px-0.5 text-xs font-medium leading-5 text-foreground">
              {example.title[language]}
            </p>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="w-full" data-home-showcase-hub={activeEntry ? 'expanded' : 'overview'}>
      {/* Single-row 5 clean Manus-style cards */}
      <div className="[container-type:inline-size] w-full">
        <div
          data-skin-quick-actions="true"
          className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5 [@container_(max-width:559px)]:!grid-cols-3 [@container_(max-width:399px)]:!grid-cols-2"
        >
          {HOME_SHOWCASE_PRIMARY_ORDER.map((entryId) => {
            const meta = PRIMARY_CARDS[entryId];
            const Icon = meta.icon;
            const selected = activeEntry === entryId;
            return (
              <QuickActionChip
                key={entryId}
                selected={selected}
                data-home-category-card={entryId}
                data-image-creation-tab={entryId === HomeShowcaseCategoryId.ImageCreation ? ImageCreation.TabId : undefined}
                onClick={() => handleCardClick(entryId)}
                icon={<Icon className="h-6 w-6" strokeWidth={1.75} />}
                iconAccentClassName={meta.iconAccent}
                label={t(meta.titleKey)}
              />
            );
          })}
        </div>
      </div>

      {/* Direct primary category visual cover gallery (Data Analysis / Deep Research / Website) */}
      {activeDirectBuiltinCategory && (
        <section
          data-home-showcase-gallery={activeDirectBuiltinCategory}
          className="mt-6 w-full animate-fade-in-up pb-4 motion-reduce:animate-none"
          aria-label={t(CATEGORY_TITLE_KEYS[activeDirectBuiltinCategory])}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-hidden" role="group">
              {BUILTIN_SHOWCASE_CATALOGS[activeDirectBuiltinCategory].filters.map((filter) => {
                const selected = activeFilter === filter.id;
                return (
                  <button
                    key={filter.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setActiveFilter(filter.id)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? 'bg-surface-raised text-foreground'
                        : 'text-secondary hover:bg-surface-raised/60 hover:text-foreground'
                    }`}
                  >
                    {filter.label[language]}
                  </button>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-secondary">
              <button
                type="button"
                onClick={() => handleOpenBrowseAll(activeDirectBuiltinCategory)}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                {t('homeExploreBrowseAll')}
                <ArrowRightIcon aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onCategorySelect(null)}
                aria-label={t('coworkQuickActionCollapse')}
                className="inline-flex items-center gap-0.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                {t('coworkQuickActionCollapse')}
                <ChevronUpIcon aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {renderCoverGrid(directExamples)}
        </section>
      )}

      {/* Direct primary Image Creation gallery (same header bar & cover grid layout as all other categories) */}
      {isDirectImageCreation && (
        <section
          id="image-creation-gallery"
          data-home-showcase-gallery={HomeShowcaseCategoryId.ImageCreation}
          className="mt-6 w-full animate-fade-in-up pb-4 motion-reduce:animate-none"
          aria-labelledby="image-creation-heading"
        >
          <h3 id="image-creation-heading" className="sr-only">
            {t('imageCreationHeading')}
          </h3>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-hidden" role="group">
              <button
                type="button"
                aria-pressed="true"
                className="shrink-0 rounded-full bg-surface-raised px-3 py-1.5 text-xs font-medium text-foreground"
              >
                {t('homeShowcaseAllFilter')}
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-secondary">
              {imageCatalog?.enabled && (
                <button
                  type="button"
                  onClick={handleOpenImagePlaza}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-surface-raised hover:text-foreground"
                >
                  {t('homeExploreBrowseAll')}
                  <ArrowRightIcon aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onCategorySelect(null)}
                aria-label={t('coworkQuickActionCollapse')}
                className="inline-flex items-center gap-0.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                {t('coworkQuickActionCollapse')}
                <ChevronUpIcon aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {renderImageShelfBody()}
        </section>
      )}

      {/* Explore More multi-category YouMind/Manus-style discovery shelf (Slides, Docs & all verticals) */}
      {isExploreMore && (
        <section
          data-home-showcase-gallery={HOME_SHOWCASE_EXPLORE_MORE_ID}
          className="mt-6 w-full animate-fade-in-up pb-4 motion-reduce:animate-none"
          aria-label={t('homeCategoryExploreMore')}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-hidden" role="tablist">
              {exploreTabs.map((tabId) => {
                const selected = exploreTab === tabId;
                return (
                  <button
                    key={tabId}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    data-explore-tab={tabId}
                    onClick={() => setExploreTab(tabId)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? 'bg-surface-raised text-foreground'
                        : 'text-secondary hover:bg-surface-raised/60 hover:text-foreground'
                    }`}
                  >
                    {t(EXPLORE_TAB_LABEL_KEYS[tabId])}
                  </button>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-secondary">
              {(!isExploreImageTab || Boolean(imageCatalog?.enabled)) && (
                <button
                  type="button"
                  onClick={handleExploreBrowseAll}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-surface-raised hover:text-foreground"
                >
                  {t('homeExploreBrowseAll')}
                  <ArrowRightIcon aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onCategorySelect(null)}
                aria-label={t('coworkQuickActionCollapse')}
                className="inline-flex items-center gap-0.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                {t('coworkQuickActionCollapse')}
                <ChevronUpIcon aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <HomePptCreation
            active={useRemotePptInExplore}
            embedded
            browseAllTrigger={pptBrowseAllTrigger}
            onClose={() => onCategorySelect(null)}
            onDraftReady={(prompt) => {
              onCategorySelect(null);
              onDraftReady(prompt);
            }}
          >
            {null}
          </HomePptCreation>

          {isExploreImageTab && renderImageShelfBody()}

          {!useRemotePptInExplore && !isExploreImageTab && renderCoverGrid(exploreExamples)}
        </section>
      )}

      {/* Full "Explore More Possibilities" browse-all modal */}
      {browseAllOpen && (
        <Modal
          onClose={() => setBrowseAllOpen(false)}
          onEscape={() => setBrowseAllOpen(false)}
          overlayClassName={selectedExample ? 'hidden' : undefined}
          className="non-draggable w-[min(1040px,94vw)] overflow-hidden rounded-3xl border border-border bg-surface shadow-modal"
        >
          <div role="dialog" aria-modal="true" aria-labelledby="explore-more-modal-title" className="flex max-h-[88vh] flex-col">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
              <div>
                <h2 id="explore-more-modal-title" className="text-lg font-semibold text-foreground">
                  {t('homeExploreModalTitle')}
                </h2>
                <p className="mt-0.5 text-xs text-secondary">{t('homeExploreModalHint')}</p>
              </div>
              <button
                type="button"
                onClick={() => setBrowseAllOpen(false)}
                aria-label={t('close')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                <XMarkIcon aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 px-6 py-2.5 scrollbar-hidden">
              {([
                'all',
                HomeShowcaseCategoryId.Pptx,
                HomeShowcaseCategoryId.DocWriting,
                HomeShowcaseCategoryId.DataAnalysis,
                HomeShowcaseCategoryId.DeepResearch,
                HomeShowcaseCategoryId.Website,
              ] as const).map((tab) => {
                const selected = modalTab === tab;
                const label = tab === 'all'
                  ? t('homeShowcaseAllFilter')
                  : t(EXPLORE_TAB_LABEL_KEYS[tab]);
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setModalTab(tab)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? 'bg-surface-raised text-foreground'
                        : 'text-secondary hover:bg-surface-raised/60 hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-6 scrollbar-hidden">
              {renderCoverGrid(modalExamples, true)}
            </div>
          </div>
        </Modal>
      )}

      {selectedExample && (
        <RemixExampleDialog
          key={selectedExample.id}
          example={selectedExample}
          onClose={() => {
            preparationRef.current += 1;
            setSelectedExample(null);
          }}
          onApply={handleApplyShowcase}
        />
      )}

      {selectedImage && (
        <ImageExampleDialog
          key={selectedImage.id}
          example={selectedImage}
          onClose={() => {
            preparationRef.current += 1;
            setSelectedImage(null);
          }}
          onUse={handleApplyImageExample}
        />
      )}
    </div>
  );
};

export default HomeShowcaseHub;
