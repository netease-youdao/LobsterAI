import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import type { ExpertScenario, PresetAgent } from '@shared/agent/presets';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import { MANAGEMENT_PAGE_TITLE_TEXT, MANAGEMENT_TITLE_TEXT } from '../common/managementTypography';
import { EXPERT_SCENARIO_STYLES, expertText } from './catalog';
import { SCENARIO_PRESENTATION } from './scenarioPresentation';

const HIDDEN_FEATURED_SCENARIO_IDS = new Set(['campus', 'business', 'career']);

const ExpertFeaturedScenarios: React.FC<{ presets: PresetAgent[]; scenarios: ExpertScenario[]; onSelect: (preset: PresetAgent, scenarioId: string) => void }> = ({ presets, scenarios, onSelect }) => {
  const featuredScenarios = useMemo(() => scenarios.filter(scenario => !HIDDEN_FEATURED_SCENARIO_IDS.has(scenario.id)), [scenarios]);
  const railRef = useRef<HTMLDivElement>(null);
  const [canBack, setCanBack] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage();

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const update = () => {
      setCanBack(rail.scrollLeft > 2);
      setCanNext(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2);
    };
    update();
    rail.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    return () => { rail.removeEventListener('scroll', update); observer.disconnect(); };
  }, [featuredScenarios, presets, language]);

  if (!featuredScenarios.length) return null;

  return <section aria-label={t('expertFeatured')} className="relative">
    <div ref={railRef} role="group" tabIndex={0} aria-label={t('expertFeatured')} className="scrollbar-hidden grid snap-x snap-proximity auto-cols-[max(min(260px,100%),calc((100%_-_72px)/3))] grid-flow-col gap-4 overflow-x-auto overscroll-x-contain scroll-px-12 rounded-[20px] pb-1 pr-12 outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
      {featuredScenarios.map(scenario => {
        const presentation = SCENARIO_PRESENTATION[scenario.id];
        return <div key={scenario.id} className="relative isolate snap-start overflow-hidden rounded-[20px] border border-border bg-surface p-5">
          <div aria-hidden="true" className={`pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b ${EXPERT_SCENARIO_STYLES[scenario.accent]}`} />
          {presentation?.artwork && <img src={presentation.artwork} alt="" draggable={false} className="pointer-events-none absolute -right-1 -top-3 h-28 w-28 select-none object-contain opacity-80 dark:opacity-60" />}
          <div className="relative flex min-h-16 items-start pt-2">
            <h2 title={expertText(scenario.title, language)} className={`${presentation?.artwork ? 'max-w-[calc(100%-5rem)]' : ''} ${MANAGEMENT_PAGE_TITLE_TEXT} font-semibold leading-6 text-foreground`}>{presentation ? t(presentation.titleKey) : expertText(scenario.title, language)}</h2>
          </div>
          <div className="relative mt-2">{scenario.expertIds.map(id => presets.find(preset => preset.id === id)).filter((preset): preset is PresetAgent => Boolean(preset)).map(preset => {
            const name = language === 'en' ? preset.nameEn : preset.name;
            return <button data-expert-id={preset.id} data-expert-scenario={scenario.id} key={preset.id} type="button" onClick={() => onSelect(preset, scenario.id)}
              onFocus={event => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })}
              className="group -mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-2 rounded-xl px-2 py-2 text-left text-foreground transition-colors hover:bg-surface/70 focus-visible:bg-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50">
              <AgentAvatarIcon value={preset.icon} expertFallback className="h-6 w-6" />
              <span title={name} className={`min-w-0 flex-1 truncate ${MANAGEMENT_TITLE_TEXT} leading-6`}>{name}</span>
              <ChevronRightIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted opacity-50 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>;
          })}</div>
        </div>;
      })}
    </div>
    {canBack && <div className="pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center bg-gradient-to-r from-background via-background to-transparent">
      <button type="button" aria-label={t('expertPreviousScenarios')}
        onClick={() => railRef.current?.scrollBy({ left: -railRef.current.clientWidth * 0.8, behavior: 'smooth' })}
        className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background text-secondary shadow-sm transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
        <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>}
    {canNext && <div className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-background via-background to-transparent">
      <button type="button" aria-label={t('expertNextScenarios')}
        onClick={() => railRef.current?.scrollBy({ left: railRef.current.clientWidth * 0.8, behavior: 'smooth' })}
        className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background text-secondary shadow-sm transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
        <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>}
  </section>;
};

export default ExpertFeaturedScenarios;
