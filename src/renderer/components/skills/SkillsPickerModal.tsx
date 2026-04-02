import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import SearchIcon from '../icons/SearchIcon';
import PuzzleIcon from '../icons/PuzzleIcon';
import Cog6ToothIcon from '../icons/Cog6ToothIcon';
import XMarkIcon from '../icons/XMarkIcon';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { toggleActiveSkill } from '../../store/slices/skillSlice';
import { Skill } from '../../types/skill';

type TabId = 'official' | 'thirdParty';

interface SkillsPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onManageSkills: () => void;
}

const SkillsPickerModal: React.FC<SkillsPickerModalProps> = ({
  isOpen,
  onClose,
  onManageSkills,
}) => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);

  const [activeTab, setActiveTab] = useState<TabId>('official');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  // Filter enabled skills by tab and search
  const filteredSkills = skills
    .filter(s => s.enabled)
    .filter(s => (activeTab === 'official' ? s.isOfficial : !s.isOfficial))
    .filter(s =>
      !searchQuery ||
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skillService.getLocalizedSkillDescription(s.id, s.name, s.description).toLowerCase().includes(searchQuery.toLowerCase())
    );

  const selectedSkill = filteredSkills.find(s => s.id === selectedSkillId) ?? null;

  // Auto-select first skill when list changes
  useEffect(() => {
    if (filteredSkills.length > 0 && !filteredSkills.find(s => s.id === selectedSkillId)) {
      setSelectedSkillId(filteredSkills[0].id);
    } else if (filteredSkills.length === 0) {
      setSelectedSkillId(null);
    }
  }, [filteredSkills, selectedSkillId]);

  // Reset state when modal opens; select first non-empty tab
  useEffect(() => {
    if (isOpen) {
      triggerRef.current = document.activeElement;
      const officialEnabled = skills.some(s => s.enabled && s.isOfficial);
      const thirdPartyEnabled = skills.some(s => s.enabled && !s.isOfficial);
      setActiveTab(officialEnabled ? 'official' : thirdPartyEnabled ? 'thirdParty' : 'official');
      setSearchQuery('');
      setSelectedSkillId(null);
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else {
      (triggerRef.current as HTMLElement)?.focus();
    }
  }, [isOpen, skills]);

  // ESC to close + focus trap
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusableSelector = [
          'a[href]',
          'button:not([disabled])',
          'input:not([disabled])',
          'select:not([disabled])',
          'textarea:not([disabled])',
          '[tabindex]:not([tabindex="-1"])',
        ].join(', ');
        const focusable = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>(focusableSelector)
        ).filter(el => !el.closest('[hidden]'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const handleToggleActive = useCallback((skillId: string) => {
    dispatch(toggleActiveSkill(skillId));
  }, [dispatch]);

  const handleManageSkills = useCallback(() => {
    onManageSkills();
    onClose();
  }, [onManageSkills, onClose]);

  if (!isOpen) return null;

  const isActive = (skillId: string) => activeSkillIds.includes(skillId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skills-picker-title"
        className="w-[680px] h-[480px] flex flex-col rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: Tabs + Search + Close */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center gap-2">
            <TabButton
              label={i18nService.t('officialSkills')}
              isActive={activeTab === 'official'}
              onClick={() => setActiveTab('official')}
            />
            <TabButton
              label={i18nService.t('thirdPartySkills')}
              isActive={activeTab === 'thirdParty'}
              onClick={() => setActiveTab('thirdParty')}
            />
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder={i18nService.t('searchSkills')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-44 pl-8 pr-3 py-1.5 text-sm rounded-lg dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-1 focus:ring-claude-accent"
              />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content: Left list + Right detail */}
        <div className="flex-1 flex min-h-0">
          {/* Left: Skill list */}
          <div className="w-[280px] border-r dark:border-claude-darkBorder border-claude-border overflow-y-auto">
            {filteredSkills.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('noSkillsAvailable')}
              </div>
            ) : (
              filteredSkills.map((skill) => (
                <SkillListItem
                  key={skill.id}
                  skill={skill}
                  isSelected={selectedSkillId === skill.id}
                  isActive={isActive(skill.id)}
                  onClick={() => setSelectedSkillId(skill.id)}
                />
              ))
            )}
          </div>

          {/* Right: Detail panel */}
          <div className="flex-1 overflow-y-auto p-5">
            {selectedSkill ? (
              <SkillDetailPanel
                skill={selectedSkill}
                isActive={isActive(selectedSkill.id)}
                onToggleActive={() => handleToggleActive(selectedSkill.id)}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('noSkillsAvailable')}
              </div>
            )}
          </div>
        </div>

        {/* Footer: Manage Skills */}
        <div className="border-t dark:border-claude-darkBorder border-claude-border">
          <button
            onClick={handleManageSkills}
            className="w-full flex items-center justify-between px-5 py-3 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors rounded-b-2xl"
          >
            <span>{i18nService.t('manageSkills')}</span>
            <Cog6ToothIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          </button>
        </div>
      </div>
    </div>
  );
};

/* ─── Sub-components ─── */

const TabButton: React.FC<{ label: string; isActive: boolean; onClick: () => void }> = ({
  label,
  isActive,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
      isActive
        ? 'text-claude-accent bg-claude-accent/10'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:bg-claude-darkBg bg-claude-bg'
    }`}
  >
    {label}
  </button>
);

const SkillListItem: React.FC<{
  skill: Skill;
  isSelected: boolean;
  isActive: boolean;
  onClick: () => void;
}> = ({ skill, isSelected, isActive, onClick }) => {
  const description = skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
        isSelected
          ? 'dark:bg-claude-accent/10 bg-claude-accent/5'
          : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
      }`}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
        isSelected
          ? 'bg-claude-accent/20'
          : 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
      }`}>
        <PuzzleIcon className={`h-4 w-4 ${
          isSelected ? 'text-claude-accent' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
        }`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate dark:text-claude-darkText text-claude-text">
          {skill.name}
        </div>
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate mt-0.5">
          {description}
        </div>
      </div>
      {/* Status label + dot */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className={`text-xs ${isActive ? 'text-green-500' : 'dark:text-gray-500 text-gray-400'}`}>
          {isActive ? i18nService.t('skillEnabled') : i18nService.t('skillDisabled')}
        </span>
        <div className={`w-2 h-2 rounded-full ${
          isActive ? 'bg-green-500' : 'dark:bg-gray-600 bg-gray-300'
        }`} />
      </div>
    </button>
  );
};

const SkillDetailPanel: React.FC<{
  skill: Skill;
  isActive: boolean;
  onToggleActive: () => void;
}> = ({ skill, isActive, onToggleActive }) => {
  const description = skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description);
  return (
    <div>
      {/* Title + Switch */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
          {skill.name}
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={isActive}
          onClick={onToggleActive}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            isActive ? 'bg-claude-accent' : 'dark:bg-gray-600 bg-gray-300'
          }`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            isActive ? 'translate-x-6' : 'translate-x-1'
          }`} />
        </button>
      </div>

      <hr className="dark:border-claude-darkBorder border-claude-border mb-4" />

      {/* Description */}
      <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed whitespace-pre-line">
        {description}
      </p>

    </div>
  );
};

export default SkillsPickerModal;