import React, { useState, useMemo, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { CheckIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';

interface AgentSkillSelectorProps {
  selectedSkillIds: string[];
  onChange: (skillIds: string[]) => void;
}

const AgentSkillSelector: React.FC<AgentSkillSelectorProps> = ({ selectedSkillIds, onChange }) => {
  const skills = useSelector((state: RootState) => state.skill.skills);
  const [search, setSearch] = useState('');
  const [i18nReady, setI18nReady] = useState(false);

  // Load localized skill descriptions from marketplace API
  useEffect(() => {
    skillService.fetchMarketplaceSkills()
      .then(() => setI18nReady(true))
      .catch(() => setI18nReady(true));
  }, []);

  const enabledSkills = useMemo(
    () => skills.filter((s) => s.enabled),
    [skills],
  );

  const filteredSkills = useMemo(() => {
    if (!search.trim()) return enabledSkills;
    const q = search.toLowerCase();
    return enabledSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [enabledSkills, search]);

  const toggle = (skillId: string) => {
    if (selectedSkillIds.includes(skillId)) {
      onChange(selectedSkillIds.filter((id) => id !== skillId));
    } else {
      onChange([...selectedSkillIds, skillId]);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <p className="text-xs text-secondary/60 mb-3">
        {i18nService.t('agentSkillsHint') || 'Select skills available to this Agent. Leave empty to use all enabled skills.'}
      </p>
      {enabledSkills.length > 5 && (
        <div className="mb-2">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary/50" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={i18nService.t('agentSkillsSearch') || 'Search skills...'}
              className="w-full pl-8 pr-3 py-1.5 text-sm rounded border border-border bg-transparent text-foreground"
            />
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {filteredSkills.length === 0 ? (
          <div className="px-3 py-3 text-sm text-secondary/50 text-center">
            {enabledSkills.length === 0 ? 'No skills installed' : 'No matching skills'}
          </div>
        ) : (
          filteredSkills.map((skill) => {
            const isSelected = selectedSkillIds.includes(skill.id);
            return (
              <button
                key={skill.id}
                type="button"
                onClick={() => toggle(skill.id)}
                className={`w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-raised transition-colors rounded-lg ${
                  isSelected ? 'bg-primary/5' : ''
                }`}
              >
                <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                  isSelected
                    ? 'bg-primary border-primary'
                    : 'border-border'
                }`}>
                  {isSelected && <CheckIcon className="h-3 w-3 text-white" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground truncate">
                    {skill.name}
                  </div>
                  {skill.description && (
                    <div className="text-xs text-secondary/60 truncate">
                      {i18nReady
                        ? skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)
                        : skill.description}
                    </div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

export default AgentSkillSelector;
