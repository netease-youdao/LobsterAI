import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowUpTrayIcon,
  FolderOpenIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  PlusCircleIcon,
  PuzzlePieceIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { setSkills } from '../../store/slices/skillSlice';
import { RootState } from '../../store';
import { Skill } from '../../types/skill';
import ErrorMessage from '../ErrorMessage';
import Tooltip from '../ui/Tooltip';

const SkillsManager: React.FC = () => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);

  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [skillDownloadSource, setSkillDownloadSource] = useState('');
  const [skillActionError, setSkillActionError] = useState('');
  const [isDownloadingSkill, setIsDownloadingSkill] = useState(false);
  const [isAddSkillMenuOpen, setIsAddSkillMenuOpen] = useState(false);
  const [isGithubImportOpen, setIsGithubImportOpen] = useState(false);
  const [skillPendingDelete, setSkillPendingDelete] = useState<Skill | null>(null);
  const [isDeletingSkill, setIsDeletingSkill] = useState(false);

  const addSkillMenuRef = useRef<HTMLDivElement>(null);
  const addSkillButtonRef = useRef<HTMLButtonElement>(null);
  const githubImportInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let isActive = true;
    const loadSkills = async () => {
      const loadedSkills = await skillService.loadSkills();
      if (!isActive) return;
      dispatch(setSkills(loadedSkills));
    };
    loadSkills();

    const unsubscribe = skillService.onSkillsChanged(async () => {
      const loadedSkills = await skillService.loadSkills();
      if (!isActive) return;
      dispatch(setSkills(loadedSkills));
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [dispatch]);

  useEffect(() => {
    if (!isAddSkillMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideMenu = addSkillMenuRef.current?.contains(target);
      const isInsideButton = addSkillButtonRef.current?.contains(target);
      if (!isInsideMenu && !isInsideButton) {
        setIsAddSkillMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAddSkillMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isAddSkillMenuOpen]);

  useEffect(() => {
    if (!isGithubImportOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsGithubImportOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    setTimeout(() => githubImportInputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isGithubImportOpen]);

  const filteredSkills = useMemo(() => {
    const query = skillSearchQuery.toLowerCase();
    return skills.filter(skill => {
      const matchesSearch = skill.name.toLowerCase().includes(query)
        || skill.description.toLowerCase().includes(query);
      return matchesSearch;
    });
  }, [skills, skillSearchQuery]);

  const formatSkillDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  };

  const handleToggleSkill = async (skillId: string) => {
    const targetSkill = skills.find(skill => skill.id === skillId);
    if (!targetSkill) return;
    try {
      const updatedSkills = await skillService.setSkillEnabled(skillId, !targetSkill.enabled);
      dispatch(setSkills(updatedSkills));
      setSkillActionError('');
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : i18nService.t('skillUpdateFailed'));
    }
  };

  const handleRequestDeleteSkill = (skill: Skill) => {
    if (skill.isBuiltIn) {
      setSkillActionError(i18nService.t('skillBuiltInCannotDelete'));
      return;
    }
    setSkillActionError('');
    setSkillPendingDelete(skill);
  };

  const handleCancelDeleteSkill = () => {
    if (isDeletingSkill) return;
    setSkillPendingDelete(null);
  };

  const handleConfirmDeleteSkill = async () => {
    if (!skillPendingDelete || isDeletingSkill) return;
    setIsDeletingSkill(true);
    setSkillActionError('');
    const result = await skillService.deleteSkill(skillPendingDelete.id);
    if (!result.success) {
      setSkillActionError(result.error || i18nService.t('skillDeleteFailed'));
      setIsDeletingSkill(false);
      return;
    }
    if (result.skills) {
      dispatch(setSkills(result.skills));
    }
    setIsDeletingSkill(false);
    setSkillPendingDelete(null);
  };

  const handleAddSkillFromSource = async (source: string) => {
    const trimmedSource = source.trim();
    if (!trimmedSource) return;
    setIsDownloadingSkill(true);
    setSkillActionError('');
    const result = await skillService.downloadSkill(trimmedSource);
    setIsDownloadingSkill(false);
    if (!result.success) {
      setSkillActionError(result.error || i18nService.t('skillDownloadFailed'));
      return;
    }
    if (result.skills) {
      dispatch(setSkills(result.skills));
    }
    setSkillDownloadSource('');
    setIsAddSkillMenuOpen(false);
    setIsGithubImportOpen(false);
  };

  const handleUploadSkillZip = async () => {
    if (isDownloadingSkill) return;
    const result = await window.electron.dialog.selectFile({
      title: i18nService.t('uploadSkillZip'),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (result.success && result.path) {
      await handleAddSkillFromSource(result.path);
    }
  };

  const handleUploadSkillFolder = async () => {
    if (isDownloadingSkill) return;
    const result = await window.electron.dialog.selectDirectory();
    if (result.success && result.path) {
      await handleAddSkillFromSource(result.path);
    }
  };

  const handleOpenGithubImport = () => {
    setIsAddSkillMenuOpen(false);
    setSkillActionError('');
    setIsGithubImportOpen(true);
  };

  const handleImportFromGithub = async () => {
    if (isDownloadingSkill) return;
    await handleAddSkillFromSource(skillDownloadSource);
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('skillsDescription')}
        </p>
      </div>

      {skillActionError && (
        <ErrorMessage
          message={skillActionError}
          onClose={() => setSkillActionError('')}
        />
      )}

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <input
            type="text"
            placeholder={i18nService.t('searchSkills')}
            value={skillSearchQuery}
            onChange={(e) => setSkillSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
          />
        </div>
        <div className="relative">
          <button
            ref={addSkillButtonRef}
            type="button"
            onClick={() => setIsAddSkillMenuOpen(prev => !prev)}
            className="px-3 py-2 text-sm rounded-xl border transition-colors dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center gap-2"
          >
            <PlusCircleIcon className="h-4 w-4" />
            <span>{i18nService.t('addSkill')}</span>
          </button>

          {isAddSkillMenuOpen && (
            <div
              ref={addSkillMenuRef}
              className="absolute right-0 mt-2 w-72 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg z-50 overflow-hidden"
            >
              <button
                type="button"
                onClick={handleUploadSkillZip}
                disabled={isDownloadingSkill}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
              >
                <ArrowUpTrayIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <span>{i18nService.t('uploadSkillZip')}</span>
              </button>
              <button
                type="button"
                onClick={handleUploadSkillFolder}
                disabled={isDownloadingSkill}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
              >
                <FolderOpenIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <span>{i18nService.t('uploadSkillFolder')}</span>
              </button>
              <button
                type="button"
                onClick={handleOpenGithubImport}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                <LinkIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <span>{i18nService.t('importFromGithub')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {filteredSkills.length === 0 ? (
          <div className="col-span-2 text-center py-8 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('noSkillsAvailable')}
          </div>
        ) : (
          filteredSkills.map((skill) => (
            <div
              key={skill.id}
              className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
                    <PuzzlePieceIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                  </div>
                  <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                    {skill.name}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!skill.isBuiltIn && (
                    <button
                      type="button"
                      onClick={() => handleRequestDeleteSkill(skill)}
                      className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      title={i18nService.t('deleteSkill')}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  )}
                  <div
                    className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                      skill.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                    }`}
                    onClick={() => handleToggleSkill(skill.id)}
                  >
                    <div
                      className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                        skill.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </div>
                </div>
              </div>

              <Tooltip
                content={skill.description}
                position="bottom"
                maxWidth="360px"
                className="block w-full"
              >
                <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                  {skill.description}
                </p>
              </Tooltip>

              <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {skill.isOfficial && (
                  <>
                    <span className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-medium">
                      {i18nService.t('official')}
                    </span>
                    <span>·</span>
                  </>
                )}
                {skill.version && (
                  <>
                    <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover font-medium">
                      v{skill.version}
                    </span>
                    <span>·</span>
                  </>
                )}
                <span>{formatSkillDate(skill.updatedAt)}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {skillPendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={handleCancelDeleteSkill}
        >
          <div
            className="w-full max-w-sm mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('deleteSkill')}
            </div>
            <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('skillDeleteConfirm').replace('{name}', skillPendingDelete.name)}
            </p>
            {skillActionError && (
              <div className="mt-3 text-xs text-red-500">
                {skillActionError}
              </div>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelDeleteSkill}
                disabled={isDeletingSkill}
                className="px-3 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteSkill}
                disabled={isDeletingSkill}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isGithubImportOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setIsGithubImportOpen(false)}
        >
          <div
            className="w-full max-w-md mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                  {i18nService.t('githubImportTitle')}
                </div>
                <p className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('githubImportDescription')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsGithubImportOpen(false)}
                className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 space-y-3">
              <div className="text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('githubImportUrlLabel')}
              </div>
              <input
                ref={githubImportInputRef}
                type="text"
                value={skillDownloadSource}
                onChange={(e) => setSkillDownloadSource(e.target.value)}
                placeholder={i18nService.t('githubSkillPlaceholder')}
                className="w-full px-3 py-2.5 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
              />
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('githubImportExamples')}
              </p>
              {skillActionError && (
                <div className="text-xs text-red-500">
                  {skillActionError}
                </div>
              )}
              <button
                type="button"
                onClick={handleImportFromGithub}
                disabled={isDownloadingSkill || !skillDownloadSource.trim()}
                className="w-full py-2.5 rounded-xl bg-claude-accent text-white text-sm font-medium hover:bg-claude-accent/90 transition-colors disabled:opacity-50"
              >
                {isDownloadingSkill ? i18nService.t('importingSkill') : i18nService.t('importSkill')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SkillsManager;
