import { CheckIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import SearchIcon from '../icons/SearchIcon';
import SkillIcon from '../icons/SkillIcon';

interface AgentSkillSelectorProps {
  selectedSkillIds: string[];
  onChange: (skillIds: string[]) => void;
}

const AgentSkillSelector: React.FC<AgentSkillSelectorProps> = ({ selectedSkillIds, onChange }) => {
  const skills = useSelector((state: RootState) => state.skill.skills);
  const [search, setSearch] = useState('');
  const [i18nReady, setI18nReady] = useState(() => skillService.hasLocalizedSkillDescriptions());
  const shouldUseFallbackDescription = i18nReady || i18nService.getLanguage() !== 'zh';

  // Load localized skill descriptions from marketplace API
  useEffect(() => {
    if (skillService.hasLocalizedSkillDescriptions()) {
      setI18nReady(true);
      return;
    }
    skillService.fetchMarketplaceSkills()
      .then(() => setI18nReady(true))
      .catch(() => setI18nReady(true));
  }, []);

  const enabledSkills = useMemo(
    () => skills.filter((s) => s.enabled),
    [skills],
  );

  const filteredSkills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enabledSkills.filter((skill) => {
      if (!q) return true;
      const localizedDescription = shouldUseFallbackDescription
        ? skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)
        : '';
      return skill.name.toLowerCase().includes(q) || localizedDescription.toLowerCase().includes(q);
    });
  }, [enabledSkills, search, shouldUseFallbackDescription]);

  const toggle = (skillId: string) => {
    if (selectedSkillIds.includes(skillId)) {
      onChange(selectedSkillIds.filter((id) => id !== skillId));
    } else {
      onChange([...selectedSkillIds, skillId]);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-center gap-2 text-xs leading-5 text-secondary/60">
        <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-secondary/30 text-secondary/60">
          <span className="text-[10px] font-medium leading-none">i</span>
        </div>
        <span>{i18nService.t('agentSkillsHint')}</span>
      </div>

      <div className="mb-3 shrink-0">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary/45" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={i18nService.t('agentSkillsSearch')}
            className="h-9 w-full rounded-md border border-border-subtle bg-surface-raised/30 pl-9 pr-3 text-xs text-foreground placeholder:text-secondary/45 focus:border-border focus:bg-surface focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {filteredSkills.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-secondary/60">
            {enabledSkills.length === 0
              ? i18nService.t('agentSkillsNoInstalled')
              : i18nService.t('agentSkillsNoMatches')}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {filteredSkills.map((skill) => {
              const isSelected = selectedSkillIds.includes(skill.id);
              const description = shouldUseFallbackDescription
                ? skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)
                : '';

              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => toggle(skill.id)}
                  className={`group relative flex min-h-[96px] items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors hover:border-foreground/25 hover:bg-surface-raised/50 ${
                    isSelected
                      ? 'border-foreground/35 bg-surface-raised/60'
                      : 'border-border bg-surface'
                  }`}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
                    <SkillIcon className="h-[18px] w-[18px] text-secondary" />
                  </div>
                  <div className="min-w-0 flex-1 pr-8">
                    <div className="truncate text-sm font-medium leading-5 text-foreground">
                      {skill.name}
                    </div>
                    {description && (
                      <div className="mt-1 line-clamp-2 text-xs leading-[18px] text-secondary/80">
                        {description}
                      </div>
                    )}
                  </div>
                  <div
                    className={`absolute right-3.5 top-3.5 flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                      isSelected
                        ? 'border-foreground bg-foreground'
                        : 'border-border bg-surface group-hover:border-foreground/35'
                    }`}
                  >
                    {isSelected && <CheckIcon className="h-3.5 w-3.5 text-background" />}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentSkillSelector;
