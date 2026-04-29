import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import XMarkIcon from '../icons/XMarkIcon';
import PuzzleIcon from '../icons/PuzzleIcon';
import { RootState } from '../../store';
import { toggleActiveSkill, clearActiveSkills } from '../../store/slices/skillSlice';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import SkillTooltip from './SkillTooltip';

const ActiveSkillBadge: React.FC = () => {
  const dispatch = useDispatch();
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);

  const activeSkills = activeSkillIds
    .map(id => skills.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  if (activeSkills.length === 0) return null;

  const handleRemoveSkill = (e: React.MouseEvent, skillId: string) => {
    e.stopPropagation();
    dispatch(toggleActiveSkill(skillId));
  };

  const handleClearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(clearActiveSkills());
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {activeSkills.map(skill => (
        <SkillTooltip
          key={skill.id}
          skillName={skill.name}
          description={skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)}
          isOfficial={skill.isOfficial}
          preferredPlacement="top"
          delay={300}
        >
          <div
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-primary-muted border border-primary"
          >
            <PuzzleIcon className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-primary max-w-[80px] truncate">
              {skill.name}
            </span>
            <button
              type="button"
              onClick={(e) => handleRemoveSkill(e, skill.id)}
              className="p-0.5 rounded hover:bg-primary-muted transition-colors"
              title={i18nService.t('clearSkill')}
            >
              <XMarkIcon className="h-2.5 w-2.5 text-primary" />
            </button>
          </div>
        </SkillTooltip>
      ))}
      {activeSkills.length > 1 && (
        <button
          type="button"
          onClick={handleClearAll}
          className="text-xs text-primary hover:text-primary-hover transition-colors"
          title={i18nService.t('clearAllSkills')}
        >
          {i18nService.t('clearAll')}
        </button>
      )}
    </div>
  );
};

export default ActiveSkillBadge;
