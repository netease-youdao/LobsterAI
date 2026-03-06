import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  CheckCircleIcon,
  FolderOpenIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  PlusCircleIcon,
  PuzzlePieceIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { skillService, resolveLocalizedText } from '../../services/skill';
import { setSkills } from '../../store/slices/skillSlice';
import { RootState } from '../../store';
import { Skill, MarketplaceSkill, MarketTag } from '../../types/skill';
import ErrorMessage from '../ErrorMessage';

type SkillTab = 'installed' | 'marketplace';

const SkillsManager: React.FC = () => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);

  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [skillDownloadSource, setSkillDownloadSource] = useState('');
  const [skillActionError, setSkillActionError] = useState('');
  const [isDownloadingSkill, setIsDownloadingSkill] = useState(false);
  const [isAddSkillMenuOpen, setIsAddSkillMenuOpen] = useState(false);
  const [isGithubImportOpen, setIsGithubImportOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SkillTab>('installed');
  const [marketplaceSkills, setMarketplaceSkills] = useState<MarketplaceSkill[]>([]);
  const [marketTags, setMarketTags] = useState<MarketTag[]>([]);
  const [activeMarketTag, setActiveMarketTag] = useState('all');
  const [isLoadingMarketplace, setIsLoadingMarketplace] = useState(false);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [selectedMarketplaceSkill, setSelectedMarketplaceSkill] = useState<MarketplaceSkill | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
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
    let isActive = true;
    setIsLoadingMarketplace(true);
    skillService.fetchMarketplaceSkills().then((data) => {
      if (!isActive) return;
      setMarketplaceSkills(data.skills);
      setMarketTags(data.tags);
      setIsLoadingMarketplace(false);
    });
    return () => { isActive = false; };
  }, []);

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

  useEffect(() => {
    const hasOpenDialog = selectedSkill || selectedMarketplaceSkill;
    if (!hasOpenDialog) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (selectedSkill) setSelectedSkill(null);
        if (selectedMarketplaceSkill) setSelectedMarketplaceSkill(null);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [selectedSkill, selectedMarketplaceSkill]);

  const filteredSkills = useMemo(() => {
    const query = skillSearchQuery.toLowerCase();
    return skills.filter(skill => {
      const matchesSearch = skill.name.toLowerCase().includes(query)
        || skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description).toLowerCase().includes(query);
      return matchesSearch;
    });
  }, [skills, skillSearchQuery]);

  const filteredMarketplaceSkills = useMemo(() => {
    const query = skillSearchQuery.toLowerCase();
    let results = marketplaceSkills;
    if (query) {
      results = results.filter(skill => {
        return skill.name.toLowerCase().includes(query)
          || resolveLocalizedText(skill.description).toLowerCase().includes(query);
      });
    }
    if (activeMarketTag !== 'all') {
      results = results.filter(skill => skill.tags?.includes(activeMarketTag));
    }
    return results;
  }, [marketplaceSkills, skillSearchQuery, activeMarketTag]);

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

  const isSkillInstalled = (skillId: string) => {
    return skills.some(s => s.id === skillId);
  };

  const handleInstallMarketplaceSkill = async (skill: MarketplaceSkill) => {
    if (installingSkillId || !skill.url) return;
    setInstallingSkillId(skill.id);
    setSkillActionError('');
    try {
      const result = await skillService.downloadSkill(skill.url);
      if (!result.success) {
        setSkillActionError(result.error || i18nService.t('skillInstallFailed'));
        return;
      }
      if (result.skills) {
        dispatch(setSkills(result.skills));
      }
    } catch {
      setSkillActionError(i18nService.t('skillInstallFailed'));
    } finally {
      setInstallingSkillId(null);
    }
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

      <div className="flex items-center border-b dark:border-claude-darkBorder border-claude-border">
        <button
          type="button"
          onClick={() => setActiveTab('installed')}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            activeTab === 'installed'
              ? 'dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
          }`}
        >
          {i18nService.t('skillInstalled')}
          {skills.length > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
              {skills.length}
            </span>
          )}
          <div className={`absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
            activeTab === 'installed' ? 'bg-claude-accent' : 'bg-transparent'
          }`} />
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('marketplace')}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            activeTab === 'marketplace'
              ? 'dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
          }`}
        >
          {i18nService.t('skillMarketplace')}
          <div className={`absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
            activeTab === 'marketplace' ? 'bg-claude-accent' : 'bg-transparent'
          }`} />
        </button>
      </div>

      {activeTab === 'installed' && (
      <div className="grid grid-cols-2 gap-3">
        {filteredSkills.length === 0 ? (
          <div className="col-span-2 text-center py-8 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('noSkillsAvailable')}
          </div>
        ) : (
          filteredSkills.map((skill) => (
            <div
              key={skill.id}
              className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50 cursor-pointer"
              onClick={() => setSelectedSkill(skill)}
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
                      onClick={(e) => { e.stopPropagation(); handleRequestDeleteSkill(skill); }}
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
                    onClick={(e) => { e.stopPropagation(); handleToggleSkill(skill.id); }}
                  >
                    <div
                      className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                        skill.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </div>
                </div>
              </div>

              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                {skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)}
              </p>

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
      )}

      {activeTab === 'marketplace' && (
        isLoadingMarketplace ? (
          <div className="text-center py-12 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('downloadingSkill')}
          </div>
        ) : (
          <>
            {marketTags.length > 0 && (
              <div className="flex items-center gap-1.5 mb-4 flex-wrap">
                <button
                  type="button"
                  onClick={() => setActiveMarketTag('all')}
                  className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                    activeMarketTag === 'all'
                      ? 'bg-claude-accent text-white'
                      : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover border dark:border-claude-darkBorder border-claude-border'
                  }`}
                >
                  {i18nService.t('skillCategoryAll')}
                </button>
                {marketTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => setActiveMarketTag(tag.id)}
                    className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                      activeMarketTag === tag.id
                        ? 'bg-claude-accent text-white'
                        : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover border dark:border-claude-darkBorder border-claude-border'
                    }`}
                  >
                    {resolveLocalizedText(tag)}
                  </button>
                ))}
              </div>
            )}
            {filteredMarketplaceSkills.length === 0 ? (
              <div className="text-center py-12 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('skillMarketplaceEmpty')}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {filteredMarketplaceSkills.map((skill) => (
              <div
                key={skill.id}
                className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50 cursor-pointer"
                onClick={() => setSelectedMarketplaceSkill(skill)}
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
                  <div className="flex-shrink-0">
                    {isSkillInstalled(skill.id) ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-green-600 dark:text-green-400 bg-green-500/10">
                        <CheckCircleIcon className="h-3.5 w-3.5" />
                        {i18nService.t('skillAlreadyInstalled')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleInstallMarketplaceSkill(skill); }}
                        disabled={installingSkillId !== null}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                        {installingSkillId === skill.id ? i18nService.t('skillInstalling') : i18nService.t('skillInstall')}
                      </button>
                    )}
                  </div>
                </div>

                <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                  {resolveLocalizedText(skill.description)}
                </p>

                <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {skill.source?.from && (
                    <>
                      <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover font-medium">
                        {skill.source.from}
                      </span>
                      <span>·</span>
                    </>
                  )}
                  {skill.version && (
                    <>
                      <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover font-medium">
                        v{skill.version}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
            )}
          </>
        )
      )}

      {selectedMarketplaceSkill && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setSelectedMarketplaceSkill(null)}
        >
          <div
            className="w-full max-w-md mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg dark:bg-claude-darkBg bg-claude-bg flex items-center justify-center flex-shrink-0">
                  <PuzzlePieceIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </div>
                <div className="min-w-0">
                  <div className="text-base font-semibold dark:text-claude-darkText text-claude-text truncate">
                    {selectedMarketplaceSkill.name}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedMarketplaceSkill(null)}
                className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors flex-shrink-0"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">
              {resolveLocalizedText(selectedMarketplaceSkill.description)}
            </p>

            <div className="space-y-2 mb-5">
              {selectedMarketplaceSkill.version && (
                <div className="flex items-center text-xs">
                  <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('skillDetailVersion')}</span>
                  <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                    v{selectedMarketplaceSkill.version}
                  </span>
                </div>
              )}
              {selectedMarketplaceSkill.source?.from && (
                <div className="flex items-center text-xs">
                  <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('skillDetailSource')}</span>
                  <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                    {selectedMarketplaceSkill.source.from}
                  </span>
                  {selectedMarketplaceSkill.source.author && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                      {selectedMarketplaceSkill.source.author}
                    </span>
                  )}
                </div>
              )}
              {selectedMarketplaceSkill.source?.url && (
                <div className="flex items-start text-xs">
                  <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary pt-0.5">URL</span>
                  <button
                    type="button"
                    className="text-claude-accent hover:underline break-all text-left"
                    onClick={(e) => { e.stopPropagation(); window.electron.shell.openExternal(selectedMarketplaceSkill.source.url); }}
                  >
                    {selectedMarketplaceSkill.source.url}
                  </button>
                </div>
              )}
            </div>

            {isSkillInstalled(selectedMarketplaceSkill.id) ? (
              <div className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-green-500/10 text-green-600 dark:text-green-400 text-sm font-medium">
                <CheckCircleIcon className="h-4 w-4" />
                {i18nService.t('skillAlreadyInstalled')}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleInstallMarketplaceSkill(selectedMarketplaceSkill)}
                disabled={installingSkillId !== null}
                className="w-full py-2.5 rounded-xl bg-claude-accent text-white text-sm font-medium hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <ArrowDownTrayIcon className="h-4 w-4" />
                {installingSkillId === selectedMarketplaceSkill.id ? i18nService.t('skillInstalling') : i18nService.t('skillInstall')}
              </button>
            )}
          </div>
        </div>
      , document.body)}

      {selectedSkill && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setSelectedSkill(null)}
        >
          <div
            className="w-full max-w-md mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg dark:bg-claude-darkBg bg-claude-bg flex items-center justify-center flex-shrink-0">
                  <PuzzlePieceIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </div>
                <div className="min-w-0">
                  <div className="text-base font-semibold dark:text-claude-darkText text-claude-text truncate">
                    {selectedSkill.name}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSkill(null)}
                className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors flex-shrink-0"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">
              {skillService.getLocalizedSkillDescription(selectedSkill.id, selectedSkill.name, selectedSkill.description)}
            </p>

            <div className="space-y-2 mb-5">
              {(() => {
                const mp = marketplaceSkills.find(m => m.id === selectedSkill.id);
                return (
                  <>
                    {selectedSkill.isOfficial && (
                      <div className="flex items-center text-xs">
                        <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('skillDetailSource')}</span>
                        <span className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-medium">
                          {i18nService.t('official')}
                        </span>
                        {mp?.source?.author && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                            {mp.source.author}
                          </span>
                        )}
                      </div>
                    )}
                    {!selectedSkill.isOfficial && mp?.source?.from && (
                      <div className="flex items-center text-xs">
                        <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('skillDetailSource')}</span>
                        <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                          {mp.source.from}
                        </span>
                        {mp.source.author && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                            {mp.source.author}
                          </span>
                        )}
                      </div>
                    )}
                    {mp?.source?.url && (
                      <div className="flex items-start text-xs">
                        <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary pt-0.5">URL</span>
                        <button
                          type="button"
                          className="text-claude-accent hover:underline break-all text-left"
                          onClick={(e) => { e.stopPropagation(); window.electron.shell.openExternal(mp.source.url); }}
                        >
                          {mp.source.url}
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            <div className="flex items-center justify-between">
              {!selectedSkill.isBuiltIn ? (
                <button
                  type="button"
                  onClick={() => { setSelectedSkill(null); handleRequestDeleteSkill(selectedSkill); }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl text-red-500 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <TrashIcon className="h-4 w-4" />
                  {i18nService.t('deleteSkill')}
                </button>
              ) : (
                <div />
              )}
              <div
                className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                  selectedSkill.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                }`}
                onClick={() => {
                  handleToggleSkill(selectedSkill.id);
                  setSelectedSkill({ ...selectedSkill, enabled: !selectedSkill.enabled });
                }}
              >
                <div
                  className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                    selectedSkill.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                  }`}
                />
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {skillPendingDelete && createPortal(
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
      , document.body)}

      {isGithubImportOpen && createPortal(
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
      , document.body)}
    </div>
  );
};

export default SkillsManager;
