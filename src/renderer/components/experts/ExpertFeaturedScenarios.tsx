import { ArrowLeftIcon, ArrowRightIcon, SparklesIcon } from '@heroicons/react/24/outline';
import type { ExpertScenario, PresetAgent } from '@shared/agent/presets';
import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import { EXPERT_SCENARIO_STYLES, expertText } from './catalog';

const ExpertFeaturedScenarios: React.FC<{ presets: PresetAgent[]; scenarios: ExpertScenario[]; onSelect: (preset: PresetAgent, scenarioId: string) => void }> = ({ presets, scenarios, onSelect }) => {
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
  }, [scenarios]);

  if (!scenarios.length) return null;

  return <section aria-labelledby="expert-featured-title">
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2"><SparklesIcon className="h-4 w-4 text-primary" /><h2 id="expert-featured-title" className="text-sm font-semibold text-foreground">{t('expertFeatured')}</h2></div>
      <div className="flex gap-2">
        <button type="button" aria-label={t('expertPreviousScenarios')} disabled={!canBack} onClick={() => railRef.current?.scrollBy({ left: -railRef.current.clientWidth, behavior: 'smooth' })} className="rounded-full border border-border p-1.5 text-secondary hover:bg-surface-raised disabled:opacity-30"><ArrowLeftIcon className="h-4 w-4" /></button>
        <button type="button" aria-label={t('expertNextScenarios')} disabled={!canNext} onClick={() => railRef.current?.scrollBy({ left: railRef.current.clientWidth, behavior: 'smooth' })} className="rounded-full border border-border p-1.5 text-secondary hover:bg-surface-raised disabled:opacity-30"><ArrowRightIcon className="h-4 w-4" /></button>
      </div>
    </div>
    <div ref={railRef} tabIndex={0} aria-label={t('expertFeatured')} className="scrollbar-hidden grid snap-x snap-mandatory auto-cols-[minmax(250px,calc((100%_-_2rem)/3))] grid-flow-col gap-4 overflow-x-auto overscroll-x-contain pb-2 outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
      {scenarios.map(scenario => <div key={scenario.id} className={`snap-start rounded-2xl border border-border bg-gradient-to-br p-5 ${EXPERT_SCENARIO_STYLES[scenario.accent]}`}>
        <h3 className="font-semibold text-foreground">{expertText(scenario.title, language)}</h3>
        <p className="mb-4 mt-1 min-h-8 text-xs leading-4 text-secondary">{expertText(scenario.description, language)}</p>
        <div className="space-y-1">{scenario.expertIds.map(id => presets.find(preset => preset.id === id)).filter((preset): preset is PresetAgent => Boolean(preset)).map(preset => (
          <button data-expert-id={preset.id} data-expert-scenario={scenario.id} key={preset.id} type="button" onClick={() => onSelect(preset, scenario.id)} className="group flex w-full items-center gap-3 rounded-lg py-2 text-left hover:bg-surface/70">
            <AgentAvatarIcon value={preset.icon} expertFallback className="h-8 w-8" iconClassName="h-5 w-5" />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{language === 'en' ? preset.nameEn : preset.name}</span><ArrowRightIcon className="mr-1 h-3.5 w-3.5 shrink-0 text-muted" />
          </button>
        ))}</div>
      </div>)}
    </div>
  </section>;
};

export default ExpertFeaturedScenarios;
