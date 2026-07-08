import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { RootState } from '../../store';
import { toggleActiveSkill } from '../../store/slices/skillSlice';
import {
  ACTIVE_CONTEXT_BADGE_BUTTON_CLASS,
  ACTIVE_CONTEXT_BADGE_ICON_CLASS,
  ACTIVE_CONTEXT_BADGE_ICON_WRAP_CLASS,
  ACTIVE_CONTEXT_BADGE_REMOVE_ICON_CLASS,
} from '../common/activeContextBadgeStyles';
import SkillIcon from '../icons/SkillIcon';
import XMarkIcon from '../icons/XMarkIcon';

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

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {activeSkills.map(skill => (
        <button
          type="button"
          key={skill.id}
          onClick={(e) => handleRemoveSkill(e, skill.id)}
          className={ACTIVE_CONTEXT_BADGE_BUTTON_CLASS}
          title={i18nService.t('clearSkill')}
        >
          <span className={ACTIVE_CONTEXT_BADGE_ICON_WRAP_CLASS}>
            <SkillIcon className={ACTIVE_CONTEXT_BADGE_ICON_CLASS} />
            <XMarkIcon className={ACTIVE_CONTEXT_BADGE_REMOVE_ICON_CLASS} />
          </span>
          <span className="min-w-0 truncate">
            {skill.name}
          </span>
        </button>
      ))}
    </div>
  );
};

export default ActiveSkillBadge;
