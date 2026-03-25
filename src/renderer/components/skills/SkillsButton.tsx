import React, { useState, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import PuzzleIcon from '../icons/PuzzleIcon';
import SkillsPickerModal from './SkillsPickerModal';
import { i18nService } from '../../services/i18n';
import { RootState } from '../../store';
import { toggleActiveSkill, clearActiveSkills } from '../../store/slices/skillSlice';

interface SkillsButtonProps {
  onManageSkills: () => void;
  className?: string;
}

const SkillsButton: React.FC<SkillsButtonProps> = ({
  onManageSkills,
  className = '',
}) => {
  const dispatch = useDispatch();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isHoverOpen, setIsHoverOpen] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);

  const activeSkills = skills.filter(s => s.enabled && activeSkillIds.includes(s.id));
  const activeCount = activeSkills.length;
  const hasActiveSkills = activeCount > 0;

  const handleMouseEnter = useCallback(() => {
    if (isModalOpen) return;
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => setIsHoverOpen(true), 200);
  }, [isModalOpen]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => setIsHoverOpen(false), 150);
  }, []);

  const handleClick = useCallback(() => {
    setIsHoverOpen(false);
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsModalOpen(true);
  }, []);

  const handleManageSkills = useCallback(() => {
    setIsHoverOpen(false);
    setIsModalOpen(false);
    onManageSkills();
  }, [onManageSkills]);

  const handleToggleAll = useCallback(() => {
    if (hasActiveSkills) {
      dispatch(clearActiveSkills());
    }
  }, [dispatch, hasActiveSkills]);

  const handleToggleSkill = useCallback((skillId: string) => {
    dispatch(toggleActiveSkill(skillId));
  }, [dispatch]);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Button with active count badge */}
      <button
        type="button"
        onClick={handleClick}
        className={`relative p-2 rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${className}`}
        title="Skills"
      >
        <PuzzleIcon className="h-5 w-5" />
        {activeCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-claude-accent text-white text-[10px] font-bold leading-none px-1">
            {activeCount}
          </span>
        )}
      </button>

      {/* Hover Popover */}
      {isHoverOpen && !isModalOpen && activeCount > 0 && (
        <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl z-50">
          {/* Header with master switch */}
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('skillsPickerTitle')} ({activeCount})
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={hasActiveSkills}
              onClick={handleToggleAll}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                hasActiveSkills ? 'bg-claude-accent' : 'dark:bg-gray-600 bg-gray-300'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                hasActiveSkills ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`} />
            </button>
          </div>

          {/* Active skills list with checkboxes */}
          <div className="max-h-40 overflow-y-auto px-2 pb-2">
            {activeSkills.map((skill) => (
              <button
                type="button"
                key={skill.id}
                onClick={() => handleToggleSkill(skill.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <div className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border bg-claude-accent border-claude-accent transition-colors">
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <span className="text-sm dark:text-claude-darkText text-claude-text truncate text-left">
                  {skill.name}
                </span>
                <span className="text-xs ml-auto flex-shrink-0 text-green-500">
                  {i18nService.t('skillEnabled')}
                </span>
              </button>
            ))}
          </div>

          {/* Footer */}
          <div className="border-t dark:border-claude-darkBorder border-claude-border">
            <button
              type="button"
              onClick={handleManageSkills}
              className="w-full py-2.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors rounded-b-xl"
            >
              {i18nService.t('manageSkills')}
            </button>
          </div>
        </div>
      )}

      <SkillsPickerModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onManageSkills={handleManageSkills}
      />
    </div>
  );
};

export default SkillsButton;