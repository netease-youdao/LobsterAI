import React, { useMemo, useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import SkillListItem from './SkillListItem';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { Skill } from '../../types/skill';

interface SlashSkillsPopoverProps {
  /** Whether the popover is visible */
  isOpen: boolean;
  /** Text after the "/" used to filter skills */
  searchQuery: string;
  /** Index of the currently keyboard-highlighted item (-1 = none) */
  highlightedIndex: number;
  /** Called when user selects a skill (click or Enter) */
  onSelectSkill: (skill: Skill) => void;
  /** Called when the popover should close (e.g. Escape, click outside) */
  onClose: () => void;
}

const SlashSkillsPopover: React.FC<SlashSkillsPopoverProps> = ({
  isOpen,
  searchQuery,
  highlightedIndex,
  onSelectSkill,
  onClose,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);

  // Filter enabled skills based on search query
  const filteredSkills = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return skills
      .filter(s => s.enabled)
      .filter(s =>
        !query ||
        s.name.toLowerCase().includes(query) ||
        skillService.getLocalizedSkillDescription(s.id, s.name, s.description).toLowerCase().includes(query)
      );
  }, [skills, searchQuery]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!isOpen || highlightedIndex < 0) return;
    const container = popoverRef.current?.querySelector('[data-skill-list]');
    if (!container) return;
    const items = container.querySelectorAll('[data-skill-item]');
    const target = items[highlightedIndex] as HTMLElement | undefined;
    target?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, highlightedIndex]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl z-50"
    >
      {/* Header hint */}
      <div className="px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border">
        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('slashSkillHint')}
        </span>
      </div>

      {/* Skills list */}
      <div data-skill-list className="overflow-y-auto py-1" style={{ maxHeight: '256px' }}>
        {filteredSkills.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('noSkillsAvailable')}
          </div>
        ) : (
          filteredSkills.map((skill, index) => (
            <div key={skill.id} data-skill-item>
              <SkillListItem
                skill={skill}
                isActive={activeSkillIds.includes(skill.id)}
                isHighlighted={index === highlightedIndex}
                onClick={onSelectSkill}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/** Return the filtered skills list so the parent can map highlightedIndex → Skill */
export function useSlashFilteredSkills(searchQuery: string, skills: Skill[]): Skill[] {
  return useMemo(() => {
    const query = searchQuery.toLowerCase();
    return skills
      .filter(s => s.enabled)
      .filter(s =>
        !query ||
        s.name.toLowerCase().includes(query) ||
        skillService.getLocalizedSkillDescription(s.id, s.name, s.description).toLowerCase().includes(query)
      );
  }, [skills, searchQuery]);
}

export default SlashSkillsPopover;
