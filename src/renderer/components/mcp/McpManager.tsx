import { XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { CheckCircleIcon } from '@heroicons/react/24/outline';
import React, { useCallback,useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { mcpCategories,mcpRegistry } from '../../data/mcpRegistry';
import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import {
  buildInstalledMcpItems,
  McpInstalledItem,
  mergeMarketplaceRegistry,
} from '../../services/mcpRegistryPresentation';
import { RootState } from '../../store';
import { setMcpServers } from '../../store/slices/mcpSlice';
import { McpMarketplaceCategoryInfo,McpRegistryEntry, McpServerConfig, McpServerFormData } from '../../types/mcp';
import Modal from '../common/Modal';
import ErrorMessage from '../ErrorMessage';
import ConnectorIcon from '../icons/ConnectorIcon';
import EditIcon from '../icons/EditIcon';
import SearchIcon from '../icons/SearchIcon';
import TrashIcon from '../icons/TrashIcon';
import {
  getFormAnalyticsParams,
  getRegistryAnalyticsParams,
  getServerAnalyticsParams,
  reportMcpAction,
} from './analytics';
import McpServerFormModal from './McpServerFormModal';

const TRANSPORT_BADGE_COLORS: Record<string, string> = {
  stdio: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  sse: 'bg-green-500/10 text-green-600 dark:text-green-400',
  http: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
};

const LAUNCH_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
  installing: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  ready: 'bg-green-500/10 text-green-600 dark:text-green-400',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400',
  unsupported: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
};

type McpTab = 'installed' | 'marketplace' | 'custom';

const isQichachaRegistryEntry = (entry: McpRegistryEntry): boolean =>
  entry.oauthProvider === 'qichacha';

type RegistryGroupItem = Extract<McpInstalledItem, { kind: 'registryGroup' }>;

type DeleteTarget =
  | { kind: 'server'; id: string; name: string; server: McpServerConfig }
  | {
    kind: 'registryGroup';
    id: string;
    name: string;
    registryId: string;
    servers: McpServerConfig[];
    registryEntry?: McpRegistryEntry;
  };

/**
 * Text with line-clamp-2 that shows a popover above the text when truncated.
 */
const ClampedText: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isClamped, setIsClamped] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const checkClamp = useCallback(() => {
    const el = textRef.current;
    if (el) setIsClamped(el.scrollHeight > el.clientHeight + 1);
  }, []);

  useEffect(() => {
    checkClamp();
    window.addEventListener('resize', checkClamp);
    return () => window.removeEventListener('resize', checkClamp);
  }, [text, checkClamp]);

  const handleEnter = () => {
    if (!isClamped) return;
    timerRef.current = setTimeout(() => setShowFull(true), 400);
  };

  const handleLeave = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setShowFull(false);
  };

  return (
    <div className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <p ref={textRef} className={`line-clamp-2 ${className}`}>{text}</p>
      {showFull && (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-50
          rounded-lg px-3 py-2 text-xs leading-relaxed
          bg-surface-raised text-foreground
          shadow-xl border border-border"
        >
          {text}
        </div>
      )}
    </div>
  );
};

const McpManager: React.FC = () => {
  const dispatch = useDispatch();
  const servers = useSelector((state: RootState) => state.mcp.servers);

  const [activeTab, setActiveTab] = useState<McpTab>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [installingRegistry, setInstallingRegistry] = useState<McpRegistryEntry | null>(null);
  const [connectingRegistryId, setConnectingRegistryId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [dynamicRegistry, setDynamicRegistry] = useState<McpRegistryEntry[]>(() =>
    mergeMarketplaceRegistry(mcpRegistry, mcpRegistry),
  );
  const [dynamicCategories, setDynamicCategories] = useState<ReadonlyArray<{ id: string; key: string; name_zh?: string; name_en?: string }>>(mcpCategories);
  const currentLanguage = i18nService.getLanguage();

  useEffect(() => {
    let isActive = true;
    const loadServers = async () => {
      const loaded = await mcpService.loadServers();
      if (!isActive) return;
      dispatch(setMcpServers(loaded));
    };
    loadServers();
    return () => { isActive = false; };
  }, [dispatch]);

  useEffect(() => {
    return mcpService.onChanged(async () => {
      const loaded = await mcpService.loadServers();
      dispatch(setMcpServers(loaded));
    });
  }, [dispatch]);

  useEffect(() => {
    let isActive = true;
    const fetchMarketplace = async () => {
      const result = await mcpService.fetchMarketplace();
      if (!isActive || !result) return;
      setDynamicRegistry(mergeMarketplaceRegistry(result.registry, mcpRegistry));
      const cats: Array<{ id: string; key: string; name_zh?: string; name_en?: string }> = [
        { id: 'all', key: 'mcpCategoryAll' },
        ...result.categories
          .filter((c: McpMarketplaceCategoryInfo) => c.id !== 'all')
          .map((c: McpMarketplaceCategoryInfo) => ({
            id: c.id,
            key: '',
            name_zh: c.name_zh,
            name_en: c.name_en,
          })),
      ];
      setDynamicCategories(cats);
    };
    fetchMarketplace();
    return () => { isActive = false; };
  }, []);

  const installedRegistryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of servers) {
      if (s.registryId) ids.add(s.registryId);
    }
    return ids;
  }, [servers]);

  const getRegistryEntryDescription = useCallback((entry: McpRegistryEntry): string => {
    const remoteDescription = currentLanguage === 'zh' ? entry.description_zh : entry.description_en;
    if (remoteDescription) return remoteDescription;
    if (entry.descriptionKey) return i18nService.t(entry.descriptionKey);
    return '';
  }, [currentLanguage]);

  const getStdioCommandSummary = (command?: string, args?: string[]): string => {
    if (!command) return '';
    if (!args || args.length === 0) return command;
    return `${command} ${args[args.length - 1]}`;
  };

  const getRegistryEntryForServer = useCallback((server: McpServerConfig): McpRegistryEntry | undefined => {
    if (server.registryId) {
      return dynamicRegistry.find(entry => entry.id === server.registryId);
    }
    if (!server.isBuiltIn) return undefined;
    return dynamicRegistry.find((entry) => (
      entry.name.toLowerCase() === server.name.toLowerCase()
      && entry.transportType === server.transportType
      && entry.command === server.command
    ));
  }, [dynamicRegistry]);

  const getTransportSummary = (server: McpServerConfig): string => {
    if (server.transportType === 'stdio') {
      const parts = [server.command || ''];
      if (server.args && server.args.length > 0) {
        parts.push(server.args[0]);
        if (server.args.length > 1) parts.push('...');
      }
      return parts.join(' ');
    }
    return server.url || '';
  };

  const getLaunchStatusLabel = (server: McpServerConfig): string | null => {
    if (server.transportType !== 'stdio') return null;
    const command = (server.command || '').trim().toLowerCase();
    const isManagedCandidate = command === 'npx' || command === 'npx.cmd';
    if (!server.launchResolution && !isManagedCandidate) return null;
    const status = server.launchResolution?.status;
    if (!status) return i18nService.t('mcpLaunchPending');
    if (status === 'pending') return i18nService.t('mcpLaunchPending');
    if (status === 'installing') return i18nService.t('mcpLaunchInstalling');
    if (status === 'ready') return i18nService.t('mcpLaunchReady');
    if (status === 'failed') return i18nService.t('mcpLaunchFailed');
    if (status === 'unsupported') return i18nService.t('mcpLaunchUnsupported');
    return null;
  };

  const getLaunchStatusClass = (server: McpServerConfig): string => {
    const status = server.launchResolution?.status || 'pending';
    return LAUNCH_STATUS_COLORS[status] || LAUNCH_STATUS_COLORS.pending;
  };

  const getInstalledDescription = useCallback((server: McpServerConfig): string => {
    const persistedDescription = server.description?.trim();
    if (persistedDescription) return persistedDescription;
    const registryEntry = getRegistryEntryForServer(server);
    if (registryEntry) {
      const registryDescription = getRegistryEntryDescription(registryEntry).trim();
      if (registryDescription) return registryDescription;
    }
    return getTransportSummary(server);
  }, [getRegistryEntryDescription, getRegistryEntryForServer]);

  const installedItems = useMemo(
    () => buildInstalledMcpItems(servers, dynamicRegistry),
    [dynamicRegistry, servers],
  );

  const getRegistryGroupName = useCallback((item: RegistryGroupItem): string => {
    return item.registryEntry?.name || item.registryId;
  }, []);

  const getRegistryGroupDescription = useCallback((item: RegistryGroupItem): string => {
    if (item.registryEntry) {
      const description = getRegistryEntryDescription(item.registryEntry).trim();
      if (description) return description;
    }
    return item.servers.map(server => server.description).filter(Boolean).join(' / ');
  }, [getRegistryEntryDescription]);

  const getRegistryGroupTransportType = (item: RegistryGroupItem): string | null => {
    const transportTypes = new Set(item.servers.map(server => server.transportType));
    if (transportTypes.size !== 1) return null;
    return transportTypes.values().next().value ?? null;
  };

  const getRegistryGroupSummary = (item: RegistryGroupItem): string => {
    const registryCommand = item.registryEntry?.command?.trim();
    if (registryCommand) {
      return item.registryEntry?.transportType === 'stdio'
        ? getStdioCommandSummary(registryCommand, item.registryEntry.defaultArgs)
        : registryCommand;
    }
    const summaries = new Set(item.servers.map(getTransportSummary).filter(Boolean));
    return summaries.size === 1 ? summaries.values().next().value ?? '' : '';
  };

  const filteredInstalled = useMemo(() => {
    const query = searchQuery.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!query) return installedItems;
    return installedItems.filter(item => {
      if (item.kind === 'server') {
        return item.server.name.toLowerCase().includes(query)
          || getInstalledDescription(item.server).toLowerCase().includes(query);
      }
      return getRegistryGroupName(item).toLowerCase().includes(query)
        || getRegistryGroupDescription(item).toLowerCase().includes(query)
        || item.servers.some(server =>
          server.name.toLowerCase().includes(query)
          || getInstalledDescription(server).toLowerCase().includes(query),
        );
    });
  }, [
    getInstalledDescription,
    getRegistryGroupDescription,
    getRegistryGroupName,
    installedItems,
    searchQuery,
  ]);

  const filteredCustom = useMemo(() => {
    const custom = servers.filter(s => !s.isBuiltIn);
    const query = searchQuery.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!query) return custom;
    return custom.filter(s =>
      s.name.toLowerCase().includes(query)
      || s.description.toLowerCase().includes(query)
    );
  }, [servers, searchQuery]);

  const filteredMarketplace = useMemo(() => {
    const query = searchQuery.trim().replace(/\s+/g, ' ').toLowerCase();
    let entries = [...dynamicRegistry];
    if (query) {
      entries = entries.filter(e =>
        e.name.toLowerCase().includes(query)
        || getRegistryEntryDescription(e).toLowerCase().includes(query)
      );
    }
    if (activeCategory !== 'all') {
      entries = entries.filter(e => e.category === activeCategory);
    }
    return entries;
  }, [searchQuery, activeCategory, dynamicRegistry, getRegistryEntryDescription]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) return undefined;
    const resultCount = activeTab === 'marketplace'
      ? filteredMarketplace.length
      : activeTab === 'custom'
        ? filteredCustom.length
        : filteredInstalled.length;
    const timer = window.setTimeout(() => {
      reportMcpAction('search', {
        source: 'mcp_manager',
        activeTab,
        activeCategory,
        searchKeywordLength: query.length,
        resultCount,
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    activeCategory,
    activeTab,
    filteredCustom.length,
    filteredInstalled.length,
    filteredMarketplace.length,
    searchQuery,
  ]);

  const handleToggleEnabled = async (serverId: string) => {
    const targetServer = servers.find(s => s.id === serverId);
    if (!targetServer) return;
    const registryEntry = getRegistryEntryForServer(targetServer);
    const targetEnabled = !targetServer.enabled;
    reportMcpAction('toggle_enabled', {
      source: 'mcp_manager',
      activeTab,
      targetEnabled,
      ...getServerAnalyticsParams(targetServer, registryEntry),
    });
    try {
      const updatedServers = await mcpService.setServerEnabled(serverId, targetEnabled);
      dispatch(setMcpServers(updatedServers));
      setActionError('');
      reportMcpAction('toggle_enabled_success', {
        source: 'mcp_manager',
        activeTab,
        targetEnabled,
        result: 'success',
        ...getServerAnalyticsParams(targetServer, registryEntry),
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('mcpUpdateFailed'));
      reportMcpAction('toggle_enabled_failed', {
        source: 'mcp_manager',
        activeTab,
        targetEnabled,
        result: 'failed',
        errorCode: 'toggle_failed',
        ...getServerAnalyticsParams(targetServer, registryEntry),
      });
    }
  };

  const handleRetryLaunchResolution = async (serverId: string) => {
    const targetServer = servers.find(s => s.id === serverId);
    const registryEntry = targetServer ? getRegistryEntryForServer(targetServer) : undefined;
    setActionError('');
    if (targetServer) {
      reportMcpAction('launch_retry_submit', {
        source: 'mcp_manager',
        activeTab,
        ...getServerAnalyticsParams(targetServer, registryEntry),
      });
    }
    const result = await mcpService.retryLaunchResolution(serverId);
    if (!result.success) {
      setActionError(result.error || i18nService.t('mcpUpdateFailed'));
      if (targetServer) {
        reportMcpAction('launch_retry_failed', {
          source: 'mcp_manager',
          activeTab,
          result: 'failed',
          errorCode: 'launch_retry_failed',
          ...getServerAnalyticsParams(targetServer, registryEntry),
        });
      }
      return;
    }
    if (result.servers) {
      dispatch(setMcpServers(result.servers));
    }
    if (targetServer) {
      reportMcpAction('launch_retry_success', {
        source: 'mcp_manager',
        activeTab,
        result: 'success',
        ...getServerAnalyticsParams(targetServer, registryEntry),
      });
    }
  };

  const handleRequestDelete = (server: McpServerConfig) => {
    setActionError('');
    reportMcpAction('delete_confirm_open', {
      source: 'mcp_manager',
      activeTab,
      ...getServerAnalyticsParams(server, getRegistryEntryForServer(server)),
    });
    setPendingDelete({ kind: 'server', id: server.id, name: server.name, server });
  };

  const handleRequestDeleteRegistry = (
    registryId: string,
    name: string,
    registryServers: McpServerConfig[],
    registryEntry?: McpRegistryEntry,
  ) => {
    setActionError('');
    reportMcpAction('delete_confirm_open', {
      source: 'mcp_manager',
      activeTab,
      ...(registryEntry
        ? getRegistryAnalyticsParams(registryEntry)
        : { registryId, mcpName: name }),
    });
    setPendingDelete({
      kind: 'registryGroup',
      id: registryId,
      name,
      registryId,
      servers: registryServers,
      registryEntry,
    });
  };

  const handleCancelDelete = () => {
    if (isDeleting) return;
    if (pendingDelete) {
      reportMcpAction('delete_confirm_cancel', {
        source: 'mcp_manager',
        activeTab,
        ...(pendingDelete.kind === 'server'
          ? getServerAnalyticsParams(pendingDelete.server, getRegistryEntryForServer(pendingDelete.server))
          : pendingDelete.registryEntry
            ? getRegistryAnalyticsParams(pendingDelete.registryEntry)
            : { registryId: pendingDelete.registryId, mcpName: pendingDelete.name }),
      });
    }
    setPendingDelete(null);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || isDeleting) return;
    setIsDeleting(true);
    setActionError('');
    const result = pendingDelete.kind === 'server'
      ? await mcpService.deleteServer(pendingDelete.id)
      : await mcpService.deleteByRegistryId(pendingDelete.registryId);
    if (!result.success) {
      setActionError(result.error || i18nService.t('mcpDeleteFailed'));
      setIsDeleting(false);
      reportMcpAction('delete_failed', {
        source: 'mcp_manager',
        activeTab,
        result: 'failed',
        errorCode: 'delete_failed',
        ...(pendingDelete.kind === 'server'
          ? getServerAnalyticsParams(pendingDelete.server, getRegistryEntryForServer(pendingDelete.server))
          : pendingDelete.registryEntry
            ? getRegistryAnalyticsParams(pendingDelete.registryEntry)
            : { registryId: pendingDelete.registryId, mcpName: pendingDelete.name }),
      });
      return;
    }
    if (result.servers) {
      dispatch(setMcpServers(result.servers));
    }
    reportMcpAction('delete_success', {
      source: 'mcp_manager',
      activeTab,
      result: 'success',
      ...(pendingDelete.kind === 'server'
        ? getServerAnalyticsParams(pendingDelete.server, getRegistryEntryForServer(pendingDelete.server))
        : pendingDelete.registryEntry
          ? getRegistryAnalyticsParams(pendingDelete.registryEntry)
          : { registryId: pendingDelete.registryId, mcpName: pendingDelete.name }),
    });
    setIsDeleting(false);
    setPendingDelete(null);
  };

  const handleToggleRegistryEnabled = async (
    registryId: string,
    registryServers: McpServerConfig[],
    registryEntry?: McpRegistryEntry,
  ) => {
    const targetEnabled = !registryServers.some(server => server.enabled);
    reportMcpAction('toggle_enabled', {
      source: 'mcp_manager',
      activeTab,
      targetEnabled,
      ...(registryEntry
        ? getRegistryAnalyticsParams(registryEntry)
        : { registryId, mcpName: registryId }),
    });
    try {
      const updatedServers = await mcpService.setRegistryEnabled(registryId, targetEnabled);
      dispatch(setMcpServers(updatedServers));
      setActionError('');
      reportMcpAction('toggle_enabled_success', {
        source: 'mcp_manager',
        activeTab,
        targetEnabled,
        result: 'success',
        ...(registryEntry
          ? getRegistryAnalyticsParams(registryEntry)
          : { registryId, mcpName: registryId }),
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('mcpUpdateFailed'));
      reportMcpAction('toggle_enabled_failed', {
        source: 'mcp_manager',
        activeTab,
        targetEnabled,
        result: 'failed',
        errorCode: 'toggle_failed',
        ...(registryEntry
          ? getRegistryAnalyticsParams(registryEntry)
          : { registryId, mcpName: registryId }),
      });
    }
  };

  const handleOpenEditForm = (server: McpServerConfig) => {
    reportMcpAction('edit_open', {
      source: 'mcp_manager',
      activeTab,
      ...getServerAnalyticsParams(server, getRegistryEntryForServer(server)),
    });
    setEditingServer(server);
    setInstallingRegistry(getRegistryEntryForServer(server) ?? null);
    setIsFormOpen(true);
  };

  const handleInstallFromRegistry = (entry: McpRegistryEntry) => {
    reportMcpAction('marketplace_install_open', {
      source: 'mcp_manager',
      activeTab,
      activeCategory,
      ...getRegistryAnalyticsParams(entry),
    });
    if (isQichachaRegistryEntry(entry)) {
      setActionError('');
      setConnectingRegistryId(entry.id);
      mcpService.connectQichacha().then(result => {
        if (!result.success) {
          setActionError(result.error || i18nService.t('mcpQichachaConnectFailed'));
          reportMcpAction('qichacha_connect_failed', {
            source: 'mcp_manager',
            activeTab,
            activeCategory,
            result: 'failed',
            errorCode: 'qichacha_connect_failed',
            ...getRegistryAnalyticsParams(entry),
          });
          return;
        }
        if (result.servers) {
          dispatch(setMcpServers(result.servers));
        }
        reportMcpAction('qichacha_connect_success', {
          source: 'mcp_manager',
          activeTab,
          activeCategory,
          result: 'success',
          ...getRegistryAnalyticsParams(entry),
        });
      }).catch(error => {
        setActionError(error instanceof Error ? error.message : i18nService.t('mcpQichachaConnectFailed'));
      }).finally(() => {
        setConnectingRegistryId(null);
      });
      return;
    }
    setEditingServer(null);
    setInstallingRegistry(entry);
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    reportMcpAction('form_close', {
      source: 'mcp_manager',
      activeTab,
      mode: editingServer ? 'edit' : installingRegistry ? 'marketplace_install' : 'create',
      ...(editingServer
        ? getServerAnalyticsParams(editingServer, getRegistryEntryForServer(editingServer))
        : installingRegistry
          ? getRegistryAnalyticsParams(installingRegistry)
          : {}),
    });
    setIsFormOpen(false);
    setEditingServer(null);
    setInstallingRegistry(null);
  };

  const handleSaveForm = async (data: McpServerFormData) => {
    setActionError('');
    if (editingServer && editingServer.id) {
      reportMcpAction('edit_submit', {
        source: 'mcp_manager',
        activeTab,
        ...getServerAnalyticsParams(editingServer, getRegistryEntryForServer(editingServer)),
        ...getFormAnalyticsParams(data, installingRegistry),
      });
      const result = await mcpService.updateServer(editingServer.id, data);
      if (!result.success) {
        setActionError(result.error || i18nService.t('mcpUpdateFailed'));
        reportMcpAction('edit_failed', {
          source: 'mcp_manager',
          activeTab,
          result: 'failed',
          errorCode: 'edit_failed',
          ...getServerAnalyticsParams(editingServer, getRegistryEntryForServer(editingServer)),
          ...getFormAnalyticsParams(data, installingRegistry),
        });
        return;
      }
      if (result.servers) {
        dispatch(setMcpServers(result.servers));
      }
      reportMcpAction('edit_success', {
        source: 'mcp_manager',
        activeTab,
        result: 'success',
        ...getServerAnalyticsParams(editingServer, getRegistryEntryForServer(editingServer)),
        ...getFormAnalyticsParams(data, installingRegistry),
      });
    } else {
      reportMcpAction('create_submit', {
        source: 'mcp_manager',
        activeTab,
        ...getFormAnalyticsParams(data, installingRegistry),
      });
      const result = await mcpService.createServer(data);
      if (!result.success) {
        setActionError(result.error || i18nService.t('mcpCreateFailed'));
        reportMcpAction('create_failed', {
          source: 'mcp_manager',
          activeTab,
          result: 'failed',
          errorCode: 'create_failed',
          ...getFormAnalyticsParams(data, installingRegistry),
        });
        return;
      }
      if (result.servers) {
        dispatch(setMcpServers(result.servers));
      }
      reportMcpAction('create_success', {
        source: 'mcp_manager',
        activeTab,
        result: 'success',
        ...getFormAnalyticsParams(data, installingRegistry),
      });
    }
    handleCloseForm();
  };

  const handleImportJsonServers = async (
    list: McpServerFormData[],
  ): Promise<{ success: boolean; error?: string }> => {
    setActionError('');
    reportMcpAction('json_import_submit', {
      source: 'mcp_manager',
      activeTab,
      serverCount: list.length,
    });
    let latestServers: McpServerConfig[] | undefined;
    for (const data of list) {
      const result = await mcpService.createServer(data);
      if (!result.success) {
        // Keep the servers created before the failure visible in the UI.
        if (latestServers) dispatch(setMcpServers(latestServers));
        reportMcpAction('json_import_failed', {
          source: 'mcp_manager',
          activeTab,
          result: 'failed',
          errorCode: 'json_import_failed',
          serverCount: list.length,
        });
        return {
          success: false,
          error: `${data.name}: ${result.error || i18nService.t('mcpCreateFailed')}`,
        };
      }
      latestServers = result.servers ?? latestServers;
    }
    if (latestServers) dispatch(setMcpServers(latestServers));
    reportMcpAction('json_import_success', {
      source: 'mcp_manager',
      activeTab,
      result: 'success',
      serverCount: list.length,
    });
    handleCloseForm();
    return { success: true };
  };

  const handleOpenCreateForm = () => {
    reportMcpAction('custom_create_open', {
      source: 'mcp_manager',
      activeTab,
    });
    setEditingServer(null);
    setInstallingRegistry(null);
    setIsFormOpen(true);
  };

  const existingNames = useMemo(() => servers.map(s => s.name), [servers]);

  /**
   * Listen for MCP bridge sync events from the main process.
   * Main process broadcasts syncStart/syncDone after server config changes.
   */
  const marketplaceCount = useMemo(
    () => dynamicRegistry.length,
    [dynamicRegistry]
  );

  const customCount = useMemo(
    () => servers.filter(s => !s.isBuiltIn).length,
    [servers]
  );

  const tabClass = (tab: McpTab) =>
    `relative px-2.5 pb-2.5 pt-0.5 text-[13px] font-semibold transition-colors ${
      activeTab === tab
        ? 'text-foreground'
        : 'text-secondary hover:text-foreground'
    }`;

  const tabIndicatorClass = (tab: McpTab) =>
    `absolute bottom-[-1px] left-0 right-0 h-0.5 rounded-full transition-colors ${
      activeTab === tab ? 'bg-primary' : 'bg-transparent'
    }`;

  return (
    <div className="relative space-y-4">
      {actionError && (
        <ErrorMessage
          message={actionError}
          onClose={() => setActionError('')}
        />
      )}

      {/* Sticky toolbar: Description + Search + Tabs + Category pills */}
      <div className="sticky top-0 z-10 space-y-4 bg-background pb-4">
        {/* Description */}
        <p className="text-sm text-secondary">
          {i18nService.t('mcpDescription')}
        </p>

        {/* Search */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
            <input
              type="text"
              placeholder={i18nService.t('searchMcpServers')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-8 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  reportMcpAction('clear_search', {
                    source: 'mcp_manager',
                    activeTab,
                    activeCategory,
                    searchKeywordLength: searchQuery.trim().length,
                    resultCount: activeTab === 'marketplace'
                      ? filteredMarketplace.length
                      : activeTab === 'custom'
                        ? filteredCustom.length
                        : filteredInstalled.length,
                  });
                  setSearchQuery('');
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-secondary hover:text-primary transition-colors"
              >
                <XCircleIconSolid className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center border-b border-border">
          <button
            type="button"
            onClick={() => {
              reportMcpAction('tab_change', {
                source: 'mcp_manager',
                activeTab,
                targetTab: 'installed',
              });
              setActiveTab('installed');
            }}
            className={tabClass('installed')}
          >
            {i18nService.t('mcpInstalled')}
            {installedItems.length > 0 && (
              <span className="ml-1.5 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                {installedItems.length}
              </span>
            )}
            <div className={tabIndicatorClass('installed')} />
          </button>
          <button
            type="button"
            onClick={() => {
              reportMcpAction('tab_change', {
                source: 'mcp_manager',
                activeTab,
                targetTab: 'marketplace',
              });
              setActiveTab('marketplace');
            }}
            className={tabClass('marketplace')}
          >
            {i18nService.t('mcpMarketplace')}
            {marketplaceCount > 0 && (
              <span className="ml-1.5 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                {marketplaceCount}
              </span>
            )}
            <div className={tabIndicatorClass('marketplace')} />
          </button>
          <button
            type="button"
            onClick={() => {
              reportMcpAction('tab_change', {
                source: 'mcp_manager',
                activeTab,
                targetTab: 'custom',
              });
              setActiveTab('custom');
            }}
            className={tabClass('custom')}
          >
            {i18nService.t('mcpCustom')}
            {customCount > 0 && (
              <span className="ml-1.5 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                {customCount}
              </span>
            )}
            <div className={tabIndicatorClass('custom')} />
          </button>
        </div>

        {/* Category filter pills (Marketplace only) */}
        {activeTab === 'marketplace' && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {dynamicCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  reportMcpAction('category_change', {
                    source: 'mcp_manager',
                    activeTab,
                    activeCategory,
                    targetCategory: cat.id,
                    resultCount: filteredMarketplace.length,
                  });
                  setActiveCategory(cat.id);
                }}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  activeCategory === cat.id
                    ? 'bg-primary text-white'
                    : 'bg-surface-raised text-secondary hover:text-foreground'
                }`}
              >
                {(i18nService.getLanguage() === 'zh' ? cat.name_zh : cat.name_en) || i18nService.t(cat.key)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
      {/* ── Tab: Installed ──────────────────────────────── */}
      {activeTab === 'installed' && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {filteredInstalled.length === 0 ? (
            <div className="col-span-full text-center py-12 text-sm text-secondary">
              {i18nService.t('mcpNoInstalledServers')}
            </div>
          ) : (
            filteredInstalled.map((item) => {
              if (item.kind === 'registryGroup') {
                const groupName = getRegistryGroupName(item);
                const groupDescription = getRegistryGroupDescription(item);
                const groupTransportType = getRegistryGroupTransportType(item);
                const groupSummary = getRegistryGroupSummary(item);
                const groupEnabled = item.servers.some(server => server.enabled);
                return (
                  <div
                    key={item.id}
                    className="flex flex-col rounded-xl border border-border bg-surface p-3 shadow-subtle transition-all hover:border-primary/50 hover:shadow-card"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-7 h-7 rounded-lg bg-primary-muted flex items-center justify-center flex-shrink-0">
                          <ConnectorIcon className="h-4 w-4 text-primary" />
                        </div>
                        <span className="text-sm font-medium text-foreground truncate">
                          {groupName}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => handleRequestDeleteRegistry(
                            item.registryId,
                            groupName,
                            item.servers,
                            item.registryEntry,
                          )}
                          className="p-1 rounded-lg text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                          title={i18nService.t('mcpUninstall')}
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                        <div
                          className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                            groupEnabled ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                          }`}
                          onClick={() => handleToggleRegistryEnabled(
                            item.registryId,
                            item.servers,
                            item.registryEntry,
                          )}
                        >
                          <div
                            className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                              groupEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                            }`}
                          />
                        </div>
                      </div>
                    </div>

                    <ClampedText text={groupDescription} className="text-xs text-secondary mb-2" />

                    <div className="mt-auto flex items-center gap-2 text-[11px] text-secondary min-w-0">
                      {groupTransportType && (
                        <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${TRANSPORT_BADGE_COLORS[groupTransportType] || ''}`}>
                          {groupTransportType}
                        </span>
                      )}
                      <span className="shrink-0 px-1.5 py-0.5 rounded bg-surface-raised">
                        {i18nService.t('mcpServersCount').replace('{count}', String(item.servers.length))}
                      </span>
                      {groupSummary && (
                        <>
                          <span className="shrink-0">·</span>
                          <span className="truncate min-w-0">{groupSummary}</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              }
              const server = item.server;
              const registryEntry = getRegistryEntryForServer(server);
              const installedDescription = getInstalledDescription(server);
              const launchStatusLabel = getLaunchStatusLabel(server);
              return (
                <div
                  key={server.id}
                  className="flex flex-col rounded-xl border border-border bg-surface p-3 shadow-subtle transition-all hover:border-primary/50 hover:shadow-card"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-primary-muted flex items-center justify-center flex-shrink-0">
                        <ConnectorIcon className="h-4 w-4 text-primary" />
                      </div>
                      <span className="text-sm font-medium text-foreground truncate">
                        {server.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleOpenEditForm(server)}
                        className="p-1 rounded-lg text-secondary hover:text-primary dark:hover:text-primary transition-colors"
                        title={i18nService.t('editMcpServer')}
                      >
                        <EditIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRequestDelete(server)}
                        className="p-1 rounded-lg text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                        title={i18nService.t('deleteMcpServer')}
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                      <div
                        className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                          server.enabled ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                        }`}
                        onClick={() => handleToggleEnabled(server.id)}
                      >
                        <div
                          className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                            server.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                          }`}
                        />
                      </div>
                    </div>
                  </div>

                  <ClampedText text={installedDescription} className="text-xs text-secondary mb-2" />

                  <div className="mt-auto flex items-center gap-2 text-[11px] text-secondary min-w-0">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${TRANSPORT_BADGE_COLORS[server.transportType] || ''}`}>
                      {server.transportType}
                    </span>
                    {launchStatusLabel && (
                      <span
                        className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${getLaunchStatusClass(server)}`}
                        title={server.launchResolution?.error || ''}
                      >
                        {launchStatusLabel}
                      </span>
                    )}
                    {server.launchResolution?.status === 'failed' && (
                      <button
                        type="button"
                        onClick={() => handleRetryLaunchResolution(server.id)}
                        className="shrink-0 px-1.5 py-0.5 rounded bg-surface-raised text-primary hover:bg-primary/10 transition-colors"
                      >
                        {i18nService.t('mcpLaunchRetry')}
                      </button>
                    )}
                    {server.transportType === 'stdio' && server.command && (
                      <>
                        <span className="shrink-0">·</span>
                        <span className="truncate min-w-0">{getStdioCommandSummary(server.command, server.args)}</span>
                      </>
                    )}
                    {(server.transportType === 'sse' || server.transportType === 'http') && server.url && (
                      <>
                        <span className="shrink-0">·</span>
                        <span className="truncate min-w-0">{server.url}</span>
                      </>
                    )}
                    {registryEntry?.requiredEnvKeys && registryEntry.requiredEnvKeys.length > 0 && (
                      <>
                        <span className="shrink-0">·</span>
                        <span className="shrink-0 text-amber-500 dark:text-amber-400">
                          {registryEntry.requiredEnvKeys.length} key{registryEntry.requiredEnvKeys.length > 1 ? 's' : ''}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── Tab: Marketplace ────────────────────────────── */}
      {activeTab === 'marketplace' && (
        <div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {filteredMarketplace.length === 0 ? (
              <div className="col-span-full text-center py-12 text-sm text-secondary">
                {i18nService.t('noMcpServersAvailable')}
              </div>
            ) : (
              filteredMarketplace.map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-col rounded-xl border border-border bg-surface p-3 shadow-subtle transition-all hover:border-primary/50 hover:shadow-card"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-primary-muted flex items-center justify-center flex-shrink-0">
                        <ConnectorIcon className="h-4 w-4 text-primary" />
                      </div>
                      <span className="text-sm font-medium text-foreground truncate">
                        {entry.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {installedRegistryIds.has(entry.id) ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-green-600 dark:text-green-400 bg-green-500/10">
                          <CheckCircleIcon className="h-3.5 w-3.5" />
                          {isQichachaRegistryEntry(entry)
                            ? i18nService.t('mcpAuthorized')
                            : i18nService.t('mcpInstalled')}
                        </span>
                      ) : isQichachaRegistryEntry(entry) ? (
                        <button
                          type="button"
                          onClick={() => handleInstallFromRegistry(entry)}
                          disabled={connectingRegistryId === entry.id}
                          className="px-2.5 py-1 text-xs rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {connectingRegistryId === entry.id
                            ? i18nService.t('mcpQichachaConnecting')
                            : i18nService.t('mcpQichachaConnect')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleInstallFromRegistry(entry)}
                          className="px-2.5 py-1 text-xs rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
                        >
                          {i18nService.t('mcpInstall')}
                        </button>
                      )}
                    </div>
                  </div>

                  <ClampedText text={getRegistryEntryDescription(entry)} className="text-xs text-secondary mb-2" />

                  <div className="mt-auto flex items-center gap-2 text-[11px] text-secondary min-w-0">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${TRANSPORT_BADGE_COLORS[entry.transportType] || ''}`}>
                      {entry.transportType}
                    </span>
                    <span className="shrink-0">·</span>
                    <span className="truncate min-w-0">{getStdioCommandSummary(entry.command, entry.defaultArgs)}</span>
                    {entry.requiredEnvKeys && entry.requiredEnvKeys.length > 0 && (
                      <>
                        <span className="shrink-0">·</span>
                        <span className="shrink-0 text-amber-500 dark:text-amber-400">
                          {entry.requiredEnvKeys.length} key{entry.requiredEnvKeys.length > 1 ? 's' : ''}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ── Tab: Custom ─────────────────────────────────── */}
      {activeTab === 'custom' && (
        <div className="space-y-6">
          {/* Custom servers grid (server cards + trailing add button) */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {filteredCustom.map((server) => {
              const launchStatusLabel = getLaunchStatusLabel(server);
              return (
                <div
                  key={server.id}
                  className="flex flex-col rounded-xl border border-border bg-surface p-3 shadow-subtle transition-all hover:border-primary/50 hover:shadow-card"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-primary-muted flex items-center justify-center flex-shrink-0">
                        <ConnectorIcon className="h-4 w-4 text-primary" />
                      </div>
                      <span className="text-sm font-medium text-foreground truncate">
                        {server.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleOpenEditForm(server)}
                        className="p-1 rounded-lg text-secondary hover:text-primary dark:hover:text-primary transition-colors"
                        title={i18nService.t('editMcpServer')}
                      >
                        <EditIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRequestDelete(server)}
                        className="p-1 rounded-lg text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                        title={i18nService.t('deleteMcpServer')}
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                      <div
                        className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                          server.enabled ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                        }`}
                        onClick={() => handleToggleEnabled(server.id)}
                      >
                        <div
                          className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                            server.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                          }`}
                        />
                      </div>
                    </div>
                  </div>

                  <ClampedText text={server.description || getTransportSummary(server)} className="text-xs text-secondary mb-2" />

                  <div className="mt-auto flex items-center gap-2 text-[11px] text-secondary min-w-0">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${TRANSPORT_BADGE_COLORS[server.transportType] || ''}`}>
                      {server.transportType}
                    </span>
                    {launchStatusLabel && (
                      <span
                        className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${getLaunchStatusClass(server)}`}
                        title={server.launchResolution?.error || ''}
                      >
                        {launchStatusLabel}
                      </span>
                    )}
                    {server.launchResolution?.status === 'failed' && (
                      <button
                        type="button"
                        onClick={() => handleRetryLaunchResolution(server.id)}
                        className="shrink-0 px-1.5 py-0.5 rounded bg-surface-raised text-primary hover:bg-primary/10 transition-colors"
                      >
                        {i18nService.t('mcpLaunchRetry')}
                      </button>
                    )}
                    {server.transportType === 'stdio' && server.command && (
                      <>
                        <span className="shrink-0">·</span>
                        <span className="truncate min-w-0">{server.command}</span>
                      </>
                    )}
                    {(server.transportType === 'sse' || server.transportType === 'http') && server.url && (
                      <>
                        <span className="shrink-0">·</span>
                        <span className="truncate min-w-0">{server.url}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {/* Add custom server card (kept last so existing servers lead) */}
            <button
              type="button"
              onClick={handleOpenCreateForm}
              className="flex min-h-[120px] items-center justify-center gap-1 rounded-xl border border-dashed border-border text-sm text-secondary transition-colors hover:border-primary/50 hover:bg-primary-muted/30 hover:text-primary"
            >
              + {i18nService.t('addMcpServer')}
            </button>
          </div>
        </div>
      )}
      </div>

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <Modal onClose={handleCancelDelete} overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60" className="w-full max-w-sm mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5">
            <div className="text-lg font-semibold text-foreground">
              {pendingDelete.kind === 'registryGroup'
                ? i18nService.t('mcpUninstall')
                : i18nService.t('deleteMcpServer')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {(pendingDelete.kind === 'registryGroup'
                ? i18nService.t('mcpRegistryDeleteConfirm')
                : i18nService.t('mcpDeleteConfirm')).replace('{name}', pendingDelete.name)}
            </p>
            {actionError && (
              <div className="mt-3 text-xs text-red-500">
                {actionError}
              </div>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelDelete}
                disabled={isDeleting}
                className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('confirmDelete')}
              </button>
            </div>
        </Modal>
      )}

      {/* Edit / Registry-install form modal */}
      <McpServerFormModal
        isOpen={isFormOpen}
        server={editingServer}
        registryEntry={installingRegistry}
        existingNames={existingNames}
        onClose={handleCloseForm}
        onSave={handleSaveForm}
        onImportJson={handleImportJsonServers}
      />
    </div>
  );
};

export default McpManager;
