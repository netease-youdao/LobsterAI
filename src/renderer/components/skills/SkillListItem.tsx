import React from 'react';
import { CheckIcon } from '@heroicons/react/24/outline';
import PuzzleIcon from '../icons/PuzzleIcon';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { Skill } from '../../types/skill';

interface SkillListItemProps {
  skill: Skill;
  isActive: boolean;
  /** Keyboard-highlight state used by slash-command popover */
  isHighlighted?: boolean;
  onClick: (skill: Skill) => void;
}

const SkillListItem: React.FC<SkillListItemProps> = ({
  skill,
  isActive,
  isHighlighted = false,
  onClick,
}) => {
  return (
    <button
      onClick={() => onClick(skill)}
      className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors ${
        isActive
          ? 'dark:bg-claude-accent/10 bg-claude-accent/10'
          : isHighlighted
            ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
            : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
      }`}
    >
      <div className={`mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
        isActive
          ? 'bg-claude-accent text-white'
          : 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
      }`}>
        {isActive ? (
          <CheckIcon className="h-4 w-4" />
        ) : (
          <PuzzleIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium truncate ${
            isActive
              ? 'text-claude-accent'
              : 'dark:text-claude-darkText text-claude-text'
          }`}>
            {skill.name}
          </span>
          {skill.isOfficial && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-claude-accent/10 text-claude-accent flex-shrink-0">
              {i18nService.t('official')}
            </span>
          )}
        </div>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate mt-0.5">
          {skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)}
        </p>
      </div>
    </button>
  );
};

export default SkillListItem;
