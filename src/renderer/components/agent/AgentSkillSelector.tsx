import React, { useState, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { CheckIcon, MagnifyingGlassIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';

interface AgentSkillSelectorProps {
  selectedSkillIds: string[];
  onChange: (skillIds: string[]) => void;
  /** 'compact' = collapsible dropdown (default), 'expanded' = always-open list */
  variant?: 'compact' | 'expanded';
}

const AgentSkillSelector: React.FC<AgentSkillSelectorProps> = ({ selectedSkillIds, onChange, variant = 'compact' }) => {
  const skills = useSelector((state: RootState) => state.skill.skills);
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');

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

  const selectedCount = selectedSkillIds.length;
  const isExpanded = variant === 'expanded';
  const showList = isExpanded || expanded;

  /* ── Skill list content (shared between compact & expanded) ── */
  const skillList = (
    <>
      {enabledSkills.length > 5 && (
        <div className={isExpanded ? 'mb-2' : 'px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border'}>
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={i18nService.t('agentSkillsSearch') || 'Search skills...'}
              className="w-full pl-8 pr-3 py-1.5 text-sm rounded border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text"
            />
          </div>
        </div>
      )}
      <div className={isExpanded ? 'flex-1 overflow-y-auto' : 'max-h-48 overflow-y-auto'}>
        {filteredSkills.length === 0 ? (
          <div className="px-3 py-3 text-sm dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50 text-center">
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
                className={`w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors rounded-lg ${
                  isSelected ? 'bg-claude-accent/5 dark:bg-claude-accent/10' : ''
                }`}
              >
                <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                  isSelected
                    ? 'bg-claude-accent border-claude-accent'
                    : 'dark:border-claude-darkBorder border-claude-border'
                }`}>
                  {isSelected && <CheckIcon className="h-3 w-3 text-white" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                    {skill.name}
                  </div>
                  {skill.description && (
                    <div className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 truncate">
                      {skill.description}
                    </div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </>
  );

  /* ── Expanded variant: no collapsible wrapper ── */
  if (isExpanded) {
    return (
      <div className="flex flex-col h-full">
        <p className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mb-3">
          {i18nService.t('agentSkillsHint') || 'Select skills available to this Agent. Leave empty to use all enabled skills.'}
        </p>
        {skillList}
      </div>
    );
  }

  /* ── Compact variant: collapsible dropdown ── */
  return (
    <div>
      <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
        {i18nService.t('agentSkills') || 'Skills'}
      </label>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-sm hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
      >
        <span className={selectedCount > 0 ? '' : 'dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50'}>
          {selectedCount > 0
            ? enabledSkills
                .filter((s) => selectedSkillIds.includes(s.id))
                .map((s) => s.name)
                .join(', ')
            : i18nService.t('agentSkillsNone') || 'Click to select skills'}
        </span>
        {expanded
          ? <ChevronUpIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          : <ChevronDownIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />}
      </button>
      {showList && (
        <div className="mt-1 rounded-lg border dark:border-claude-darkBorder border-claude-border overflow-hidden">
          {skillList}
        </div>
      )}
      <p className="mt-1 text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
        {i18nService.t('agentSkillsHint') || 'Select skills available to this Agent. Leave empty to use all enabled skills.'}
      </p>
    </div>
  );
};

export default AgentSkillSelector;
