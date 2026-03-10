import React, { useState, useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { CheckIcon } from '@heroicons/react/24/outline';
import SearchIcon from '../icons/SearchIcon';
import PuzzleIcon from '../icons/PuzzleIcon';
import Cog6ToothIcon from '../icons/Cog6ToothIcon';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { Skill } from '../../types/skill';

interface SkillsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSkill: (skill: Skill) => void;
  onManageSkills: () => void;
  anchorRef: React.RefObject<HTMLElement>;
}

const SkillsPopover: React.FC<SkillsPopoverProps> = ({
  isOpen,
  onClose,
  onSelectSkill,
  onManageSkills,
  anchorRef,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [maxListHeight, setMaxListHeight] = useState(256); // default max-h-64 = 256px
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);

  // Filter enabled skills based on search query
  const filteredSkills = skills
    .filter(s => s.enabled)
    .filter(s =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skillService.getLocalizedSkillDescription(s.id, s.name, s.description).toLowerCase().includes(searchQuery.toLowerCase())
    );

  // Calculate available height and focus search input when popover opens
  useEffect(() => {
    if (isOpen) {
      // Calculate available space above the anchor
      if (anchorRef.current) {
        const anchorRect = anchorRef.current.getBoundingClientRect();
        // Available height = distance from top of viewport to anchor, minus padding for search bar (~120px) and some margin (~60px)
        const availableHeight = anchorRect.top - 120 - 60;
        // Clamp between 120px (minimum usable) and 256px (default max)
        setMaxListHeight(Math.max(120, Math.min(256, availableHeight)));
      }
      if (searchInputRef.current) {
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    }
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen, anchorRef]);

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsidePopover = popoverRef.current?.contains(target);
      const isInsideAnchor = anchorRef.current?.contains(target);

      if (!isInsidePopover && !isInsideAnchor) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleSelectSkill = (skill: Skill) => {
    onSelectSkill(skill);
    // Don't close popover to allow multi-selection
  };

  const handleManageSkills = () => {
    onManageSkills();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl z-50"
    >
      {/* Search input */}
      <div className="p-3 border-b dark:border-claude-darkBorder border-claude-border">
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={i18nService.t('searchSkills')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
          />
        </div>
      </div>

      {/* Skills list */}
      <div className="overflow-y-auto py-1" style={{ maxHeight: `${maxListHeight}px` }}>
        {filteredSkills.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('noSkillsAvailable')}
          </div>
        ) : (
          filteredSkills.map((skill) => {
            const isActive = activeSkillIds.includes(skill.id);
            return (
              <button
                key={skill.id}
                onClick={() => handleSelectSkill(skill)}
                className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                  isActive
                    ? 'dark:bg-claude-accent/10 bg-claude-accent/10'
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
          })
        )}
      </div>

      {/* Footer - Manage Skills */}
      <div className="border-t dark:border-claude-darkBorder border-claude-border">
        <button
          onClick={handleManageSkills}
          className="w-full flex items-center justify-between px-4 py-3 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors rounded-b-xl"
        >
          <span>{i18nService.t('manageSkills')}</span>
          <Cog6ToothIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        </button>
      </div>
    </div>
  );
};

export default SkillsPopover;
