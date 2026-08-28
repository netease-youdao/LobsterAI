import { ArrowPathIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import {
  ArrowDownTrayIcon,
  CheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import type { SkillSecurityReport as SkillSecurityReportData } from '../../../main/libs/skillSecurity/skillSecurityTypes';
import { ENABLE_OPENCLAW_SKILL_SYNC } from '../../../shared/featureFlags';
import { i18nService } from '../../services/i18n';
import { compareVersions,resolveLocalizedText, skillService } from '../../services/skill';
import { RootState } from '../../store';
import { setSkills } from '../../store/slices/skillSlice';
import { MarketplaceSkill, MarketTag,Skill } from '../../types/skill';
import { CARD_ACTION_PILL_CLASS, DETAIL_ACTION_PILL_CLASS } from '../common/actionPillStyles';
import CardOverflowMenu, { type CardOverflowMenuItem } from '../common/CardOverflowMenu';
import CardToggle from '../common/CardToggle';
import { MANAGEMENT_BODY_TEXT, MANAGEMENT_META_TEXT, MANAGEMENT_TITLE_TEXT } from '../common/managementTypography';
import Modal from '../common/Modal';
import ErrorMessage from '../ErrorMessage';
import EditIcon from '../icons/EditIcon';
import FolderOpenIcon from '../icons/FolderOpenIcon';
import LinkIcon from '../icons/LinkIcon';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import SearchIcon from '../icons/SearchIcon';
import TrashIcon from '../icons/TrashIcon';
import UploadIcon from '../icons/UploadIcon';
import {
  getInstalledSkillAnalyticsParams,
  getMarketplaceSkillAnalyticsParams,
  reportSkillAction,
} from './analytics';
import SkillIconTile from './SkillIconTile';
import SkillSecurityReport from './SkillSecurityReport';
import { SKILL_TAB_LABEL_KEYS, SKILL_TAB_ORDER, SkillTab } from './skillTabs';

type ImportSourceType = 'github' | 'clawhub';
type DirectImportSource = 'zip' | 'folder' | 'remote';

const importSourceTypes: ImportSourceType[] = ['github', 'clawhub'];

const importTabConfig: Record<ImportSourceType, {
  tabLabelKey: string;
  descriptionKey: string;
  urlLabelKey: string;
  placeholderKey: string;
  examplesKey: string;
}> = {
  github: {
    tabLabelKey: 'githubTabLabel',
    descriptionKey: 'githubImportDescription',
    urlLabelKey: 'githubImportUrlLabel',
    placeholderKey: 'githubSkillPlaceholder',
    examplesKey: 'githubImportExamples',
  },
  clawhub: {
    tabLabelKey: 'clawhubTabLabel',
    descriptionKey: 'clawhubImportDescription',
    urlLabelKey: 'clawhubImportUrlLabel',
    placeholderKey: 'clawhubSkillPlaceholder',
    examplesKey: 'clawhubImportExamples',
  },
};

/** Hover/focus-revealed card actions, matching the MCP card treatment. */
const CARD_ACTION_REVEAL_CLASS =
  'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';

interface SkillsManagerProps {
  readOnly?: boolean;
  onCreateByChat?: () => void;
  /** Opens a new conversation with this skill pre-selected. */
  onUseSkill?: (skillId: string) => void;
}

const SkillsManager: React.FC<SkillsManagerProps> = ({ readOnly, onCreateByChat, onUseSkill }) => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);

  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [skillDownloadSource, setSkillDownloadSource] = useState('');
  const [skillActionError, setSkillActionError] = useState('');
  const [isDownloadingSkill, setIsDownloadingSkill] = useState(false);
  const [isAddSkillMenuOpen, setIsAddSkillMenuOpen] = useState(false);
  const [isRemoteImportOpen, setIsRemoteImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<ImportSourceType>('github');
  const [activeTab, setActiveTab] = useState<SkillTab>(SKILL_TAB_ORDER[0]);
  const [marketplaceSkills, setMarketplaceSkills] = useState<MarketplaceSkill[]>([]);
  const [marketTags, setMarketTags] = useState<MarketTag[]>([]);
  const [activeMarketTag, setActiveMarketTag] = useState('all');
  const [isLoadingMarketplace, setIsLoadingMarketplace] = useState(false);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [selectedMarketplaceSkill, setSelectedMarketplaceSkill] = useState<MarketplaceSkill | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillPendingDelete, setSkillPendingDelete] = useState<Skill | null>(null);
  const [isDeletingSkill, setIsDeletingSkill] = useState(false);
  const [securityReport, setSecurityReport] = useState<SkillSecurityReportData | null>(null);
  const [pendingInstallId, setPendingInstallId] = useState<string | null>(null);
  const [pendingImportSource, setPendingImportSource] = useState<DirectImportSource | null>(null);
  const [isConfirmingInstall, setIsConfirmingInstall] = useState(false);
  const [upgradeState, setUpgradeState] = useState<{
    isActive: boolean;
    total: number;
    current: number;
    currentSkillName: string;
    currentSkillVersion: string;
  } | null>(null);
  const upgradeCancelledRef = useRef(false);

  const [detectedOpenClawSkills, setDetectedOpenClawSkills] = useState<Array<{ name: string; description: string; skillKey: string }> | null>(null);
  const [isSyncingFromOpenClaw, setIsSyncingFromOpenClaw] = useState(false);

  const addSkillMenuRef = useRef<HTMLDivElement>(null);
  const addSkillButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const showToast = (message: string) => {
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
  };

  useEffect(() => {
    let isActive = true;
    const loadSkills = async () => {
      // Refresh plugin skill IDs from OpenClaw before loading skills,
      // so that plugin-provided skills are correctly marked as built-in.
      await window.electron?.skills.refreshPluginSkillIds().catch(() => {});
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
    if (!ENABLE_OPENCLAW_SKILL_SYNC) return;
    if (sessionStorage.getItem('openClawSkillSyncDetected')) return;
    const detect = async () => {
      const result = await window.electron?.skills.detectFromOpenClaw();
      if (result?.skills?.length > 0) {
        sessionStorage.setItem('openClawSkillSyncDetected', '1');
        setDetectedOpenClawSkills(result.skills);
      }
    };
    detect();
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
    if (!isRemoteImportOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsRemoteImportOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    setTimeout(() => importInputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isRemoteImportOpen, importTab]);

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

  // User-added skills surface first, newest install/update on top; built-in
  // skills keep their configured order from the main process.
  const mySkills = useMemo(
    () => skills.filter(skill => !skill.isBuiltIn).sort((a, b) => b.updatedAt - a.updatedAt),
    [skills],
  );
  const builtInSkills = useMemo(() => skills.filter(skill => skill.isBuiltIn), [skills]);

  const isSkillSearchActive = skillSearchQuery.trim().length > 0;
  const isInstalledTab = activeTab === SkillTab.Mine || activeTab === SkillTab.BuiltIn;

  const filteredSkills = useMemo(() => {
    const query = skillSearchQuery.trim().replace(/\s+/g, ' ').toLowerCase();
    return [...mySkills, ...builtInSkills].filter(skill => {
      const matchesSearch = skill.name.toLowerCase().includes(query)
        || skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description).toLowerCase().includes(query);
      return matchesSearch;
    });
  }, [mySkills, builtInSkills, skillSearchQuery]);

  const filteredMarketplaceSkills = useMemo(() => {
    const query = skillSearchQuery.trim().replace(/\s+/g, ' ').toLowerCase();
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

  useEffect(() => {
    const query = skillSearchQuery.trim();
    if (!query) return undefined;
    const resultCount = activeTab === SkillTab.Marketplace
      ? filteredMarketplaceSkills.length
      : filteredSkills.length;
    const timer = window.setTimeout(() => {
      reportSkillAction('search', {
        source: 'skills_manager',
        activeTab,
        activeMarketTag,
        searchKeywordLength: query.length,
        resultCount,
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    activeMarketTag,
    activeTab,
    filteredMarketplaceSkills.length,
    filteredSkills.length,
    skillSearchQuery,
  ]);

  useEffect(() => {
    if (!securityReport) return;
    reportSkillAction('security_report_open', {
      source: 'skills_manager',
      sourceType: pendingImportSource ?? 'marketplace',
      riskLevel: securityReport.riskLevel,
      findingsCount: securityReport.findings?.length ?? 0,
    });
  }, [pendingImportSource, securityReport]);

  const formatSkillDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  };

  const handleToggleSkill = async (skillId: string) => {
    const targetSkill = skills.find(skill => skill.id === skillId);
    if (!targetSkill) return;
    const marketplaceSkill = marketplaceSkills.find(skill => skill.id === skillId);
    const targetEnabled = !targetSkill.enabled;
    reportSkillAction('toggle_enabled', {
      source: 'skills_manager',
      activeTab,
      targetEnabled,
      ...getInstalledSkillAnalyticsParams(targetSkill, marketplaceSkill),
    });
    try {
      const updatedSkills = await skillService.setSkillEnabled(skillId, targetEnabled);
      dispatch(setSkills(updatedSkills));
      setSkillActionError('');
      reportSkillAction('toggle_enabled_success', {
        source: 'skills_manager',
        activeTab,
        targetEnabled,
        result: 'success',
        ...getInstalledSkillAnalyticsParams(targetSkill, marketplaceSkill),
      });
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : i18nService.t('skillUpdateFailed'));
      reportSkillAction('toggle_enabled_failed', {
        source: 'skills_manager',
        activeTab,
        targetEnabled,
        result: 'failed',
        errorCode: 'toggle_failed',
        ...getInstalledSkillAnalyticsParams(targetSkill, marketplaceSkill),
      });
    }
  };

  const handleRequestDeleteSkill = (skill: Skill) => {
    if (skill.isBuiltIn) {
      setSkillActionError(i18nService.t('skillBuiltInCannotDelete'));
      return;
    }
    setSkillActionError('');
    reportSkillAction('delete_confirm_open', {
      source: 'skills_manager',
      activeTab,
      ...getInstalledSkillAnalyticsParams(skill, marketplaceSkills.find(item => item.id === skill.id)),
    });
    setSkillPendingDelete(skill);
  };

  const handleCancelDeleteSkill = () => {
    if (isDeletingSkill) return;
    if (skillPendingDelete) {
      reportSkillAction('delete_confirm_cancel', {
        source: 'skills_manager',
        activeTab,
        ...getInstalledSkillAnalyticsParams(
          skillPendingDelete,
          marketplaceSkills.find(item => item.id === skillPendingDelete.id),
        ),
      });
    }
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
      reportSkillAction('delete_failed', {
        source: 'skills_manager',
        activeTab,
        result: 'failed',
        errorCode: 'delete_failed',
        ...getInstalledSkillAnalyticsParams(
          skillPendingDelete,
          marketplaceSkills.find(item => item.id === skillPendingDelete.id),
        ),
      });
      return;
    }
    if (result.skills) {
      dispatch(setSkills(result.skills));
    }
    reportSkillAction('delete_success', {
      source: 'skills_manager',
      activeTab,
      result: 'success',
      ...getInstalledSkillAnalyticsParams(
        skillPendingDelete,
        marketplaceSkills.find(item => item.id === skillPendingDelete.id),
      ),
    });
    setIsDeletingSkill(false);
    setSkillPendingDelete(null);
  };

  const handleAddSkillFromSource = async (source: string, sourceType: DirectImportSource) => {
    const trimmedSource = source.trim();
    if (!trimmedSource) return;
    setIsDownloadingSkill(true);
    setSkillActionError('');
    reportSkillAction('import_submit', {
      source: 'skills_manager',
      sourceType,
      importTab,
      activeTab,
    });
    const result = await skillService.downloadSkill(trimmedSource);
    setIsDownloadingSkill(false);
    console.log('[SkillsManager] downloadSkill result:', JSON.stringify({
      success: result.success,
      error: result.error,
      hasAuditReport: !!result.auditReport,
      pendingInstallId: result.pendingInstallId,
      riskLevel: result.auditReport?.riskLevel,
      findingsCount: result.auditReport?.findings?.length,
    }));
    if (!result.success) {
      setSkillActionError(result.error || i18nService.t('skillDownloadFailed'));
      reportSkillAction('import_failed', {
        source: 'skills_manager',
        sourceType,
        importTab,
        result: 'failed',
        errorCode: 'import_failed',
      });
      return;
    }
    // Security audit returned — show report modal
    if (result.auditReport && result.pendingInstallId) {
      setIsRemoteImportOpen(false);
      setSecurityReport(result.auditReport);
      setPendingInstallId(result.pendingInstallId);
      setPendingImportSource(sourceType);
      return;
    }
    if (result.skills) {
      dispatch(setSkills(result.skills));
    }
    showToast(i18nService.t('skillImportSuccess'));
    reportSkillAction('import_success', {
      source: 'skills_manager',
      sourceType,
      importTab,
      result: 'success',
    });
    setSkillDownloadSource('');
    setIsAddSkillMenuOpen(false);
    setIsRemoteImportOpen(false);
  };

  const handleUploadSkillZip = async () => {
    if (isDownloadingSkill) return;
    reportSkillAction('upload_zip_open', {
      source: 'skills_manager',
      activeTab,
      sourceType: 'zip',
    });
    const result = await window.electron.dialog.selectFile({
      title: i18nService.t('uploadSkillZip'),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (result.success && result.path) {
      await handleAddSkillFromSource(result.path, 'zip');
    }
  };

  const handleUploadSkillFolder = async () => {
    if (isDownloadingSkill) return;
    reportSkillAction('upload_folder_open', {
      source: 'skills_manager',
      activeTab,
      sourceType: 'folder',
    });
    const result = await window.electron.dialog.selectDirectory();
    if (result.success && result.path) {
      await handleAddSkillFromSource(result.path, 'folder');
    }
  };

  const handleOpenRemoteImport = () => {
    setIsAddSkillMenuOpen(false);
    setSkillActionError('');
    setSkillDownloadSource('');
    reportSkillAction('remote_import_open', {
      source: 'skills_manager',
      activeTab,
      importTab,
    });
    setIsRemoteImportOpen(true);
  };

  const handleCreateByChat = () => {
    setIsAddSkillMenuOpen(false);
    const skillCreator = skills.find(s => s.id === 'skill-creator');
    reportSkillAction('create_by_chat', {
      source: 'skills_manager',
      activeTab,
    });

    if (!skillCreator) {
      // Not installed → switch to marketplace tab and search
      setActiveTab(SkillTab.Marketplace);
      setSkillSearchQuery('skill-creator');
      reportSkillAction('create_by_chat_missing_skill', {
        source: 'skills_manager',
        activeTab: SkillTab.Marketplace,
        skillId: 'skill-creator',
      });
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('skillCreatorNotInstalled') }));
      return;
    }

    if (!skillCreator.enabled) {
      // Installed but disabled → switch to the tab that owns it and search
      const ownerTab = skillCreator.isBuiltIn ? SkillTab.BuiltIn : SkillTab.Mine;
      setActiveTab(ownerTab);
      setSkillSearchQuery('skill-creator');
      reportSkillAction('create_by_chat_disabled_skill', {
        source: 'skills_manager',
        activeTab: ownerTab,
        ...getInstalledSkillAnalyticsParams(skillCreator, marketplaceSkills.find(item => item.id === skillCreator.id)),
      });
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('skillCreatorNotEnabled') }));
      return;
    }

    onCreateByChat?.();
  };

  const handleSyncFromOpenClaw = async () => {
    setIsSyncingFromOpenClaw(true);
    reportSkillAction('sync_from_openclaw_submit', {
      source: 'skills_manager',
      detectedCount: detectedOpenClawSkills?.length ?? 0,
    });
    try {
      await window.electron?.skills.syncFromOpenClaw();
      setDetectedOpenClawSkills(null);
      showToast(i18nService.t('skillsSyncSuccess'));
      reportSkillAction('sync_from_openclaw_success', {
        source: 'skills_manager',
        result: 'success',
      });
    } catch {
      showToast(i18nService.t('skillsSyncFailed'));
      reportSkillAction('sync_from_openclaw_failed', {
        source: 'skills_manager',
        result: 'failed',
        errorCode: 'sync_failed',
      });
    } finally {
      setIsSyncingFromOpenClaw(false);
    }
  };

  const handleManualOpenClawSync = async () => {
    setIsAddSkillMenuOpen(false);
    reportSkillAction('manual_openclaw_sync', {
      source: 'skills_manager',
      activeTab,
    });
    const result = await window.electron?.skills.detectFromOpenClaw();
    if (result?.skills?.length > 0) {
      setDetectedOpenClawSkills(result.skills);
    } else {
      showToast(i18nService.t('skillsSyncNoneFound'));
    }
  };

  const handleImportFromDialog = async () => {
    if (isDownloadingSkill) return;
    const trimmed = skillDownloadSource.trim();
    if (!trimmed) return;

    // Validate URL matches the selected tab
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      if (importTab === 'clawhub' && host !== 'clawhub.ai' && host !== 'www.clawhub.ai') {
        setSkillActionError(i18nService.t('importSourceMismatchClawhub'));
        return;
      }
      if (importTab === 'github' && !host.includes('github.com') && !host.includes('github.io')) {
        setSkillActionError(i18nService.t('importSourceMismatchGithub'));
        return;
      }
    } catch {
      // Not a URL (e.g. "owner/repo" shorthand for GitHub) — only allow on GitHub tab
      if (importTab === 'clawhub') {
        setSkillActionError(i18nService.t('importSourceMismatchClawhub'));
        return;
      }
      // GitHub tab: 校验 owner/repo 格式
      const ownerRepoPattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
      if (!ownerRepoPattern.test(trimmed)) {
        setSkillActionError(i18nService.t('importSourceMismatchGithub'));
        return;
      }
    }

    reportSkillAction('remote_import_submit', {
      source: 'skills_manager',
      importTab,
      sourceType: 'remote',
    });
    await handleAddSkillFromSource(trimmed, 'remote');
  };

  const getSkillInstallStatus = (marketplaceSkill: MarketplaceSkill): 'not_installed' | 'installed' | 'update_available' => {
    const installed = skills.find(s => s.id === marketplaceSkill.id);
    if (!installed) return 'not_installed';
    if (!marketplaceSkill.version) return 'installed';
    const localVersion = installed.version || '0.0.0';
    if (compareVersions(marketplaceSkill.version, localVersion) > 0) return 'update_available';
    return 'installed';
  };

  const updatableSkills = useMemo(() => {
    return marketplaceSkills.filter(ms => {
      const installed = skills.find(s => s.id === ms.id);
      if (!installed || !ms.version) return false;
      const localVersion = installed.version || '0.0.0';
      return compareVersions(ms.version, localVersion) > 0;
    });
  }, [skills, marketplaceSkills]);

  const getInstalledVersion = (skillId: string): string | undefined => {
    return skills.find(s => s.id === skillId)?.version;
  };

  const handleUpgradeSkill = async (skill: MarketplaceSkill) => {
    if (upgradeState?.isActive || !skill.url) return;
    const installedSkill = skills.find(item => item.id === skill.id);
    setSkillActionError('');
    console.log('[SkillsManager] upgrade started', {
      skillId: skill.id,
      skillName: skill.name,
      installedVersion: installedSkill?.version ?? null,
      targetVersion: skill.version ?? null,
      activeTab,
    });
    reportSkillAction('upgrade_submit', {
      source: 'skills_manager',
      activeTab,
      ...getMarketplaceSkillAnalyticsParams(skill, installedSkill),
    });
    setUpgradeState({
      isActive: true,
      total: 1,
      current: 1,
      currentSkillName: skill.name,
      currentSkillVersion: skill.version,
    });
    try {
      const result = await skillService.upgradeSkill(skill.id, skill.url);
      if (!result.success) {
        setSkillActionError(result.error || i18nService.t('skillUpgradeFailed'));
        setUpgradeState(null);
        console.warn('[SkillsManager] upgrade failed', {
          skillId: skill.id,
          skillName: skill.name,
          installedVersion: installedSkill?.version ?? null,
          targetVersion: skill.version ?? null,
          activeTab,
          error: result.error ?? null,
        });
        reportSkillAction('upgrade_failed', {
          source: 'skills_manager',
          activeTab,
          result: 'failed',
          errorCode: 'upgrade_failed',
          ...getMarketplaceSkillAnalyticsParams(skill, installedSkill),
        });
        return;
      }
      if (result.auditReport && result.pendingInstallId) {
        setUpgradeState(null);
        console.log('[SkillsManager] upgrade requires security confirmation', {
          skillId: skill.id,
          skillName: skill.name,
          installedVersion: installedSkill?.version ?? null,
          targetVersion: skill.version ?? null,
          activeTab,
          riskLevel: result.auditReport.riskLevel,
        });
        setSecurityReport(result.auditReport);
        setPendingInstallId(result.pendingInstallId);
        setPendingImportSource(null);
        return;
      }
      if (result.skills) {
        dispatch(setSkills(result.skills));
      }
      reportSkillAction('upgrade_success', {
        source: 'skills_manager',
        activeTab,
        result: 'success',
        ...getMarketplaceSkillAnalyticsParams(skill, installedSkill),
      });
      console.log('[SkillsManager] upgrade finished', {
        skillId: skill.id,
        skillName: skill.name,
        installedVersion: installedSkill?.version ?? null,
        targetVersion: skill.version ?? null,
        activeTab,
        result: 'success',
      });
    } catch (error) {
      setSkillActionError(i18nService.t('skillUpgradeFailed'));
      console.error('[SkillsManager] upgrade threw', {
        skillId: skill.id,
        skillName: skill.name,
        installedVersion: installedSkill?.version ?? null,
        targetVersion: skill.version ?? null,
        activeTab,
      }, error);
      reportSkillAction('upgrade_failed', {
        source: 'skills_manager',
        activeTab,
        result: 'failed',
        errorCode: 'upgrade_failed',
        ...getMarketplaceSkillAnalyticsParams(skill, installedSkill),
      });
    } finally {
      setUpgradeState(null);
    }
  };

  const handleUpgradeAll = async () => {
    if (upgradeState?.isActive || updatableSkills.length === 0) return;
    setSkillActionError('');
    upgradeCancelledRef.current = false;
    reportSkillAction('upgrade_all_submit', {
      source: 'skills_manager',
      activeTab,
      updatableCount: updatableSkills.length,
    });

    const toUpdate = [...updatableSkills];
    console.log('[SkillsManager] upgrade all started', {
      total: toUpdate.length,
      activeTab,
      skillIds: toUpdate.map(skill => skill.id),
    });
    setUpgradeState({
      isActive: true,
      total: toUpdate.length,
      current: 0,
      currentSkillName: '',
      currentSkillVersion: '',
    });

    for (let i = 0; i < toUpdate.length; i++) {
      if (upgradeCancelledRef.current) break;
      const skill = toUpdate[i];
      setUpgradeState({
        isActive: true,
        total: toUpdate.length,
        current: i + 1,
        currentSkillName: skill.name,
        currentSkillVersion: skill.version,
      });
      console.log('[SkillsManager] upgrade all item started', {
        skillId: skill.id,
        skillName: skill.name,
        targetVersion: skill.version ?? null,
        index: i + 1,
        total: toUpdate.length,
        activeTab,
      });

      try {
        const result = await skillService.upgradeSkill(skill.id, skill.url);
        if (!result.success) {
          console.warn('[SkillsManager] upgrade all item failed', {
            skillId: skill.id,
            skillName: skill.name,
            targetVersion: skill.version ?? null,
            index: i + 1,
            total: toUpdate.length,
            activeTab,
            error: result.error ?? null,
          });
          continue;
        }
        if (result.auditReport && result.pendingInstallId) {
          setUpgradeState(null);
          console.log('[SkillsManager] upgrade all paused for security confirmation', {
            skillId: skill.id,
            skillName: skill.name,
            targetVersion: skill.version ?? null,
            index: i + 1,
            total: toUpdate.length,
            activeTab,
            riskLevel: result.auditReport.riskLevel,
          });
          setSecurityReport(result.auditReport);
          setPendingInstallId(result.pendingInstallId);
          return;
        }
        if (result.skills) {
          dispatch(setSkills(result.skills));
        }
      } catch (error) {
        console.error('[SkillsManager] upgrade all item threw', {
          skillId: skill.id,
          skillName: skill.name,
          targetVersion: skill.version ?? null,
          index: i + 1,
          total: toUpdate.length,
          activeTab,
        }, error);
      }
    }

    setUpgradeState(null);
    console.log('[SkillsManager] upgrade all finished', {
      total: toUpdate.length,
      activeTab,
      result: upgradeCancelledRef.current ? 'cancel' : 'success',
    });
    reportSkillAction('upgrade_all_finished', {
      source: 'skills_manager',
      activeTab,
      updatableCount: toUpdate.length,
      result: upgradeCancelledRef.current ? 'cancel' : 'success',
    });
  };

  const handleInstallMarketplaceSkill = async (skill: MarketplaceSkill) => {
    if (installingSkillId || !skill.url) return;
    const installedSkill = skills.find(item => item.id === skill.id);
    setInstallingSkillId(skill.id);
    setSkillActionError('');
    reportSkillAction('marketplace_install_submit', {
      source: 'skills_manager',
      activeTab,
      ...getMarketplaceSkillAnalyticsParams(skill, installedSkill),
    });
    try {
      const result = await skillService.downloadSkill(skill.url);
      if (!result.success) {
        setSkillActionError(result.error || i18nService.t('skillInstallFailed'));
        reportSkillAction('marketplace_install_failed', {
          source: 'skills_manager',
          activeTab,
          result: 'failed',
          errorCode: 'install_failed',
          ...getMarketplaceSkillAnalyticsParams(skill, installedSkill),
        });
        return;
      }
      // Security audit returned — show report modal
      if (result.auditReport && result.pendingInstallId) {
        setSecurityReport(result.auditReport);
        setPendingInstallId(result.pendingInstallId);
        setPendingImportSource(null);
        return;
      }
      if (result.skills) {
        dispatch(setSkills(result.skills));
      }
      reportSkillAction('marketplace_install_success', {
        source: 'skills_manager',
        activeTab,
        result: 'success',
        ...getMarketplaceSkillAnalyticsParams(skill, installedSkill),
      });
    } catch {
      setSkillActionError(i18nService.t('skillInstallFailed'));
      reportSkillAction('marketplace_install_failed', {
        source: 'skills_manager',
        activeTab,
        result: 'failed',
        errorCode: 'install_failed',
        ...getMarketplaceSkillAnalyticsParams(skill, installedSkill),
      });
    } finally {
      setInstallingSkillId(null);
    }
  };

  const handleSecurityReportAction = async (action: 'install' | 'installDisabled' | 'cancel') => {
    if (!pendingInstallId) return;
    setIsConfirmingInstall(true);
    reportSkillAction('security_report_action', {
      source: 'skills_manager',
      securityAction: action,
      sourceType: pendingImportSource ?? 'marketplace',
      riskLevel: securityReport?.riskLevel,
      findingsCount: securityReport?.findings?.length ?? 0,
      result: action === 'cancel' ? 'cancel' : undefined,
    });
    try {
      const result = await skillService.confirmInstall(pendingInstallId, action);
      if (result.success && result.skills) {
        dispatch(setSkills(result.skills));
        if (action !== 'cancel' && pendingImportSource) {
          showToast(i18nService.t('skillImportSuccess'));
        }
      }
      if (!result.success && result.error) {
        setSkillActionError(result.error);
      }
    } catch {
      setSkillActionError(i18nService.t('skillInstallFailed'));
    } finally {
      setSecurityReport(null);
      setPendingInstallId(null);
      setPendingImportSource(null);
      setIsConfirmingInstall(false);
      setInstallingSkillId(null);
      setSkillDownloadSource('');
      setIsAddSkillMenuOpen(false);
      setIsRemoteImportOpen(false);
    }
  };

  /**
   * Enable/disable lives on the card as an always-visible switch (same layout
   * as an MCP card), so the menu keeps only the rare destructive action.
   */
  const buildInstalledSkillMenuItems = (skill: Skill): CardOverflowMenuItem[] => {
    const items: CardOverflowMenuItem[] = [];
    if (!readOnly && !skill.isBuiltIn) {
      items.push({
        key: 'delete',
        label: i18nService.t('deleteSkill'),
        icon: <TrashIcon className="h-3.5 w-3.5" />,
        destructive: true,
        onSelect: () => handleRequestDeleteSkill(skill),
      });
    }
    return items;
  };

  const handleUseSkill = (skill: Skill) => {
    reportSkillAction('use_skill', {
      source: 'skills_manager',
      activeTab,
      ...getInstalledSkillAnalyticsParams(
        skill,
        marketplaceSkills.find(item => item.id === skill.id),
      ),
    });
    setSelectedSkill(null);
    onUseSkill?.(skill.id);
  };

  /** The App Store style facts strip: only what helps you decide. */
  const getMarketplaceSkillStats = (skill: MarketplaceSkill): Array<{ label: string; value: string }> => {
    const stats: Array<{ label: string; value: string }> = [];
    const categoryTag = skill.tags?.map(tagId => marketTags.find(tag => tag.id === tagId)).find(Boolean);
    if (categoryTag) {
      stats.push({ label: i18nService.t('skillDetailCategory'), value: resolveLocalizedText(categoryTag) });
    }
    if (skill.version) {
      stats.push({ label: i18nService.t('skillDetailVersion'), value: `v${skill.version}` });
    }
    if (skill.source?.from) {
      stats.push({ label: i18nService.t('skillDetailSource'), value: skill.source.from });
    }
    return stats;
  };

  /**
   * Facts strip for an installed skill. Source always resolves to something
   * true — many user-installed skills carry no version or upstream metadata,
   * and a strip holding a single lone value reads as broken.
   */
  const getInstalledSkillStats = (skill: Skill): Array<{ label: string; value: string }> => {
    const marketplaceSkill = marketplaceSkills.find(item => item.id === skill.id);
    const resolveSource = (): string => {
      if (skill.isBuiltIn) return i18nService.t('skillOriginBuiltIn');
      if (skill.isOfficial) return i18nService.t('official');
      if (marketplaceSkill?.source?.from) return marketplaceSkill.source.from;
      return i18nService.t('skillOriginMine');
    };

    const stats: Array<{ label: string; value: string }> = [
      { label: i18nService.t('skillDetailSource'), value: resolveSource() },
    ];
    if (skill.version) {
      stats.push({ label: i18nService.t('skillDetailVersion'), value: `v${skill.version}` });
    }
    stats.push({ label: i18nService.t('skillDetailUpdated'), value: formatSkillDate(skill.updatedAt) });
    return stats;
  };

  const renderMarketplaceDetailAction = (skill: MarketplaceSkill) => {
    const status = getSkillInstallStatus(skill);
    if (status === 'update_available') {
      return (
        <button
          type="button"
          onClick={() => handleUpgradeSkill(skill)}
          disabled={upgradeState?.isActive === true}
          className={DETAIL_ACTION_PILL_CLASS}
        >
          {i18nService.t('skillUpgrade')}
        </button>
      );
    }
    if (status === 'installed') {
      const installedSkill = skills.find(item => item.id === skill.id);
      if (!onUseSkill || !installedSkill?.enabled) {
        return (
          <span className={`inline-flex flex-shrink-0 items-center gap-1 ${MANAGEMENT_BODY_TEXT} text-muted`}>
            <CheckIcon className="h-4 w-4" />
            {i18nService.t('skillAlreadyInstalled')}
          </span>
        );
      }
      return (
        <button
          type="button"
          onClick={() => { setSelectedMarketplaceSkill(null); handleUseSkill(installedSkill); }}
          className={DETAIL_ACTION_PILL_CLASS}
        >
          {i18nService.t('skillUse')}
        </button>
      );
    }
    if (readOnly) return null;
    return (
      <button
        type="button"
        onClick={() => handleInstallMarketplaceSkill(skill)}
        disabled={installingSkillId !== null}
        className={DETAIL_ACTION_PILL_CLASS}
      >
        {installingSkillId === skill.id && <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />}
        {installingSkillId === skill.id ? i18nService.t('skillInstalling') : i18nService.t('skillInstall')}
      </button>
    );
  };

  const getSkillTabCount = (tab: SkillTab): number | null => {
    if (tab === SkillTab.Mine) return mySkills.length;
    if (tab === SkillTab.BuiltIn) return builtInSkills.length;
    return null;
  };

  const renderInstalledSkillCard = (skill: Skill, showOriginBadge: boolean) => {
    const openInstalledDetail = () => {
      reportSkillAction('open_installed_detail', {
        source: 'skills_manager',
        activeTab,
        resultCount: filteredSkills.length,
        ...getInstalledSkillAnalyticsParams(
          skill,
          marketplaceSkills.find(item => item.id === skill.id),
        ),
      });
      setSelectedSkill(skill);
    };
    const displayName = skillService.getLocalizedSkillName(skill.id, skill.name);
    const marketplaceSkill = marketplaceSkills.find(m => m.id === skill.id);
    const hasUpdate = Boolean(
      marketplaceSkill?.version
      && compareVersions(marketplaceSkill.version, skill.version || '0.0.0') > 0,
    );
    return (
      <div
        key={skill.id}
        role="button"
        tabIndex={0}
        className="group flex flex-col cursor-pointer rounded-2xl border border-border bg-surface p-4 shadow-subtle transition-all hover:border-primary/50 hover:shadow-card focus-within:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onClick={openInstalledDetail}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openInstalledDetail();
          }
        }}
      >
        {/* Single-line title keeps every card the same shape; the raw id is
            reference material and lives in the detail dialog. */}
        <div className="mb-3 flex items-center gap-2.5">
          <SkillIconTile icon={skillService.getSkillIcon(skill.id)} />
          <div className={`min-w-0 flex-1 truncate ${MANAGEMENT_TITLE_TEXT} font-semibold leading-snug text-foreground`}>
            {displayName}
          </div>
          {/* This is a management surface — the everyday "use a skill" path is
              the picker in the composer. So use/menu surface on hover or
              keyboard focus, while the enable switch stays on the resting card
              (same layout as an MCP card): state is readable at a glance and
              toggling is one click. */}
          <div className="flex flex-shrink-0 items-center gap-1">
            <div className={`flex items-center gap-1 ${CARD_ACTION_REVEAL_CLASS}`}>
              {onUseSkill && skill.enabled && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleUseSkill(skill); }}
                  className={CARD_ACTION_PILL_CLASS}
                >
                  {i18nService.t('skillUse')}
                </button>
              )}
              <CardOverflowMenu items={buildInstalledSkillMenuItems(skill)} />
            </div>
            <CardToggle
              isOn={skill.enabled}
              label={i18nService.t(skill.enabled ? 'disable' : 'enable')}
              disabled={readOnly}
              onToggle={() => handleToggleSkill(skill.id)}
            />
          </div>
        </div>

        <p className="mb-3 line-clamp-2 min-h-[2.6em] text-xs leading-relaxed text-secondary">
          {skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)}
        </p>

        <div className={`mt-auto flex items-center justify-between gap-2 ${MANAGEMENT_META_TEXT} text-muted`}>
          <div className="flex min-w-0 items-center gap-1.5">
            {/* No "disabled" badge here — the switch above already carries the
                state, and labelling it twice reads as two different facts. */}
            {showOriginBadge ? (
              <span className={`rounded px-1.5 py-0.5 font-medium ${
                skill.isBuiltIn ? 'bg-surface-raised text-secondary' : 'bg-primary-muted text-primary'
              }`}>
                {i18nService.t(skill.isBuiltIn ? 'skillOriginBuiltIn' : 'skillOriginMine')}
              </span>
            ) : skill.isOfficial && (
              <span className="rounded bg-primary-muted px-1.5 py-0.5 font-medium text-primary">
                {i18nService.t('official')}
              </span>
            )}
            <span className="truncate">{formatSkillDate(skill.updatedAt)}</span>
          </div>
          {hasUpdate && marketplaceSkill && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleUpgradeSkill(marketplaceSkill); }}
              disabled={upgradeState?.isActive === true}
              className={`inline-flex flex-shrink-0 items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 ${MANAGEMENT_META_TEXT} font-medium text-emerald-600 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-emerald-400`}
            >
              <ArrowPathIcon className="h-3.5 w-3.5" />
              {i18nService.t('skillUpgrade')}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="pb-2">
        <p className={`${MANAGEMENT_BODY_TEXT} text-secondary`}>
          {i18nService.t('skillsDescription')}
        </p>
      </div>

      {skillActionError && !isRemoteImportOpen && (
        <ErrorMessage
          message={skillActionError}
          onClose={() => setSkillActionError('')}
        />
      )}

      {/* Sticky toolbar: Description + Search + Tabs + Tag pills */}
      <div
        data-skin-management-toolbar="true"
        className="sticky top-0 z-10 space-y-4 bg-background pb-2"
      >
        {/* Search + Add button */}
        <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
          <input
            type="text"
            placeholder={i18nService.t('searchSkills')}
            value={skillSearchQuery}
            onChange={(e) => setSkillSearchQuery(e.target.value)}
            className="w-full pl-9 pr-8 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
          />
          {skillSearchQuery && (
            <button
              type="button"
              onClick={() => {
                reportSkillAction('clear_search', {
                  source: 'skills_manager',
                  activeTab,
                  activeMarketTag,
                  searchKeywordLength: skillSearchQuery.trim().length,
                  resultCount: activeTab === SkillTab.Marketplace
                    ? filteredMarketplaceSkills.length
                    : filteredSkills.length,
                });
                setSkillSearchQuery('');
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-secondary hover:text-primary transition-colors"
            >
              <XCircleIconSolid className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="relative">
          <button
            ref={addSkillButtonRef}
            type="button"
            onClick={() => {
              setIsAddSkillMenuOpen(prev => {
                const next = !prev;
                if (next) {
                  reportSkillAction('add_menu_open', {
                    source: 'skills_manager',
                    activeTab,
                  });
                }
                return next;
              });
            }}
            className="px-3 py-2 text-sm rounded-xl border transition-colors bg-surface border-border text-foreground hover:bg-surface-raised flex items-center gap-2"
          >
            <PlusCircleIcon className="h-4 w-4" />
            <span>{i18nService.t('addSkill')}</span>
          </button>

          {isAddSkillMenuOpen && (
            <div
              ref={addSkillMenuRef}
              className="absolute right-0 mt-2 w-72 rounded-xl border border-border bg-surface shadow-lg z-50 overflow-hidden"
            >
              <p className={`px-3 py-2 ${MANAGEMENT_META_TEXT} text-orange-600 dark:text-orange-400 border-b border-border`}>
                {i18nService.t('addSkillSecurityTip')}
              </p>
              <button
                type="button"
                onClick={handleUploadSkillZip}
                disabled={isDownloadingSkill}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-foreground hover:bg-surface-raised transition-colors disabled:opacity-50"
              >
                <UploadIcon className="h-4 w-4 text-secondary" />
                <span>{i18nService.t('uploadSkillZip')}</span>
              </button>
              <button
                type="button"
                onClick={handleUploadSkillFolder}
                disabled={isDownloadingSkill}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-foreground hover:bg-surface-raised transition-colors disabled:opacity-50"
              >
                <FolderOpenIcon className="h-4 w-4 text-secondary" />
                <span>{i18nService.t('uploadSkillFolder')}</span>
              </button>
              <button
                type="button"
                onClick={handleOpenRemoteImport}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-foreground hover:bg-surface-raised transition-colors"
              >
                <LinkIcon className="h-4 w-4 text-secondary" />
                <span>{i18nService.t('remoteImport')}</span>
              </button>
              <button
                type="button"
                onClick={handleCreateByChat}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-foreground hover:bg-surface-raised transition-colors"
              >
                <EditIcon className="h-4 w-4 text-secondary" />
                <span>{i18nService.t('createSkillByChat')}</span>
              </button>
              {ENABLE_OPENCLAW_SKILL_SYNC && (
              <button
                type="button"
                onClick={handleManualOpenClawSync}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-foreground hover:bg-surface-raised transition-colors border-t border-border"
              >
                <ArrowPathIcon className="h-4 w-4 text-secondary" />
                <span>{i18nService.t('syncSkillsFromOpenClaw')}</span>
              </button>
              )}
            </div>
          )}
        </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center border-b border-border">
          {SKILL_TAB_ORDER.map((tab) => {
            const count = getSkillTabCount(tab);
            return (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  reportSkillAction('tab_change', {
                    source: 'skills_manager',
                    activeTab,
                    targetTab: tab,
                  });
                  setActiveTab(tab);
                }}
                className={`relative px-2.5 pb-2.5 pt-0.5 ${MANAGEMENT_TITLE_TEXT} font-semibold transition-colors ${
                  activeTab === tab
                    ? 'text-foreground'
                    : 'text-secondary hover:text-foreground'
                }`}
              >
                {i18nService.t(SKILL_TAB_LABEL_KEYS[tab])}
                {count !== null && count > 0 && (
                  <span className={`ml-1.5 rounded-full bg-surface-raised px-1.5 py-0.5 ${MANAGEMENT_META_TEXT} font-medium text-secondary`}>
                    {count}
                  </span>
                )}
                <div className={`absolute bottom-[-1px] left-0 right-0 h-0.5 rounded-full transition-colors ${
                  activeTab === tab ? 'bg-primary' : 'bg-transparent'
                }`} />
              </button>
            );
          })}
          {updatableSkills.length > 0 && (
            <div className="ml-auto pr-1 pb-1">
              <button
                type="button"
                onClick={handleUpgradeAll}
                disabled={upgradeState?.isActive === true}
                className={`inline-flex items-center gap-1 px-2 py-1 ${MANAGEMENT_META_TEXT} font-medium rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <ArrowPathIcon className="h-3 w-3" />
                {i18nService.t('skillUpgradeAll').replace('{count}', String(updatableSkills.length))}
              </button>
            </div>
          )}
        </div>

        {/* Tag filter pills (Marketplace only) */}
        {activeTab === SkillTab.Marketplace && !isLoadingMarketplace && marketTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => {
                reportSkillAction('market_tag_change', {
                  source: 'skills_manager',
                  activeTab,
                  activeMarketTag,
                  targetMarketTag: 'all',
                  resultCount: filteredMarketplaceSkills.length,
                });
                setActiveMarketTag('all');
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                activeMarketTag === 'all'
                  ? 'bg-primary text-white'
                  : 'bg-surface-raised text-secondary hover:text-foreground'
              }`}
            >
              {i18nService.t('skillCategoryAll')}
            </button>
            {marketTags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => {
                  reportSkillAction('market_tag_change', {
                    source: 'skills_manager',
                    activeTab,
                    activeMarketTag,
                    targetMarketTag: tag.id,
                    resultCount: filteredMarketplaceSkills.length,
                  });
                  setActiveMarketTag(tag.id);
                }}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  activeMarketTag === tag.id
                    ? 'bg-primary text-white'
                    : 'bg-surface-raised text-secondary hover:text-foreground'
                }`}
              >
                {resolveLocalizedText(tag)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
      {/* Search spans both installed groups, so hits from the other tab stay reachable. */}
      {isInstalledTab && isSkillSearchActive && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {filteredSkills.length === 0 ? (
            <div className="col-span-full text-center py-8 text-sm text-secondary">
              {i18nService.t('noSkillsAvailable')}
            </div>
          ) : (
            filteredSkills.map((skill) => renderInstalledSkillCard(skill, true))
          )}
        </div>
      )}

      {activeTab === SkillTab.Mine && !isSkillSearchActive && (
        mySkills.length === 0 ? (
          readOnly ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-secondary">
              {i18nService.t('noSkillsAvailable')}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
              <p className="mb-3 text-sm text-secondary">
                {i18nService.t('skillGroupMineEmptyHint')}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    reportSkillAction('empty_guide_action', {
                      source: 'skills_manager',
                      targetAction: SkillTab.Marketplace,
                    });
                    setActiveTab(SkillTab.Marketplace);
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-raised transition-colors"
                >
                  <ArrowDownTrayIcon className="h-3.5 w-3.5 text-secondary" />
                  {i18nService.t('skillGroupMineEmptyMarket')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    reportSkillAction('empty_guide_action', {
                      source: 'skills_manager',
                      targetAction: 'upload_zip',
                    });
                    handleUploadSkillZip();
                  }}
                  disabled={isDownloadingSkill}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-raised transition-colors disabled:opacity-50"
                >
                  <UploadIcon className="h-3.5 w-3.5 text-secondary" />
                  {i18nService.t('uploadSkillZip')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    reportSkillAction('empty_guide_action', {
                      source: 'skills_manager',
                      targetAction: 'create_by_chat',
                    });
                    handleCreateByChat();
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-raised transition-colors"
                >
                  <EditIcon className="h-3.5 w-3.5 text-secondary" />
                  {i18nService.t('createSkillByChat')}
                </button>
              </div>
            </div>
          )
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {mySkills.map((skill) => renderInstalledSkillCard(skill, false))}
          </div>
        )
      )}

      {activeTab === SkillTab.BuiltIn && !isSkillSearchActive && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {builtInSkills.map((skill) => renderInstalledSkillCard(skill, false))}
        </div>
      )}

      {activeTab === SkillTab.Marketplace && (
        isLoadingMarketplace ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="animate-pulse rounded-2xl border border-border bg-surface p-4">
                <div className="mb-3 flex items-center gap-2">
                  <div className="h-7 w-7 rounded-lg bg-surface-raised" />
                  <div className="h-3.5 w-1/3 rounded bg-surface-raised" />
                </div>
                <div className="space-y-2">
                  <div className="h-3 w-full rounded bg-surface-raised" />
                  <div className="h-3 w-2/3 rounded bg-surface-raised" />
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  <div className="h-4 w-12 rounded bg-surface-raised" />
                  <div className="h-4 w-10 rounded bg-surface-raised" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {filteredMarketplaceSkills.length === 0 ? (
              <div className="text-center py-12 text-sm text-secondary">
                {i18nService.t('skillMarketplaceEmpty')}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                {filteredMarketplaceSkills.map((skill) => {
                  const openMarketplaceDetail = () => {
                    reportSkillAction('open_marketplace_detail', {
                      source: 'skills_manager',
                      activeTab,
                      activeMarketTag,
                      resultCount: filteredMarketplaceSkills.length,
                      ...getMarketplaceSkillAnalyticsParams(
                        skill,
                        skills.find(item => item.id === skill.id),
                      ),
                    });
                    setSelectedMarketplaceSkill(skill);
                  };
                  return (
              <div
                key={skill.id}
                role="button"
                tabIndex={0}
                className="group flex flex-col cursor-pointer rounded-2xl border border-border bg-surface p-4 shadow-subtle transition-all hover:border-primary/50 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={openMarketplaceDetail}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openMarketplaceDetail();
                  }
                }}
              >
                <div className="mb-3 flex items-center gap-2.5">
                  <SkillIconTile icon={skill.icon ?? skillService.getSkillIcon(skill.id)} />
                  <div className={`min-w-0 flex-1 truncate ${MANAGEMENT_TITLE_TEXT} font-semibold leading-snug text-foreground`}>
                    {skillService.getLocalizedSkillName(skill.id, skill.name)}
                  </div>
                  {/* App Store rules: one capsule, label carries the state.
                      Uninstall is not a browsing action — it lives in detail. */}
                  <div className="flex flex-shrink-0 items-center">
                    {(() => {
                      const status = getSkillInstallStatus(skill);
                      const installedSkill = skills.find(item => item.id === skill.id);
                      if (status === 'update_available') {
                        return (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleUpgradeSkill(skill); }}
                            disabled={upgradeState?.isActive === true}
                            className={CARD_ACTION_PILL_CLASS}
                          >
                            {i18nService.t('skillUpgrade')}
                          </button>
                        );
                      }
                      if (status === 'installed') {
                        if (!onUseSkill || !installedSkill?.enabled) {
                          return (
                            <span className={`inline-flex h-[26px] flex-shrink-0 items-center gap-1 px-1 ${MANAGEMENT_META_TEXT} text-muted`}>
                              <CheckIcon className="h-3.5 w-3.5" />
                              {i18nService.t('skillAlreadyInstalled')}
                            </span>
                          );
                        }
                        return (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleUseSkill(installedSkill); }}
                            className={CARD_ACTION_PILL_CLASS}
                          >
                            {i18nService.t('skillUse')}
                          </button>
                        );
                      }
                      return !readOnly ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleInstallMarketplaceSkill(skill); }}
                          disabled={installingSkillId !== null}
                          className={CARD_ACTION_PILL_CLASS}
                        >
                          {installingSkillId === skill.id && (
                            <ArrowPathIcon className="h-3 w-3 animate-spin" />
                          )}
                          {installingSkillId === skill.id ? i18nService.t('skillInstalling') : i18nService.t('skillInstall')}
                        </button>
                      ) : null;
                    })()}
                  </div>
                </div>

                <p className="mb-3 line-clamp-2 min-h-[2.6em] text-xs leading-relaxed text-secondary">
                  {resolveLocalizedText(skill.description)}
                </p>

                <div className={`mt-auto flex items-center gap-1.5 ${MANAGEMENT_META_TEXT} text-muted`}>
                  {skill.source?.from && (
                    <span className="rounded bg-surface-raised px-1.5 py-0.5 font-medium">
                      {skill.source.from}
                    </span>
                  )}
                  {(() => {
                    const installedVer = getInstalledVersion(skill.id);
                    if (skill.version && installedVer && compareVersions(skill.version, installedVer) > 0) {
                      return (
                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                          v{installedVer} → v{skill.version}
                        </span>
                      );
                    }
                    return null;
                  })()}
                  {skill.source?.author && (
                    <span className="truncate">{skill.source.author}</span>
                  )}
                </div>
              </div>
                  );
                })}
          </div>
            )}
          </>
        )
      )}
      </div>

      {selectedMarketplaceSkill && createPortal(
        <Modal
          onClose={() => {
            reportSkillAction('close_marketplace_detail', {
              source: 'skills_manager',
              activeTab,
              ...getMarketplaceSkillAnalyticsParams(
                selectedMarketplaceSkill,
                skills.find(item => item.id === selectedMarketplaceSkill.id),
              ),
            });
            setSelectedMarketplaceSkill(null);
          }}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          className="mx-4 flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-border bg-surface shadow-2xl"
        >
            {/* App Store product page: identity + one capsule action up top,
                facts as a stats strip, prose below. */}
            <div className="relative flex-shrink-0 px-6 pb-4 pt-6">
              <button
                type="button"
                onClick={() => {
                  reportSkillAction('close_marketplace_detail', {
                    source: 'skills_manager',
                    activeTab,
                    ...getMarketplaceSkillAnalyticsParams(
                      selectedMarketplaceSkill,
                      skills.find(item => item.id === selectedMarketplaceSkill.id),
                    ),
                  });
                  setSelectedMarketplaceSkill(null);
                }}
                aria-label={i18nService.t('close')}
                className="absolute right-4 top-4 rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
              <div className="flex items-center gap-3.5 pr-9">
                <SkillIconTile
                  icon={selectedMarketplaceSkill.icon ?? skillService.getSkillIcon(selectedMarketplaceSkill.id)}
                  className="h-14 w-14 rounded-2xl"
                  iconClassName="h-7 w-7"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-semibold leading-tight text-foreground">
                    {skillService.getLocalizedSkillName(selectedMarketplaceSkill.id, selectedMarketplaceSkill.name)}
                  </div>
                  {selectedMarketplaceSkill.source?.author && (
                    <div className={`mt-1 truncate ${MANAGEMENT_BODY_TEXT} text-secondary`}>
                      {selectedMarketplaceSkill.source.author}
                    </div>
                  )}
                </div>
                {renderMarketplaceDetailAction(selectedMarketplaceSkill)}
              </div>
            </div>

            {(() => {
              const stats = getMarketplaceSkillStats(selectedMarketplaceSkill);
              if (stats.length === 0) return null;
              return (
                <div className="flex flex-shrink-0 border-y border-border">
                  {stats.map((stat, index) => (
                    <div
                      key={stat.label}
                      className={`flex-1 px-6 py-3 text-center ${index > 0 ? 'border-l border-border' : ''}`}
                    >
                      <div className={`${MANAGEMENT_META_TEXT} font-medium uppercase tracking-wide text-muted`}>
                        {stat.label}
                      </div>
                      <div className={`mt-1 truncate ${MANAGEMENT_BODY_TEXT} font-semibold text-foreground`}>
                        {stat.value}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <h3 className={`mb-2 ${MANAGEMENT_BODY_TEXT} font-semibold text-foreground`}>
                {i18nService.t('skillDetailAbout')}
              </h3>
              <p className={`whitespace-pre-wrap break-words ${MANAGEMENT_TITLE_TEXT} leading-relaxed text-secondary`}>
                {resolveLocalizedText(selectedMarketplaceSkill.description)}
              </p>

              <h3 className={`mb-2 mt-5 ${MANAGEMENT_BODY_TEXT} font-semibold text-foreground`}>
                {i18nService.t('skillDetailInfo')}
              </h3>
              <div className="space-y-2">
                <div className="flex items-start text-xs">
                  <span className="w-20 flex-shrink-0 text-secondary">{i18nService.t('skillDetailId')}</span>
                  <span className="min-w-0 break-all font-mono text-foreground">{selectedMarketplaceSkill.name}</span>
                </div>
                {selectedMarketplaceSkill.source?.url && (
                  <div className="flex items-start text-xs">
                    <span className="w-20 flex-shrink-0 text-secondary">{i18nService.t('skillDetailProject')}</span>
                    <button
                      type="button"
                      className="min-w-0 break-all text-left text-primary hover:underline"
                      onClick={(e) => { e.stopPropagation(); window.electron.shell.openExternal(selectedMarketplaceSkill.source.url); }}
                    >
                      {selectedMarketplaceSkill.source.url}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {(() => {
              // The primary action now lives in the header; the footer only
              // carries uninstall, which is rare and destructive.
              const installedSkill = skills.find(item => item.id === selectedMarketplaceSkill.id);
              if (!installedSkill || installedSkill.isBuiltIn || readOnly) return null;
              return (
                <div className="flex flex-shrink-0 items-center border-t border-border px-6 py-3">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMarketplaceSkill(null);
                      handleRequestDeleteSkill(installedSkill);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 ${MANAGEMENT_BODY_TEXT} text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400`}
                  >
                    <TrashIcon className="h-4 w-4" />
                    {i18nService.t('deleteSkill')}
                  </button>
                </div>
              );
            })()}
        </Modal>
      , document.body)}

      {selectedSkill && createPortal(
        <Modal
          onClose={() => {
            reportSkillAction('close_installed_detail', {
              source: 'skills_manager',
              activeTab,
              ...getInstalledSkillAnalyticsParams(
                selectedSkill,
                marketplaceSkills.find(item => item.id === selectedSkill.id),
              ),
            });
            setSelectedSkill(null);
          }}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          className="mx-4 flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-border bg-surface shadow-2xl"
        >
            {/* Same product-page shape as the marketplace dialog: identity
                and the primary action on top, facts as a strip, prose below,
                management controls in the footer. */}
            <div className="relative flex-shrink-0 px-6 pb-4 pt-6">
              <button
                type="button"
                onClick={() => {
                  reportSkillAction('close_installed_detail', {
                    source: 'skills_manager',
                    activeTab,
                    ...getInstalledSkillAnalyticsParams(
                      selectedSkill,
                      marketplaceSkills.find(item => item.id === selectedSkill.id),
                    ),
                  });
                  setSelectedSkill(null);
                }}
                aria-label={i18nService.t('close')}
                className="absolute right-4 top-4 rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
              <div className="flex items-center gap-3.5 pr-9">
                <SkillIconTile
                  icon={skillService.getSkillIcon(selectedSkill.id)}
                  className="h-14 w-14 rounded-2xl"
                  iconClassName="h-7 w-7"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-semibold leading-tight text-foreground">
                    {skillService.getLocalizedSkillName(selectedSkill.id, selectedSkill.name)}
                  </div>
                  {(() => {
                    const mp = marketplaceSkills.find(m => m.id === selectedSkill.id);
                    const author = mp?.source?.author;
                    if (!author) return null;
                    return <div className={`mt-1 truncate ${MANAGEMENT_BODY_TEXT} text-secondary`}>{author}</div>;
                  })()}
                </div>
                {onUseSkill && selectedSkill.enabled && (
                  <button
                    type="button"
                    onClick={() => handleUseSkill(selectedSkill)}
                    className={DETAIL_ACTION_PILL_CLASS}
                  >
                    {i18nService.t('skillUse')}
                  </button>
                )}
              </div>
            </div>

            {(() => {
              const stats = getInstalledSkillStats(selectedSkill);
              if (stats.length === 0) return null;
              return (
                <div className="flex flex-shrink-0 border-y border-border">
                  {stats.map((stat, index) => (
                    <div
                      key={stat.label}
                      className={`flex-1 px-6 py-3 text-center ${index > 0 ? 'border-l border-border' : ''}`}
                    >
                      <div className={`${MANAGEMENT_META_TEXT} font-medium uppercase tracking-wide text-muted`}>
                        {stat.label}
                      </div>
                      <div className={`mt-1 truncate ${MANAGEMENT_BODY_TEXT} font-semibold text-foreground`}>
                        {stat.value}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <h3 className={`mb-2 ${MANAGEMENT_BODY_TEXT} font-semibold text-foreground`}>
                {i18nService.t('skillDetailAbout')}
              </h3>
              <p className={`whitespace-pre-wrap break-words ${MANAGEMENT_TITLE_TEXT} leading-relaxed text-secondary`}>
                {skillService.getLocalizedSkillDescription(selectedSkill.id, selectedSkill.name, selectedSkill.description)}
              </p>

              <h3 className={`mb-2 mt-5 ${MANAGEMENT_BODY_TEXT} font-semibold text-foreground`}>
                {i18nService.t('skillDetailInfo')}
              </h3>
              <div className="space-y-2">
                <div className="flex items-start text-xs">
                  <span className="w-20 flex-shrink-0 text-secondary">{i18nService.t('skillDetailId')}</span>
                  <span className="min-w-0 break-all font-mono text-foreground">{selectedSkill.name}</span>
                </div>
                {(() => {
                  const mp = marketplaceSkills.find(m => m.id === selectedSkill.id);
                  if (!mp?.source?.url) return null;
                  return (
                    <div className="flex items-start text-xs">
                      <span className="w-20 flex-shrink-0 text-secondary">{i18nService.t('skillDetailProject')}</span>
                      <button
                        type="button"
                        className="min-w-0 break-all text-left text-primary hover:underline"
                        onClick={(e) => { e.stopPropagation(); window.electron.shell.openExternal(mp.source.url); }}
                      >
                        {mp.source.url}
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Footer is the management strip: the labelled switch says what it
                toggles, and delete stays quiet until you reach for it. */}
            <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border px-6 py-3">
              <div className="flex items-center gap-2.5">
                <span className={`${MANAGEMENT_BODY_TEXT} text-secondary`}>{i18nService.t('enable')}</span>
                <CardToggle
                  isOn={selectedSkill.enabled}
                  label={i18nService.t(selectedSkill.enabled ? 'disable' : 'enable')}
                  disabled={readOnly}
                  onToggle={() => {
                    handleToggleSkill(selectedSkill.id);
                    setSelectedSkill({ ...selectedSkill, enabled: !selectedSkill.enabled });
                  }}
                />
              </div>
              {!readOnly && !selectedSkill.isBuiltIn && (
                <button
                  type="button"
                  onClick={() => { setSelectedSkill(null); handleRequestDeleteSkill(selectedSkill); }}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 ${MANAGEMENT_BODY_TEXT} text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400`}
                >
                  <TrashIcon className="h-4 w-4" />
                  {i18nService.t('deleteSkill')}
                </button>
              )}
            </div>
        </Modal>
      , document.body)}

      {skillPendingDelete && createPortal(
        <Modal onClose={handleCancelDeleteSkill} overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60" className="w-full max-w-sm mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5">
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('deleteSkill')}
            </div>
            <p className="mt-2 text-sm text-secondary">
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
                className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
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
        </Modal>
      , document.body)}

      {isRemoteImportOpen && createPortal(
        <Modal
          onClose={() => {
            reportSkillAction('remote_import_close', {
              source: 'skills_manager',
              importTab,
              sourceType: 'remote',
            });
            setIsRemoteImportOpen(false);
            setSkillActionError('');
          }}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          className="w-full max-w-md mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-6"
        >
            <div className="flex items-start justify-between">
              <div className="text-lg font-semibold text-foreground">
                {i18nService.t('remoteImportTitle')}
              </div>
              <button
                type="button"
                onClick={() => {
                  reportSkillAction('remote_import_close', {
                    source: 'skills_manager',
                    importTab,
                    sourceType: 'remote',
                  });
                  setIsRemoteImportOpen(false);
                  setSkillActionError('');
                }}
                className="p-1.5 rounded-lg text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 flex items-center gap-1 border-b border-border">
              {importSourceTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    reportSkillAction('remote_import_open', {
                      source: 'skills_manager',
                      importTab: type,
                      sourceType: type,
                    });
                    setImportTab(type);
                    setSkillDownloadSource('');
                    setSkillActionError('');
                  }}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors relative ${
                    importTab === type
                      ? 'text-foreground'
                      : 'text-secondary hover:text-foreground'
                  }`}
                >
                  {i18nService.t(importTabConfig[type].tabLabelKey)}
                  {importTab === type && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                  )}
                </button>
              ))}
            </div>

            <div className="mt-4 space-y-3">
              <p className="text-sm text-secondary">
                {i18nService.t(importTabConfig[importTab].descriptionKey)}
              </p>
              <div className="text-xs font-semibold tracking-wide text-secondary">
                {i18nService.t(importTabConfig[importTab].urlLabelKey)}
              </div>
              <input
                ref={importInputRef}
                type="text"
                value={skillDownloadSource}
                onChange={(e) => setSkillDownloadSource(e.target.value)}
                placeholder={i18nService.t(importTabConfig[importTab].placeholderKey)}
                className="w-full px-3 py-2.5 text-sm rounded-xl bg-background text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="text-xs text-secondary">
                {i18nService.t(importTabConfig[importTab].examplesKey)}
              </p>
              {skillActionError && (
                <div className="text-xs text-red-500">
                  {skillActionError}
                </div>
              )}
              <button
                type="button"
                onClick={handleImportFromDialog}
                disabled={isDownloadingSkill || !skillDownloadSource.trim()}
                className="w-full py-2.5 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
              >
                {isDownloadingSkill ? i18nService.t('importingSkill') : i18nService.t('importSkill')}
              </button>
            </div>
        </Modal>
      , document.body)}

      {securityReport && (
        <SkillSecurityReport
          report={securityReport}
          onAction={handleSecurityReportAction}
          isLoading={isConfirmingInstall}
        />
      )}

      {upgradeState?.isActive && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-6">
            <div className="text-center">
              <div className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-4">
                {i18nService.t('skillUpgrading')
                  .replace('{current}', String(upgradeState.current))
                  .replace('{total}', String(upgradeState.total))}
              </div>

              <div className="w-full h-2 rounded-full dark:bg-claude-darkBorder bg-claude-border mb-3">
                <div
                  className="h-full rounded-full bg-amber-500 transition-all duration-300"
                  style={{ width: `${(upgradeState.current / upgradeState.total) * 100}%` }}
                />
              </div>

              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">
                {i18nService.t('skillUpgradingCurrent')
                  .replace('{name}', upgradeState.currentSkillName)
                  .replace('{version}', upgradeState.currentSkillVersion)}
              </div>

              {upgradeState.total > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    console.log('[SkillsManager] upgrade cancellation requested', {
                      current: upgradeState.current,
                      total: upgradeState.total,
                      currentSkillName: upgradeState.currentSkillName,
                    });
                    upgradeCancelledRef.current = true;
                  }}
                  className="px-4 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                >
                  {i18nService.t('skillUpgradeCancel')}
                </button>
              )}
            </div>
          </div>
        </div>
      , document.body)}

      {/* OpenClaw Skill Sync - Loading Overlay */}
      {isSyncingFromOpenClaw && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-xl shadow-lg p-6 flex items-center gap-3">
            <ArrowPathIcon className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm text-foreground">{i18nService.t('skillsSyncing')}</span>
          </div>
        </div>
      )}

      {/* OpenClaw Skill Sync - Detection Dialog */}
      {detectedOpenClawSkills !== null && detectedOpenClawSkills.length > 0 && !isSyncingFromOpenClaw && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-xl shadow-lg w-full max-w-md p-6">
            <h3 className="text-base font-semibold text-foreground mb-2">
              {i18nService.t('skillsSyncTitle')}
            </h3>
            <p className="text-sm text-muted-foreground mb-3">
              {i18nService.t('skillsSyncFound').replace('{count}', String(detectedOpenClawSkills.length))}
            </p>
            <div className="mb-4 max-h-40 overflow-y-auto rounded-md border border-border bg-surface-raised p-2 space-y-1.5">
              {detectedOpenClawSkills.map(skill => (
                <div key={skill.skillKey} className="flex items-baseline gap-2 px-1">
                  <span className="shrink-0 text-xs font-medium text-foreground bg-background border border-border rounded px-1.5 py-0.5">{skill.name}</span>
                  {skill.description && (
                    <span className={`${MANAGEMENT_META_TEXT} text-muted-foreground truncate`}>{skill.description}</span>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mb-5">
              {i18nService.t('skillsSyncLater')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDetectedOpenClawSkills(null)}
                className="px-4 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('skillsSyncSkip')}
              </button>
              <button
                type="button"
                onClick={handleSyncFromOpenClaw}
                className="px-4 py-1.5 text-xs rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
              >
                {i18nService.t('skillsSyncNow')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SkillsManager;
