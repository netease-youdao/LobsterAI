import { ExpertScenarioAccent, type LocalizedExpertText, type PresetAgent } from '@shared/agent/presets';

// Presentation tokens stay local; content and membership come from the catalog.
export const EXPERT_SCENARIO_STYLES: Record<ExpertScenarioAccent, string> = {
  [ExpertScenarioAccent.Teal]: 'from-teal-500/[0.08] to-emerald-500/[0.02]',
  [ExpertScenarioAccent.Orange]: 'from-orange-500/[0.08] to-amber-500/[0.02]',
  [ExpertScenarioAccent.Indigo]: 'from-indigo-500/[0.08] to-blue-500/[0.02]',
  [ExpertScenarioAccent.Stone]: 'from-stone-500/[0.08] to-amber-500/[0.02]',
  [ExpertScenarioAccent.Amber]: 'from-amber-500/[0.08] to-orange-500/[0.02]',
  [ExpertScenarioAccent.Sky]: 'from-sky-500/[0.08] to-indigo-500/[0.02]',
  [ExpertScenarioAccent.Blue]: 'from-blue-500/[0.08] to-sky-500/[0.02]',
  [ExpertScenarioAccent.Violet]: 'from-violet-500/[0.08] to-fuchsia-500/[0.02]',
  [ExpertScenarioAccent.Emerald]: 'from-emerald-500/[0.08] to-teal-500/[0.02]',
  [ExpertScenarioAccent.Rose]: 'from-rose-500/[0.08] to-orange-500/[0.02]',
  [ExpertScenarioAccent.Cyan]: 'from-cyan-500/[0.08] to-blue-500/[0.02]',
};

export function expertText(value: LocalizedExpertText, language: string): string {
  return language === 'en' ? value.en : value.zh;
}

export function filterExperts(presets: PresetAgent[], query: string, category: string | null, tag: string | null): PresetAgent[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return presets.filter(preset => {
    if (category && preset.category !== category) return false;
    if (tag && !preset.tags.some(item => item.zh === tag)) return false;
    const searchable = [preset.name, preset.nameEn, preset.description, preset.descriptionEn,
      ...preset.tags.flatMap(item => [item.zh, item.en])].join(' ').toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
}
