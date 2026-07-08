import { CheckIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { Skill } from '../../types/skill';
import Cog6ToothIcon from '../icons/Cog6ToothIcon';
import SearchIcon from '../icons/SearchIcon';
import SkillIcon from '../icons/SkillIcon';

interface SkillsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSkill: (skill: Skill) => void;
  onManageSkills: () => void;
  anchorRef: React.RefObject<HTMLElement>;
  asSubmenu?: boolean;
  autoFocusSearch?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const SkillsPopover: React.FC<SkillsPopoverProps> = ({
  isOpen,
  onClose,
  onSelectSkill,
  onManageSkills,
  anchorRef,
  asSubmenu = false,
  autoFocusSearch = true,
  onMouseEnter,
  onMouseLeave,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [maxListHeight, setMaxListHeight] = useState(256); // default max-h-64 = 256px
  const [i18nReady, setI18nReady] = useState(() => skillService.hasLocalizedSkillDescriptions());
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const shouldUseFallbackDescription = i18nReady || i18nService.getLanguage() !== 'zh';

  // Filter enabled skills based on search query
  const filteredSkills = skills
    .filter(s => s.enabled)
    .filter(s => {
      const query = searchQuery.toLowerCase();
      const description = shouldUseFallbackDescription
        ? skillService.getLocalizedSkillDescription(s.id, s.name, s.description)
        : '';
      return s.name.toLowerCase().includes(query) || description.toLowerCase().includes(query);
    });

  // Load localized skill descriptions from marketplace/localSkill metadata.
  useEffect(() => {
    if (!isOpen) return;
    if (skillService.hasLocalizedSkillDescriptions()) {
      setI18nReady(true);
      return;
    }
    skillService.fetchMarketplaceSkills()
      .then(() => setI18nReady(true))
      .catch(() => setI18nReady(true));
  }, [isOpen]);

  // Calculate available height and focus search input when popover opens
  useEffect(() => {
    if (isOpen) {
      // Calculate available space above the anchor
      if (anchorRef.current) {
        const anchorRect = anchorRef.current.getBoundingClientRect();
        const maxHeight = asSubmenu ? 300 : 256;
        const minHeight = asSubmenu ? 180 : 120;
        const availableHeight = asSubmenu
          ? anchorRect.bottom - 72
          // Available height = distance from top of viewport to anchor, minus padding for search bar (~120px) and some margin (~60px)
          : anchorRect.top - 120 - 60;
        setMaxListHeight(Math.max(minHeight, Math.min(maxHeight, availableHeight)));
      }
      if (autoFocusSearch && searchInputRef.current) {
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    }
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen, anchorRef, asSubmenu, autoFocusSearch]);

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

  const popoverClassName = asSubmenu
    ? 'absolute bottom-0 left-[calc(100%-1px)] z-[60] w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-popover'
    : 'absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-border bg-surface shadow-xl';
  const searchWrapperClassName = asSubmenu
    ? 'px-3 py-2 border-b border-border'
    : 'p-3 border-b border-border';
  const searchInputClassName = asSubmenu
    ? 'w-full pl-8 pr-2 py-1.5 text-[13px] leading-5 rounded-md bg-transparent text-foreground placeholder-secondary focus:outline-none focus:bg-surface-raised/70'
    : 'w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary';
  const listClassName = asSubmenu
    ? 'overflow-y-auto px-2 py-1.5'
    : 'overflow-y-auto py-1';
  const listStyle: React.CSSProperties = asSubmenu
    ? { height: `${maxListHeight}px` }
    : { maxHeight: `${maxListHeight}px` };
  const emptyStateClassName = asSubmenu
    ? 'flex h-[50px] items-center justify-center px-3 text-center text-[13px] leading-5 text-secondary'
    : 'px-4 py-6 text-center text-sm text-secondary';

  return (
    <div
      ref={popoverRef}
      className={popoverClassName}
      role="menu"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Search input */}
      <div className={searchWrapperClassName}>
        <div className="relative">
          <SearchIcon className={`absolute top-1/2 -translate-y-1/2 text-secondary ${
            asSubmenu ? 'left-1.5 h-[18px] w-[18px]' : 'left-3 h-4 w-4'
          }`} />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={i18nService.t('searchSkills')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={searchInputClassName}
          />
        </div>
      </div>

      {/* Skills list */}
      <div className={listClassName} style={listStyle}>
        {filteredSkills.length === 0 ? (
          <div className={emptyStateClassName}>
            {i18nService.t('noSkillsAvailable')}
          </div>
        ) : (
          filteredSkills.map((skill) => {
            const isActive = activeSkillIds.includes(skill.id);
            const description = shouldUseFallbackDescription
              ? skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)
              : '';
            return (
              <button
                key={skill.id}
                onClick={() => handleSelectSkill(skill)}
                className={asSubmenu
                  ? `w-full flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                    isActive ? 'bg-surface-raised' : 'hover:bg-surface-raised'
                  }`
                  : `w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                    isActive ? 'dark:bg-primary/10 bg-primary/10' : 'hover:bg-primary/10 dark:hover:bg-primary/10'
                  }`}
              >
                <div className={asSubmenu
                  ? `mt-[3px] flex h-5 w-5 flex-shrink-0 items-center justify-center ${
                    isActive ? 'text-foreground' : 'text-secondary'
                  }`
                  : `mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    isActive ? 'bg-primary/10 text-primary' : 'bg-surface-raised'
                  }`}
                >
                  <SkillIcon className={asSubmenu ? 'h-[18px] w-[18px]' : `h-4 w-4 ${isActive ? '' : 'text-secondary'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={asSubmenu ? 'flex min-w-0 items-center gap-1.5' : 'flex items-center gap-2'}>
                    <span className={asSubmenu
                      ? 'min-w-0 truncate text-[13px] font-semibold leading-5 text-foreground'
                      : `text-sm font-medium truncate ${
                        isActive ? 'text-primary' : 'text-foreground'
                      }`}
                    >
                      {skill.name}
                    </span>
                    {skill.isOfficial && (
                      <span className={asSubmenu
                        ? 'flex-shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium leading-none text-secondary'
                        : 'px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary/10 text-primary flex-shrink-0'}
                      >
                        {i18nService.t('official')}
                      </span>
                    )}
                  </div>
                  {description && (
                    <p className={asSubmenu ? 'mt-0.5 truncate text-[12px] leading-4 text-secondary' : 'text-xs text-secondary truncate mt-0.5'}>
                      {description}
                    </p>
                  )}
                </div>
                {isActive && (
                  <CheckIcon className={asSubmenu ? 'mt-1 h-3.5 w-3.5 flex-shrink-0 text-primary' : 'mt-1 h-4 w-4 flex-shrink-0 text-primary'} />
                )}
              </button>
            );
          })
        )}
      </div>

      {!asSubmenu && (
        <div className="border-t border-border">
          <button
            onClick={handleManageSkills}
            className="w-full flex items-center justify-between px-4 py-3 text-sm text-foreground hover:bg-surface-raised transition-colors rounded-b-xl"
          >
            <span>{i18nService.t('manageSkills')}</span>
            <Cog6ToothIcon className="h-4 w-4 text-secondary" />
          </button>
        </div>
      )}
    </div>
  );
};

export default SkillsPopover;
