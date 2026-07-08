import { ArrowPathIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import {
  ArrowDownTrayIcon,
  CheckCircleIcon,
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
import Modal from '../common/Modal';
import ErrorMessage from '../ErrorMessage';
import EditIcon from '../icons/EditIcon';
import FolderOpenIcon from '../icons/FolderOpenIcon';
import LinkIcon from '../icons/LinkIcon';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import SearchIcon from '../icons/SearchIcon';
import SkillIcon from '../icons/SkillIcon';
import TrashIcon from '../icons/TrashIcon';
import UploadIcon from '../icons/UploadIcon';
import {
  getInstalledSkillAnalyticsParams,
  getMarketplaceSkillAnalyticsParams,
  reportSkillAction,
} from './analytics';
import SkillSecurityReport from './SkillSecurityReport';

type SkillTab = 'installed' | 'marketplace';
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

interface SkillsManagerProps {
  readOnly?: boolean;
  onCreateByChat?: () => void;
}

const SkillsManager: React.FC<SkillsManagerProps> = ({ readOnly, onCreateByChat }) => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);

  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [skillDownloadSource, setSkillDownloadSource] = useState('');
  const [skillActionError, setSkillActionError] = useState('');
  const [isDownloadingSkill, setIsDownloadingSkill] = useState(false);
  const [isAddSkillMenuOpen, setIsAddSkillMenuOpen] = useState(false);
  const [isRemoteImportOpen, setIsRemoteImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<ImportSourceType>('github');
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

  const filteredSkills = useMemo(() => {
    const query = skillSearchQuery.trim().replace(/\s+/g, ' ').toLowerCase();
    return skills.filter(skill => {
      const matchesSearch = skill.name.toLowerCase().includes(query)
        || skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description).toLowerCase().includes(query);
      return matchesSearch;
    });
  }, [skills, skillSearchQuery]);

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
    const resultCount = activeTab === 'marketplace'
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
      setActiveTab('marketplace');
      setSkillSearchQuery('skill-creator');
      reportSkillAction('create_by_chat_missing_skill', {
        source: 'skills_manager',
        activeTab: 'marketplace',
        skillId: 'skill-creator',
      });
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('skillCreatorNotInstalled') }));
      return;
    }

    if (!skillCreator.enabled) {
      // Installed but disabled → switch to installed tab and search
      setActiveTab('installed');
      setSkillSearchQuery('skill-creator');
      reportSkillAction('create_by_chat_disabled_skill', {
        source: 'skills_manager',
        activeTab: 'installed',
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
    } catch {
      setSkillActionError(i18nService.t('skillUpgradeFailed'));
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

      try {
        const result = await skillService.upgradeSkill(skill.id, skill.url);
        if (!result.success) {
          console.warn('[SkillsManager] upgrade failed for', skill.id, result.error);
          continue;
        }
        if (result.auditReport && result.pendingInstallId) {
          setUpgradeState(null);
          setSecurityReport(result.auditReport);
          setPendingInstallId(result.pendingInstallId);
          return;
        }
        if (result.skills) {
          dispatch(setSkills(result.skills));
        }
      } catch (error) {
        console.warn('[SkillsManager] upgrade threw for', skill.id, error);
      }
    }

    setUpgradeState(null);
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

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-secondary">
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
      <div className="sticky top-0 z-10 space-y-4 bg-background pb-4">
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
                  resultCount: activeTab === 'marketplace'
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
              <p className="px-3 py-2 text-[11px] text-orange-600 dark:text-orange-400 border-b border-border">
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
          <button
            type="button"
            onClick={() => {
              reportSkillAction('tab_change', {
                source: 'skills_manager',
                activeTab,
                targetTab: 'installed',
              });
              setActiveTab('installed');
            }}
            className={`relative px-2.5 pb-2.5 pt-0.5 text-[13px] font-semibold transition-colors ${
              activeTab === 'installed'
                ? 'text-foreground'
                : 'text-secondary hover:text-foreground'
            }`}
          >
            {i18nService.t('skillInstalled')}
            {skills.length > 0 && (
              <span className="ml-1.5 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                {skills.length}
              </span>
            )}
            <div className={`absolute bottom-[-1px] left-0 right-0 h-0.5 rounded-full transition-colors ${
              activeTab === 'installed' ? 'bg-primary' : 'bg-transparent'
            }`} />
          </button>
          <button
            type="button"
            onClick={() => {
              reportSkillAction('tab_change', {
                source: 'skills_manager',
                activeTab,
                targetTab: 'marketplace',
              });
              setActiveTab('marketplace');
            }}
            className={`relative px-2.5 pb-2.5 pt-0.5 text-[13px] font-semibold transition-colors ${
              activeTab === 'marketplace'
                ? 'text-foreground'
                : 'text-secondary hover:text-foreground'
            }`}
          >
            {i18nService.t('skillMarketplace')}
            <div className={`absolute bottom-[-1px] left-0 right-0 h-0.5 rounded-full transition-colors ${
              activeTab === 'marketplace' ? 'bg-primary' : 'bg-transparent'
            }`} />
          </button>
          {updatableSkills.length > 0 && (
            <div className="ml-auto pr-1 pb-1">
              <button
                type="button"
                onClick={handleUpgradeAll}
                disabled={upgradeState?.isActive === true}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ArrowPathIcon className="h-3 w-3" />
                {i18nService.t('skillUpgradeAll').replace('{count}', String(updatableSkills.length))}
              </button>
            </div>
          )}
        </div>

        {/* Tag filter pills (Marketplace only) */}
        {activeTab === 'marketplace' && !isLoadingMarketplace && marketTags.length > 0 && (
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
      {activeTab === 'installed' && (
      <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {filteredSkills.length === 0 ? (
          <div className="col-span-full text-center py-8 text-sm text-secondary">
            {i18nService.t('noSkillsAvailable')}
          </div>
        ) : (
          filteredSkills.map((skill) => {
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
            return (
            <div
              key={skill.id}
              role="button"
              tabIndex={0}
              className="flex flex-col cursor-pointer rounded-xl border border-border bg-surface p-3 shadow-subtle transition-all hover:border-primary/50 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={openInstalledDetail}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openInstalledDetail();
                }
              }}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-lg bg-primary-muted flex items-center justify-center flex-shrink-0">
                    <SkillIcon className="h-4 w-4 text-primary" />
                  </div>
                  <span className="text-sm font-medium text-foreground truncate">
                    {skill.name}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!readOnly && !skill.isBuiltIn && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleRequestDeleteSkill(skill); }}
                      className="p-1 rounded-lg text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      title={i18nService.t('deleteSkill')}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  )}
                  <div
                    className={`w-9 h-5 rounded-full flex items-center transition-colors flex-shrink-0 ${
                      readOnly ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                    } ${
                      skill.enabled ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                    }`}
                    onClick={(e) => { e.stopPropagation(); if (!readOnly) handleToggleSkill(skill.id); }}
                  >
                    <div
                      className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                        skill.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </div>
                </div>
              </div>

              <p className="text-xs text-secondary line-clamp-2 mb-2">
                {skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)}
              </p>

              <div className="mt-auto flex items-center justify-between text-[11px] text-secondary">
                <div className="flex items-center gap-2">
                {skill.isOfficial && (
                  <>
                    <span className="px-1.5 py-0.5 rounded bg-primary-muted text-primary font-medium">
                      {i18nService.t('official')}
                    </span>
                    <span>·</span>
                  </>
                )}
                {skill.version && (
                  <>
                    <span className="px-1.5 py-0.5 rounded bg-surface-raised font-medium">
                      v{skill.version}
                    </span>
                    <span>·</span>
                  </>
                )}
                <span>{formatSkillDate(skill.updatedAt)}</span>
                </div>
                {(() => {
                  const mp = marketplaceSkills.find(m => m.id === skill.id);
                  if (mp && mp.version && compareVersions(mp.version, skill.version || '0.0.0') > 0) {
                    return (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleUpgradeSkill(mp); }}
                        disabled={upgradeState?.isActive === true}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ArrowPathIcon className="h-3.5 w-3.5" />
                        {i18nService.t('skillUpgrade')}
                      </button>
                    );
                  }
                  return null;
                })()}
              </div>
            </div>
            );
          })
        )}
      </div>
      </>
      )}

      {activeTab === 'marketplace' && (
        isLoadingMarketplace ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="animate-pulse rounded-xl border border-border bg-surface p-3">
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
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
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
                className="flex flex-col cursor-pointer rounded-xl border border-border bg-surface p-3 shadow-subtle transition-all hover:border-primary/50 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={openMarketplaceDetail}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openMarketplaceDetail();
                  }
                }}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-primary-muted flex items-center justify-center flex-shrink-0">
                      <SkillIcon className="h-4 w-4 text-primary" />
                    </div>
                    <span className="text-sm font-medium text-foreground truncate">
                      {skill.name}
                    </span>
                  </div>
                  <div className="flex-shrink-0">
                    {(() => {
                      const status = getSkillInstallStatus(skill);
                      if (status === 'update_available') {
                        return (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleUpgradeSkill(skill); }}
                            disabled={upgradeState?.isActive === true}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <ArrowPathIcon className="h-3.5 w-3.5" />
                            {i18nService.t('skillUpgrade')}
                          </button>
                        );
                      }
                      if (status === 'installed') {
                        return (
                          <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-green-600 dark:text-green-400 bg-green-500/10">
                            <CheckCircleIcon className="h-3.5 w-3.5" />
                            {i18nService.t('skillAlreadyInstalled')}
                          </span>
                        );
                      }
                      return !readOnly ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleInstallMarketplaceSkill(skill); }}
                          disabled={installingSkillId !== null}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                          {installingSkillId === skill.id ? i18nService.t('skillInstalling') : i18nService.t('skillInstall')}
                        </button>
                      ) : null;
                    })()}
                  </div>
                </div>

                <p className="text-xs text-secondary line-clamp-2 mb-2">
                  {resolveLocalizedText(skill.description)}
                </p>

                <div className="mt-auto flex items-center gap-2 text-[11px] text-secondary">
                  {skill.source?.from && (
                    <>
                      <span className="px-1.5 py-0.5 rounded bg-surface-raised font-medium">
                        {skill.source.from}
                      </span>
                      <span>·</span>
                    </>
                  )}
                  {skill.version && (
                    <>
                      {(() => {
                        const installedVer = getInstalledVersion(skill.id);
                        if (installedVer && compareVersions(skill.version, installedVer) > 0) {
                          return (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium">
                              v{installedVer} → v{skill.version}
                            </span>
                          );
                        }
                        return (
                          <span className="px-1.5 py-0.5 rounded bg-surface-raised font-medium">
                            v{skill.version}
                          </span>
                        );
                      })()}
                    </>
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
          className="w-full max-w-md mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-6"
        >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-background flex items-center justify-center flex-shrink-0">
                  <SkillIcon className="h-5 w-5 text-secondary" />
                </div>
                <div className="min-w-0">
                  <div className="text-base font-semibold text-foreground truncate">
                    {selectedMarketplaceSkill.name}
                  </div>
                </div>
              </div>
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
                className="p-1.5 rounded-lg text-secondary hover:text-foreground hover:bg-surface-raised transition-colors flex-shrink-0"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-secondary mb-4">
              {resolveLocalizedText(selectedMarketplaceSkill.description)}
            </p>

            <div className="space-y-2 mb-5">
              {selectedMarketplaceSkill.version && (
                <div className="flex items-center text-xs">
                  <span className="w-16 flex-shrink-0 text-secondary">{i18nService.t('skillDetailVersion')}</span>
                  <span className="px-1.5 py-0.5 rounded bg-surface-raised text-foreground font-medium">
                    v{selectedMarketplaceSkill.version}
                  </span>
                </div>
              )}
              {selectedMarketplaceSkill.source?.from && (
                <div className="flex items-center text-xs">
                  <span className="w-16 flex-shrink-0 text-secondary">{i18nService.t('skillDetailSource')}</span>
                  <span className="px-1.5 py-0.5 rounded bg-surface-raised text-foreground font-medium">
                    {selectedMarketplaceSkill.source.from}
                  </span>
                  {selectedMarketplaceSkill.source.author && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded bg-surface-raised text-foreground font-medium">
                      {selectedMarketplaceSkill.source.author}
                    </span>
                  )}
                </div>
              )}
              {selectedMarketplaceSkill.source?.url && (
                <div className="flex items-start text-xs">
                  <span className="w-16 flex-shrink-0 text-secondary pt-0.5">URL</span>
                  <button
                    type="button"
                    className="text-primary hover:underline break-all text-left"
                    onClick={(e) => { e.stopPropagation(); window.electron.shell.openExternal(selectedMarketplaceSkill.source.url); }}
                  >
                    {selectedMarketplaceSkill.source.url}
                  </button>
                </div>
              )}
            </div>

            {(() => {
              const status = getSkillInstallStatus(selectedMarketplaceSkill);
              if (status === 'update_available') {
                const installedVer = getInstalledVersion(selectedMarketplaceSkill.id);
                return (
                  <button
                    type="button"
                    onClick={() => handleUpgradeSkill(selectedMarketplaceSkill)}
                    disabled={upgradeState?.isActive === true}
                    className="w-full py-2.5 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    <ArrowPathIcon className="h-4 w-4" />
                    {i18nService.t('skillUpgrade')} v{installedVer} → v{selectedMarketplaceSkill.version}
                  </button>
                );
              }
              if (status === 'installed') {
                return (
                  <div className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-green-500/10 text-green-600 dark:text-green-400 text-sm font-medium">
                    <CheckCircleIcon className="h-4 w-4" />
                    {i18nService.t('skillAlreadyInstalled')}
                  </div>
                );
              }
              return !readOnly ? (
                <button
                  type="button"
                  onClick={() => handleInstallMarketplaceSkill(selectedMarketplaceSkill)}
                  disabled={installingSkillId !== null}
                  className="w-full py-2.5 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <ArrowDownTrayIcon className="h-4 w-4" />
                  {installingSkillId === selectedMarketplaceSkill.id ? i18nService.t('skillInstalling') : i18nService.t('skillInstall')}
                </button>
              ) : null;
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
          className="w-full max-w-md mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-6"
        >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-background flex items-center justify-center flex-shrink-0">
                  <SkillIcon className="h-5 w-5 text-secondary" />
                </div>
                <div className="min-w-0">
                  <div className="text-base font-semibold text-foreground truncate">
                    {selectedSkill.name}
                  </div>
                </div>
              </div>
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
                className="p-1.5 rounded-lg text-secondary hover:text-foreground hover:bg-surface-raised transition-colors flex-shrink-0"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-secondary mb-4">
              {skillService.getLocalizedSkillDescription(selectedSkill.id, selectedSkill.name, selectedSkill.description)}
            </p>

            <div className="space-y-2 mb-5">
              {(() => {
                const mp = marketplaceSkills.find(m => m.id === selectedSkill.id);
                return (
                  <>
                    {selectedSkill.isOfficial && (
                      <div className="flex items-center text-xs">
                        <span className="w-16 flex-shrink-0 text-secondary">{i18nService.t('skillDetailSource')}</span>
                        <span className="px-1.5 py-0.5 rounded bg-primary-muted text-primary font-medium">
                          {i18nService.t('official')}
                        </span>
                        {mp?.source?.author && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-surface-raised text-foreground font-medium">
                            {mp.source.author}
                          </span>
                        )}
                      </div>
                    )}
                    {!selectedSkill.isOfficial && mp?.source?.from && (
                      <div className="flex items-center text-xs">
                        <span className="w-16 flex-shrink-0 text-secondary">{i18nService.t('skillDetailSource')}</span>
                        <span className="px-1.5 py-0.5 rounded bg-surface-raised text-foreground font-medium">
                          {mp.source.from}
                        </span>
                        {mp.source.author && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-surface-raised text-foreground font-medium">
                            {mp.source.author}
                          </span>
                        )}
                      </div>
                    )}
                    {mp?.source?.url && (
                      <div className="flex items-start text-xs">
                        <span className="w-16 flex-shrink-0 text-secondary pt-0.5">URL</span>
                        <button
                          type="button"
                          className="text-primary hover:underline break-all text-left"
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
              {!readOnly && !selectedSkill.isBuiltIn ? (
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
                className={`w-9 h-5 rounded-full flex items-center transition-colors flex-shrink-0 ${
                  readOnly ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                } ${
                  selectedSkill.enabled ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                }`}
                onClick={() => {
                  if (readOnly) return;
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

      {upgradeState?.isActive && (
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
                  onClick={() => { upgradeCancelledRef.current = true; }}
                  className="px-4 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                >
                  {i18nService.t('skillUpgradeCancel')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

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
                    <span className="text-[11px] text-muted-foreground truncate">{skill.description}</span>
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
