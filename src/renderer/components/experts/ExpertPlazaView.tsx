import { ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { ExpertCatalog, PresetAgent } from '@shared/agent/presets';
import { UsageEntry, usageFailureCode,UsageOutcome, UsageStage } from '@shared/analytics/usage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { agentService } from '../../services/agent';
import { i18nService } from '../../services/i18n';
import { beginLatestAsyncRequest, invalidateLatestAsyncRequest, isLatestAsyncRequest } from '../../services/latestAsyncRequest';
import { prepareExpertAnalytics, reportExpertJourney } from '../../services/usageAnalytics';
import type { Agent } from '../../types/agent';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import { MANAGEMENT_META_TEXT, MANAGEMENT_PAGE_TITLE_TEXT } from '../common/managementTypography';
import Modal from '../common/Modal';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import { expertText, filterExperts } from './catalog';
import ExpertFeaturedScenarios from './ExpertFeaturedScenarios';
import { useExpertImpressions } from './useExpertImpressions';

interface ExpertPlazaViewProps {
  onSummon: (agent: Agent, prompt: string) => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const ExpertPlazaView: React.FC<ExpertPlazaViewProps> = ({ onSummon, isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const [catalog, setCatalog] = useState<ExpertCatalog | null>(null);
  const presets = useMemo(() => catalog?.experts ?? [], [catalog]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [detail, setDetail] = useState<PresetAgent | null>(null);
  const [summoning, setSummoning] = useState<string | null>(null);
  const [summonFailed, setSummonFailed] = useState(false);
  const mountedRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const categoryRailRef = useRef<HTMLDivElement>(null);
  const [canScrollCategoriesBack, setCanScrollCategoriesBack] = useState(false);
  const [canScrollCategoriesNext, setCanScrollCategoriesNext] = useState(false);
  const [journeyId] = useState(() => crypto.randomUUID());
  const viewedRef = useRef(false);
  const detailEntry = useRef<UsageEntry>(UsageEntry.Plaza);
  useExpertImpressions(rootRef, journeyId, catalog?.version, [catalog, query, category, tag].join(':'));
  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    reportExpertJourney(UsageStage.View, { journeyId, entry: UsageEntry.Plaza });
  }, [journeyId]);
  const summoningRef = useRef(false);
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage();
  const categoryName = (id: string) => {
    const definition = catalog?.categories.find(category => category.id === id);
    return definition ? expertText(definition.label, language) : '';
  };
  const name = (preset: PresetAgent) => language === 'en' ? preset.nameEn : preset.name;
  const description = (preset: PresetAgent) => language === 'en' ? preset.descriptionEn : preset.description;
  const filtered = useMemo(() => filterExperts(presets, query, category, tag), [presets, query, category, tag]);
  const selectedTag = presets.flatMap(preset => preset.tags).find(item => item.zh === tag);

  const load = useCallback(async () => {
    const requestId = beginLatestAsyncRequest(loadRequestIdRef);
    setLoading(true);
    setLoadFailed(false);
    const startedAt = Date.now();
    try {
      const result = await window.electron.agents.expertCatalog();
      if (!isLatestAsyncRequest(loadRequestIdRef, requestId)) return;
      await agentService.loadAgents();
      if (!isLatestAsyncRequest(loadRequestIdRef, requestId)) return;
      if (mountedRef.current) setCatalog(result);
      reportExpertJourney(UsageStage.Load, { journeyId, outcome: UsageOutcome.Succeeded,
        catalogVersion: result.version, count: result.experts.length, durationMs: Date.now() - startedAt });
    } catch (error) {
      if (!isLatestAsyncRequest(loadRequestIdRef, requestId)) return;
      reportExpertJourney(UsageStage.Load, { journeyId, outcome: UsageOutcome.Failed,
        failureCode: usageFailureCode(error), durationMs: Date.now() - startedAt });
      console.error('[ExpertPlaza] Failed to load experts:', error);
      if (mountedRef.current) setLoadFailed(true);
    } finally {
      if (mountedRef.current && isLatestAsyncRequest(loadRequestIdRef, requestId)) setLoading(false);
    }
  }, [journeyId]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      invalidateLatestAsyncRequest(loadRequestIdRef);
    };
  }, [load]);

  useEffect(() => {
    const rail = categoryRailRef.current;
    if (!rail) return;
    const update = () => {
      setCanScrollCategoriesBack(rail.scrollLeft > 2);
      setCanScrollCategoriesNext(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2);
    };
    update();
    rail.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    return () => {
      rail.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [catalog, language, loading, loadFailed, selectedTag]);

  useEffect(() => {
    if (loading || loadFailed) return;
    const timer = window.setTimeout(() => reportExpertJourney(UsageStage.Filter, {
      journeyId, catalogVersion: catalog?.version, queryLength: query.trim().length,
      categoryId: category ?? undefined, hasTag: Boolean(tag), resultCount: filtered.length,
    }), 600);
    return () => window.clearTimeout(timer);
  }, [query, category, tag, filtered.length, loading, loadFailed, catalog?.version, journeyId]);

  const showDetail = (preset: PresetAgent, scenarioId?: string) => {
    detailEntry.current = scenarioId ? UsageEntry.Featured : UsageEntry.Plaza;
    reportExpertJourney(UsageStage.Detail, { journeyId, presetId: preset.id, catalogVersion: catalog?.version,
      entry: detailEntry.current, scenarioId });
    setDetail(preset);
  };

  const summon = async (preset: PresetAgent, prompt = expertText(preset.starterPrompts[0], language), starterIndex?: number) => {
    if (summoningRef.current) return;
    summoningRef.current = true;
    setSummoning(preset.id);
    setSummonFailed(false);
    const startedAt = Date.now();
    const entry = starterIndex !== undefined ? UsageEntry.Starter : detail ? UsageEntry.Detail : UsageEntry.Plaza;
    const fields = { journeyId, presetId: preset.id, catalogVersion: catalog?.version, entry,
      starterIndex, wasInstalled: Boolean(preset.installed) };
    reportExpertJourney(UsageStage.Summon, { ...fields, outcome: UsageOutcome.Started });
    try {
      const agent = await agentService.addPreset(preset.id);
      if (!agent) throw new Error('Expert preparation failed');
      reportExpertJourney(UsageStage.Summon, { ...fields, outcome: UsageOutcome.Succeeded, durationMs: Date.now() - startedAt });
      if (mountedRef.current) {
        onSummon(agent, prompt);
        prepareExpertAnalytics(agent.id, agent.presetId, { journeyId, catalogVersion: catalog?.version, entry });
      }
    } catch (error) {
      reportExpertJourney(UsageStage.Summon, { ...fields, outcome: UsageOutcome.Failed,
        failureCode: usageFailureCode(error), durationMs: Date.now() - startedAt });
      console.error('[ExpertPlaza] Failed to summon expert:', error);
      if (mountedRef.current) setSummonFailed(true);
    } finally {
      summoningRef.current = false;
      if (mountedRef.current) setSummoning(null);
    }
  };

  const summonButton = (preset: PresetAgent, large = false) => (
    <button type="button" disabled={summoning !== null} onClick={() => void summon(preset)}
      aria-label={`${t('expertSummon')} ${name(preset)}`}
      className={`pointer-events-auto relative z-10 inline-flex shrink-0 items-center justify-center rounded-lg bg-neutral-900 font-semibold text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50 ${large
        ? 'px-5 py-2.5 text-sm'
        : `h-7 px-3 ${MANAGEMENT_META_TEXT} ${summoning === preset.id ? '' : 'invisible group-hover:visible group-focus-within:visible'}`}`}>
      {summoning === preset.id ? t('expertSummoning') : t('expertSummon')}
    </button>
  );

  const closeDetail = () => setDetail(null);
  const errorNotice = summonFailed && <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">{t('expertSummonFailed')}</p>;

  return (
    <div ref={rootRef} data-skin-management-page="true" className="relative z-10 flex h-full min-w-0 flex-1 flex-col bg-background">
      <div className="draggable flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        {isSidebarCollapsed && window.electron.platform !== 'win32' && (
          <div className={`non-draggable flex items-center gap-1 ${window.electron.platform === 'darwin' ? 'pl-[68px]' : ''}`}>
            <button type="button" aria-label={t('expertExpandSidebar')} onClick={onToggleSidebar} className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised"><SidebarToggleIcon className="h-4 w-4" isCollapsed /></button>
            <button type="button" aria-label={t('newChat')} onClick={onNewChat} className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised"><ComposeIcon className="h-4 w-4" /></button>
            {updateBadge}
          </div>
        )}
        <h1 className={`${MANAGEMENT_PAGE_TITLE_TEXT} shrink-0 font-semibold text-foreground`}>{t('expertPlaza')}</h1>
        <div className="non-draggable relative ml-auto w-64 max-w-[45%]">
          <MagnifyingGlassIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-2 h-4 w-4 text-muted" />
          <input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('expertSearch')} placeholder={t('expertSearchPlaceholder')}
            className="h-8 w-full rounded-lg border border-border bg-surface pl-9 pr-8 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-primary" />
          {query && <button type="button" aria-label={t('expertClearSearch')} onClick={() => setQuery('')} className="absolute right-1.5 top-1 rounded p-1 text-secondary hover:bg-surface-raised"><XMarkIcon className="h-4 w-4" /></button>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-[1200px] space-y-6 px-6 py-6 lg:px-8">
          {loading ? <p role="status" className="py-20 text-center text-sm text-secondary">{t('loading')}</p> : loadFailed ? (
            <div role="alert" className="space-y-4 py-16 text-center"><p className="text-sm text-secondary">{t('expertLoadFailed')}</p><button type="button" onClick={() => void load()} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-raised">{t('retry')}</button></div>
          ) : <>
            {presets.length > 0 && (
              <ExpertFeaturedScenarios presets={presets} scenarios={catalog?.scenarios ?? []} onSelect={showDetail} />
            )}
            <section aria-label={t('expertAll')} className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <div ref={categoryRailRef} role="group" aria-label={t('expertCategories')}
                    className="scrollbar-hidden flex scroll-px-12 items-center gap-2 overflow-x-auto overscroll-x-contain py-1 pr-12">
                    {[null, ...(catalog?.categories.map(category => category.id) ?? [])].map(item => (
                      <button key={item ?? 'all'} type="button" aria-pressed={category === item} onClick={() => { setCategory(item); setTag(null); }}
                        onFocus={event => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })}
                        className={`h-9 shrink-0 whitespace-nowrap rounded-lg px-3.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 ${category === item ? 'bg-surface-raised font-semibold text-foreground' : 'text-secondary hover:bg-surface-raised hover:text-foreground'}`}>
                        {item ? categoryName(item) : t('expertCategoryAll')}
                      </button>
                    ))}
                  </div>
                  {canScrollCategoriesBack && <div className="absolute inset-y-0 left-0 flex w-12 items-center bg-gradient-to-r from-background via-background to-transparent">
                    <button type="button" aria-label={t('expertPreviousCategories')}
                      onClick={() => categoryRailRef.current?.scrollBy({ left: -categoryRailRef.current.clientWidth * 0.8, behavior: 'smooth' })}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background text-secondary shadow-sm transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
                      <ChevronLeftIcon className="h-4 w-4" />
                    </button>
                  </div>}
                  {canScrollCategoriesNext && <div className="absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-background via-background to-transparent">
                    <button type="button" aria-label={t('expertNextCategories')}
                      onClick={() => categoryRailRef.current?.scrollBy({ left: categoryRailRef.current.clientWidth * 0.8, behavior: 'smooth' })}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background text-secondary shadow-sm transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
                      <ChevronRightIcon className="h-4 w-4" />
                    </button>
                  </div>}
                </div>
                {selectedTag && <button type="button" onClick={() => setTag(null)}
                  className="flex h-9 max-w-[40%] shrink-0 items-center gap-1 rounded-lg border border-primary/30 px-3 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"><span className="truncate">{expertText(selectedTag, language)}</span><XMarkIcon className="h-3 w-3 shrink-0" /><span className="sr-only">{t('expertClearFilters')}</span></button>}
              </div>
              {!detail && errorNotice}
              {filtered.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border py-16 text-center"><MagnifyingGlassIcon className="mx-auto mb-3 h-6 w-6 text-muted" /><p className="text-sm text-secondary">{t('expertEmpty')}</p><button type="button" onClick={() => { setQuery(''); setCategory(null); setTag(null); }} className="mt-3 text-sm text-primary hover:underline">{t('expertClearFilters')}</button></div>
              ) : <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-2 min-[1280px]:grid-cols-3">
                {filtered.map(preset => (
                  <article data-expert-id={preset.id} key={preset.id} className="group relative flex flex-col rounded-2xl border border-border bg-surface p-5 transition-colors hover:bg-surface-raised/70">
                    <button type="button" onClick={() => showDetail(preset)} aria-label={`${name(preset)} · ${t('expertViewExamples')}`} className="absolute inset-0 cursor-pointer rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background" />
                    <div className="pointer-events-none flex items-start gap-3 text-left">
                      <AgentAvatarIcon value={preset.icon} expertFallback className="h-12 w-12" iconClassName="h-7 w-7" />
                      <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold text-foreground">{name(preset)}</span><span className="mt-1 block text-xs text-muted">{categoryName(preset.category)}</span></span>
                      {summonButton(preset)}
                    </div>
                    <p className="pointer-events-none mt-3 text-sm leading-5 text-secondary">{description(preset)}</p>
                    <div className="pointer-events-none mt-2 flex flex-wrap gap-1.5">{preset.tags.map(item => <span key={item.zh} className="rounded-md bg-surface-raised px-2 py-1 text-[11px] text-secondary">{expertText(item, language)}</span>)}</div>
                  </article>
                ))}
              </div>}
            </section>
          </>}
        </div>
      </div>
      {detail && <Modal onClose={closeDetail} onEscape={closeDetail} className="mx-5 flex max-h-[85vh] w-full max-w-[600px] flex-col rounded-2xl border border-border bg-surface shadow-xl">
        <div role="dialog" aria-modal="true" aria-labelledby="expert-detail-title" className="overflow-y-auto p-7">
          <div className="flex items-start gap-4"><AgentAvatarIcon value={detail.icon} expertFallback className="h-16 w-16" iconClassName="h-9 w-9" /><div className="flex-1"><h2 id="expert-detail-title" className="text-xl font-semibold text-foreground">{name(detail)}</h2><p className="mt-1.5 text-xs text-muted">{categoryName(detail.category)}</p></div><button type="button" autoFocus aria-label={t('close')} onClick={closeDetail} className="rounded-lg p-1 text-secondary hover:bg-surface-raised"><XMarkIcon className="h-5 w-5" /></button></div>
          <p className="my-5 text-sm leading-6 text-secondary">{description(detail)}</p>
          <div className="mb-7 flex flex-wrap gap-2">{detail.tags.map(item => <button type="button" key={item.zh} title={t('expertFilterByTag').replace('{tag}', expertText(item, language))} onClick={() => { setTag(item.zh); setCategory(null); closeDetail(); }} className="rounded-md bg-surface-raised px-2.5 py-1 text-xs text-secondary hover:text-primary">{expertText(item, language)}</button>)}</div>
          <h3 className="mb-3 text-sm font-semibold text-foreground">{t('expertExampleHeading')}</h3>
          <div className="space-y-3">{detail.starterPrompts.map((prompt, index) => <button type="button" key={prompt.zh} disabled={summoning !== null} onClick={() => void summon(detail, expertText(prompt, language), index)} className="flex w-full items-center gap-4 rounded-xl border border-border p-4 text-left text-sm leading-6 text-secondary transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-50"><span className="flex-1">{expertText(prompt, language)}</span><ArrowRightIcon className="h-4 w-4 shrink-0 text-muted" /></button>)}</div>
          <div className="mt-5">{errorNotice}</div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5"><p className="max-w-[300px] text-xs leading-5 text-muted">{t('expertDraftHint')}</p>{summonButton(detail, true)}</div>
        </div>
      </Modal>}
    </div>
  );
};

export default ExpertPlazaView;
