import { XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { ArrowPathIcon, ArrowRightStartOnRectangleIcon, CheckIcon } from '@heroicons/react/24/outline';
import React, { useCallback,useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { McpAuthMode, McpOAuthErrorCode, McpOAuthState } from '../../../shared/mcp/auth';
import { mcpCategories,mcpRegistry } from '../../data/mcpRegistry';
import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import { buildOAuthRegistryInstallData, isOAuthRegistryEntry } from '../../services/mcpMarketplaceInstall';
import {
  buildInstalledMcpItems,
  getRegistryEntryDisplayName,
  getRegistryEntryEndpointSummary,
  getRegistryEntryExamples,
  getRegistryEntryLocalizedDescription,
  getRegistryEntryRequiredKeyCount,
  McpInstalledItem,
  mergeMarketplaceRegistry,
  pickMcpConnectorText,
} from '../../services/mcpRegistryPresentation';
import { RootState } from '../../store';
import { setMcpServers } from '../../store/slices/mcpSlice';
import { McpMarketplaceCategoryInfo,McpRegistryEntry, McpServerConfig, McpServerFormData } from '../../types/mcp';
import {
  CARD_ACTION_PILL_CLASS,
  CARD_SECONDARY_PILL_CLASS,
  DETAIL_ACTION_PILL_CLASS,
  DETAIL_SECONDARY_PILL_CLASS,
} from '../common/actionPillStyles';
import CardOverflowMenu, { type CardOverflowMenuItem } from '../common/CardOverflowMenu';
import CardToggle from '../common/CardToggle';
import { MANAGEMENT_BODY_TEXT, MANAGEMENT_META_TEXT, MANAGEMENT_TITLE_TEXT } from '../common/managementTypography';
import Modal from '../common/Modal';
import ErrorMessage from '../ErrorMessage';
import EditIcon from '../icons/EditIcon';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import SearchIcon from '../icons/SearchIcon';
import TrashIcon from '../icons/TrashIcon';
import {
  getFormAnalyticsParams,
  getRegistryAnalyticsParams,
  getServerAnalyticsParams,
  reportMcpAction,
} from './analytics';
import McpCard from './McpCard';
import McpDetailModal, { type McpDetailInfoRow, type McpDetailStat } from './McpDetailModal';
import McpServerFormModal from './McpServerFormModal';
import { MCP_TAB_LABEL_KEYS, MCP_TAB_ORDER, McpTab } from './mcpTabs';
import { describeMcpToolFilter } from './mcpToolFilterLabels';

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

const isQichachaRegistryEntry = (entry: McpRegistryEntry): boolean =>
  entry.oauthProvider === 'qichacha';

const isOAuthRemoteServer = (server: McpServerConfig): boolean =>
  server.transportType !== 'stdio' && server.auth === McpAuthMode.OAuth;

/** How a remote OAuth server's sign-in reads on its card and in its detail. */
const OAuthPhase = {
  SigningIn: 'signing-in',
  SignedIn: 'signed-in',
  SignedOut: 'signed-out',
  // Not loaded by OpenClaw (disabled, or no model configured yet), or the status read failed.
  Unknown: 'unknown',
} as const;
type OAuthPhase = typeof OAuthPhase[keyof typeof OAuthPhase];

const OAUTH_BADGE_BASE_CLASS = 'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium';

const OAUTH_PHASE_BADGES: Record<Exclude<OAuthPhase, typeof OAuthPhase.Unknown>, { labelKey: string; className: string }> = {
  [OAuthPhase.SigningIn]: { labelKey: 'mcpOAuthSigningIn', className: 'bg-gray-500/10 text-gray-600 dark:text-gray-300' },
  [OAuthPhase.SignedIn]: { labelKey: 'mcpOAuthSignedIn', className: 'bg-green-500/10 text-green-600 dark:text-green-400' },
  [OAuthPhase.SignedOut]: { labelKey: 'mcpOAuthNotSignedIn', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
};

const OAUTH_ERROR_MESSAGE_KEYS: Partial<Record<McpOAuthErrorCode, string>> = {
  [McpOAuthErrorCode.AlreadyInProgress]: 'mcpOAuthSignInInProgress',
  [McpOAuthErrorCode.CallbackUnavailable]: 'mcpOAuthCallbackUnavailable',
  [McpOAuthErrorCode.Timeout]: 'mcpOAuthSignInTimeout',
  [McpOAuthErrorCode.RuntimeUnavailable]: 'mcpOAuthRuntimeUnavailable',
};

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

/** Which card's detail dialog is open. Held by id so it tracks live data. */
type DetailTarget =
  | { kind: 'server'; id: string }
  | { kind: 'registryGroup'; registryId: string }
  | { kind: 'marketplace'; entryId: string };

/** "All" leads and resolves via i18n; remote categories carry their own names. */
const buildCategoryOptions = (
  categories: McpMarketplaceCategoryInfo[],
): Array<{ id: string; key: string; name_zh?: string; name_en?: string }> => [
  { id: 'all', key: 'mcpCategoryAll' },
  ...categories
    .filter(category => category.id !== 'all')
    .map(category => ({
      id: category.id,
      key: '',
      name_zh: category.name_zh,
      name_en: category.name_en,
    })),
];

/** Management actions stay hidden until the card is hovered or focused. */
const CARD_MENU_REVEAL_CLASS =
  'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';

const McpManager: React.FC = () => {
  const dispatch = useDispatch();
  const servers = useSelector((state: RootState) => state.mcp.servers);

  const [activeTab, setActiveTab] = useState<McpTab>(MCP_TAB_ORDER[0]);
  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [installingRegistry, setInstallingRegistry] = useState<McpRegistryEntry | null>(null);
  const [connectingRegistryId, setConnectingRegistryId] = useState<string | null>(null);
  const [oauthStates, setOAuthStates] = useState<Record<string, McpOAuthState>>({});
  const [signingInServerId, setSigningInServerId] = useState<string | null>(null);
  // Set once the first `mcp status` read finishes. If that read fails, the sign-in
  // button still appears, since it is then the only way to get a token.
  const [oauthStatusReady, setOAuthStatusReady] = useState(false);
  const [activeCategory, setActiveCategory] = useState('all');
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  // First frame renders the cached copy of the last fetch, so entries and
  // localized names don't visibly swap in when the live response lands. With
  // no cache yet (first run) the marketplace shows a skeleton instead — the
  // server is the only source of listing data, mirroring the Skills page.
  const [initialCache] = useState(() => mcpService.getCachedMarketplace());
  const [isLoadingMarketplace, setIsLoadingMarketplace] = useState(initialCache === null);
  const [dynamicRegistry, setDynamicRegistry] = useState<McpRegistryEntry[]>(() =>
    mergeMarketplaceRegistry(initialCache?.registry ?? mcpRegistry, mcpRegistry),
  );
  const [dynamicCategories, setDynamicCategories] = useState<ReadonlyArray<{ id: string; key: string; name_zh?: string; name_en?: string }>>(() =>
    initialCache ? buildCategoryOptions(initialCache.categories) : mcpCategories,
  );
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
      if (!isActive) return;
      setIsLoadingMarketplace(false);
      if (!result) return;
      setDynamicRegistry(mergeMarketplaceRegistry(result.registry, mcpRegistry));
      setDynamicCategories(buildCategoryOptions(result.categories));
    };
    fetchMarketplace();
    return () => { isActive = false; };
  }, []);

  // Re-read OAuth state whenever the set of OAuth servers (or their identity) changes.
  // `mcp status` spawns the OpenClaw CLI, so skip it when no server uses OAuth.
  const oauthServerSignature = useMemo(
    () => servers
      .filter(isOAuthRemoteServer)
      .map(server => `${server.id}:${server.name}:${server.url ?? ''}:${server.enabled}`)
      .join('|'),
    [servers],
  );

  // Reads overlap (focus, sign-in, sign-out); a read that started earlier never
  // overwrites one that started later.
  const oauthStatusReadRef = useRef(0);
  const refreshOAuthStates = useCallback(async () => {
    const read = ++oauthStatusReadRef.current;
    const states = await mcpService.oauthStatus();
    if (read !== oauthStatusReadRef.current) return;
    setOAuthStates(states);
    setOAuthStatusReady(true);
  }, []);

  useEffect(() => {
    if (!oauthServerSignature) {
      setOAuthStates({});
      return;
    }
    let isActive = true;
    mcpService.oauthStatus().then(states => {
      if (!isActive) return;
      setOAuthStates(states);
      setOAuthStatusReady(true);
    });
    return () => { isActive = false; };
  }, [oauthServerSignature]);

  // A token can expire or be revoked while the app is in the background, so read
  // the state again whenever the window regains focus. No polling: one read per
  // focus, and focus events during a read are skipped.
  useEffect(() => {
    if (!oauthServerSignature) return undefined;
    let reading = false;
    const handleFocus = () => {
      if (reading) return;
      reading = true;
      void refreshOAuthStates().finally(() => { reading = false; });
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [oauthServerSignature, refreshOAuthStates]);

  const installedRegistryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of servers) {
      if (s.registryId) ids.add(s.registryId);
    }
    return ids;
  }, [servers]);

  const getRegistryEntryDescription = useCallback((entry: McpRegistryEntry): string => {
    const remoteDescription = getRegistryEntryLocalizedDescription(entry, currentLanguage);
    if (remoteDescription) return remoteDescription;
    if (entry.descriptionKey) return i18nService.t(entry.descriptionKey);
    return '';
  }, [currentLanguage]);

  /** Marketplace entries may carry per-language names; `name` is the fallback. */
  const getRegistryEntryName = useCallback(
    (entry: McpRegistryEntry): string => getRegistryEntryDisplayName(entry, currentLanguage),
    [currentLanguage],
  );

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

  /**
   * A server stores the name it had when it was installed, in whatever language
   * was active then. For marketplace servers the registry entry is the live,
   * localized source, so it wins; hand-configured servers only have their own.
   */
  const getServerDisplayName = useCallback((server: McpServerConfig): string => {
    const registryEntry = getRegistryEntryForServer(server);
    if (registryEntry) {
      const registryName = getRegistryEntryName(registryEntry).trim();
      if (registryName) return registryName;
    }
    return server.name;
  }, [getRegistryEntryForServer, getRegistryEntryName]);

  const getInstalledDescription = useCallback((server: McpServerConfig): string => {
    const registryEntry = getRegistryEntryForServer(server);
    if (registryEntry) {
      const registryDescription = getRegistryEntryDescription(registryEntry).trim();
      if (registryDescription) return registryDescription;
    }
    const persistedDescription = server.description?.trim();
    if (persistedDescription) return persistedDescription;
    return getTransportSummary(server);
  }, [getRegistryEntryDescription, getRegistryEntryForServer]);

  const getServerIcon = useCallback(
    (server: McpServerConfig): string | undefined => getRegistryEntryForServer(server)?.icon,
    [getRegistryEntryForServer],
  );

  const installedItems = useMemo(
    () => buildInstalledMcpItems(servers, dynamicRegistry),
    [dynamicRegistry, servers],
  );

  const getRegistryGroupName = useCallback((item: RegistryGroupItem): string => {
    return item.registryEntry ? getRegistryEntryName(item.registryEntry) : item.registryId;
  }, [getRegistryEntryName]);

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
        return getServerDisplayName(item.server).toLowerCase().includes(query)
          || item.server.name.toLowerCase().includes(query)
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
    getServerDisplayName,
    installedItems,
    searchQuery,
  ]);

  const filteredMarketplace = useMemo(() => {
    const query = searchQuery.trim().replace(/\s+/g, ' ').toLowerCase();
    let entries = [...dynamicRegistry];
    if (query) {
      entries = entries.filter(e =>
        getRegistryEntryName(e).toLowerCase().includes(query)
        || e.name.toLowerCase().includes(query)
        || getRegistryEntryDescription(e).toLowerCase().includes(query)
      );
    }
    if (activeCategory !== 'all') {
      entries = entries.filter(e => e.category === activeCategory);
    }
    return entries;
  }, [searchQuery, activeCategory, dynamicRegistry, getRegistryEntryDescription, getRegistryEntryName]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) return undefined;
    const resultCount = activeTab === McpTab.Marketplace
      ? filteredMarketplace.length
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

  /**
   * Edit and delete are rare next to enabling, so they live behind the menu.
   * The menu hangs off one server's card, so the labels stay bare verbs — the
   * object is already on screen.
   */
  const buildServerMenuItems = (server: McpServerConfig): CardOverflowMenuItem[] => [
    {
      key: 'edit',
      label: i18nService.t('edit'),
      icon: <EditIcon className="h-3.5 w-3.5" />,
      onSelect: () => handleOpenEditForm(server),
    },
    ...(getOAuthPhase(server) === OAuthPhase.SignedIn
      ? [{
        key: 'oauth-sign-out',
        label: i18nService.t('mcpOAuthSignOut'),
        icon: <ArrowRightStartOnRectangleIcon className="h-3.5 w-3.5" />,
        onSelect: () => { void handleOAuthSignOut(server); },
      }]
      : []),
    {
      key: 'delete',
      label: i18nService.t('delete'),
      icon: <TrashIcon className="h-3.5 w-3.5" />,
      destructive: true,
      onSelect: () => handleRequestDelete(server),
    },
  ];

  /**
   * OpenClaw runs the OAuth flow (browser + loopback callback) and stores the
   * token; the gateway picks it up on the next request without a restart.
   */
  const handleOAuthSignIn = async (server: McpServerConfig) => {
    if (signingInServerId) return;
    setActionError('');
    setSigningInServerId(server.id);
    try {
      const result = await mcpService.oauthLogin(server.id);
      if (!result.success && result.code !== McpOAuthErrorCode.Cancelled) {
        const messageKey = OAUTH_ERROR_MESSAGE_KEYS[result.code];
        setActionError(messageKey
          ? i18nService.t(messageKey)
          : `${i18nService.t('mcpOAuthSignInFailed')}${result.error ? `: ${result.error}` : ''}`);
      }
    } finally {
      setSigningInServerId(null);
      await refreshOAuthStates();
    }
  };

  const handleOAuthCancel = (server: McpServerConfig) => {
    void mcpService.oauthCancel(server.id);
  };

  const handleOAuthSignOut = async (server: McpServerConfig) => {
    setActionError('');
    const result = await mcpService.oauthLogout(server.id);
    if (!result.success) {
      setActionError(result.code === McpOAuthErrorCode.ServerNotLoaded
        ? i18nService.t('mcpOAuthSignOutServerNotLoaded')
        : `${i18nService.t('mcpOAuthSignOutFailed')}${result.error ? `: ${result.error}` : ''}`);
    }
    await refreshOAuthStates();
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
    if (isOAuthRegistryEntry(entry)) {
      void handleInstallOAuthRegistryEntry(entry);
      return;
    }
    setEditingServer(null);
    setInstallingRegistry(entry);
    setIsFormOpen(true);
  };

  /**
   * An OAuth connector has nothing to fill in, so it installs in one click and
   * its card then offers Sign in, like a hand-added OAuth server.
   */
  const handleInstallOAuthRegistryEntry = async (entry: McpRegistryEntry) => {
    setActionError('');
    if (servers.some(server => server.name === entry.name)) {
      setActionError(i18nService.t('mcpNameExists'));
      return;
    }
    const built = buildOAuthRegistryInstallData(entry, {
      name: entry.name,
      description: getRegistryEntryDescription(entry),
    });
    if (!built.ok) {
      setActionError(i18nService.t('mcpTokenTemplateInvalid'));
      return;
    }
    const analyticsParams = { source: 'mcp_manager', activeTab, ...getFormAnalyticsParams(built.data, entry) };
    reportMcpAction('create_submit', analyticsParams);
    setConnectingRegistryId(entry.id);
    try {
      const result = await mcpService.createServer(built.data);
      if (!result.success) {
        setActionError(result.error || i18nService.t('mcpCreateFailed'));
        reportMcpAction('create_failed', { ...analyticsParams, result: 'failed', errorCode: 'create_failed' });
        return;
      }
      if (result.servers) dispatch(setMcpServers(result.servers));
      reportMcpAction('create_success', { ...analyticsParams, result: 'success' });
    } finally {
      setConnectingRegistryId(null);
    }
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
      const isRegistryInstall = installingRegistry !== null;
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
      // A hand-added server lands in Installed, so go show it. Installing from
      // the marketplace leaves the user where they were browsing.
      if (!isRegistryInstall) setActiveTab(McpTab.Installed);
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
    setActiveTab(McpTab.Installed);
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

  const getCategoryLabel = (entry: McpRegistryEntry): string => {
    const category = dynamicCategories.find(item => item.id === entry.category);
    if (category) {
      const localized = currentLanguage === 'zh' ? category.name_zh : category.name_en;
      if (localized) return localized;
      if (category.key) return i18nService.t(category.key);
    }
    return entry.categoryKey ? i18nService.t(entry.categoryKey) : entry.category;
  };

  const openServerDetail = (server: McpServerConfig) => {
    reportMcpAction('open_detail', {
      source: 'mcp_manager',
      activeTab,
      ...getServerAnalyticsParams(server, getRegistryEntryForServer(server)),
    });
    setDetailTarget({ kind: 'server', id: server.id });
  };

  const openRegistryGroupDetail = (item: RegistryGroupItem) => {
    reportMcpAction('open_detail', {
      source: 'mcp_manager',
      activeTab,
      registryId: item.registryId,
    });
    setDetailTarget({ kind: 'registryGroup', registryId: item.registryId });
  };

  const openMarketplaceDetail = (entry: McpRegistryEntry) => {
    reportMcpAction('open_detail', {
      source: 'mcp_manager',
      activeTab,
      activeCategory,
      ...getRegistryAnalyticsParams(entry),
    });
    setDetailTarget({ kind: 'marketplace', entryId: entry.id });
  };

  const closeDetail = () => setDetailTarget(null);

  const getOAuthPhase = (server: McpServerConfig): OAuthPhase | null => {
    if (!isOAuthRemoteServer(server)) return null;
    if (signingInServerId === server.id) return OAuthPhase.SigningIn;
    // Disabled servers drop out of openclaw.json, so their sign-in cannot be read or
    // changed; don't wait for the next status read to stop offering Sign out.
    if (!server.enabled) return OAuthPhase.Unknown;
    const state = oauthStates[server.id];
    if (state === McpOAuthState.Authorized) return OAuthPhase.SignedIn;
    if (state === undefined || state === McpOAuthState.Unknown) return OAuthPhase.Unknown;
    return OAuthPhase.SignedOut;
  };

  // Offered once the first status read is back, even if it failed: it is then the only way in.
  const canOAuthSignIn = (server: McpServerConfig, phase: OAuthPhase | null): boolean =>
    server.enabled
    && oauthStatusReady
    && (phase === OAuthPhase.SignedOut || phase === OAuthPhase.Unknown);

  /**
   * Sign-in state in the card's facts strip. "Not authorized" is left out while
   * the Sign in capsule beside it already says so.
   */
  const renderOAuthBadge = (server: McpServerConfig, phase: OAuthPhase | null) => {
    if (!phase || phase === OAuthPhase.Unknown) return null;
    if (phase === OAuthPhase.SignedOut && canOAuthSignIn(server, phase)) return null;
    const badge = OAUTH_PHASE_BADGES[phase];
    return (
      <span className={`${OAUTH_BADGE_BASE_CLASS} ${badge.className}`}>
        {phase === OAuthPhase.SigningIn && <ArrowPathIcon className="h-3 w-3 animate-spin" />}
        {i18nService.t(badge.labelKey)}
      </span>
    );
  };

  /**
   * Sign in with the marketplace Qichacha entry's capsule and wording, so one
   * authorization pattern covers the page. Installed cards keep their header for
   * the toggle, so there it sits at the end of the facts strip; the detail dialog
   * puts it in its header action slot. While the browser step is pending it turns
   * into Cancel (the CLI can wait for minutes) without shifting the layout.
   */
  const renderOAuthAction = (
    server: McpServerConfig,
    phase: OAuthPhase | null,
    size: 'card' | 'cardHeader' | 'detail',
  ) => {
    // In the facts strip the 26px capsule must not make the card taller than its
    // neighbours (badges are 23px), or the badge rows of a grid row stop lining up.
    const placement = size === 'card' ? 'ml-auto -my-0.5 ' : '';
    const isCardSize = size !== 'detail';
    // Distinct keys: swapping one element's classes would cross-fade the primary
    // fill into the grey Cancel capsule.
    if (phase === OAuthPhase.SigningIn) {
      return (
        <button
          key="oauth-cancel"
          type="button"
          onClick={(event) => { event.stopPropagation(); handleOAuthCancel(server); }}
          className={placement + (isCardSize ? CARD_SECONDARY_PILL_CLASS : DETAIL_SECONDARY_PILL_CLASS)}
        >
          {i18nService.t('cancel')}
        </button>
      );
    }
    if (!canOAuthSignIn(server, phase)) return null;
    return (
      <button
        key="oauth-sign-in"
        type="button"
        disabled={signingInServerId !== null}
        onClick={(event) => { event.stopPropagation(); void handleOAuthSignIn(server); }}
        className={placement + (isCardSize ? CARD_ACTION_PILL_CLASS : DETAIL_ACTION_PILL_CLASS)}
      >
        {i18nService.t('mcpOAuthSignIn')}
      </button>
    );
  };

  /**
   * A marketplace entry once installed: an OAuth connector keeps offering Sign in
   * until it is authorized, everything else just reads Installed.
   */
  const renderMarketplaceInstalledState = (entry: McpRegistryEntry, size: 'cardHeader' | 'detail') => {
    const oauthServer = isOAuthRegistryEntry(entry)
      ? servers.find(server => server.registryId === entry.id && isOAuthRemoteServer(server))
      : undefined;
    const oauthPhase = oauthServer ? getOAuthPhase(oauthServer) : null;
    const signInAction = oauthServer ? renderOAuthAction(oauthServer, oauthPhase, size) : null;
    if (signInAction) return signInAction;
    const label = i18nService.t(
      isQichachaRegistryEntry(entry) || oauthPhase === OAuthPhase.SignedIn ? 'mcpAuthorized' : 'mcpInstalled',
    );
    return size === 'cardHeader' ? (
      /* Installed is a fact, not an action — it stays quiet. */
      <span className={`inline-flex h-[26px] flex-shrink-0 items-center gap-1 px-1 ${MANAGEMENT_META_TEXT} text-muted`}>
        <CheckIcon className="h-3.5 w-3.5" />
        {label}
      </span>
    ) : (
      <span className={`inline-flex flex-shrink-0 items-center gap-1 ${MANAGEMENT_BODY_TEXT} text-muted`}>
        <CheckIcon className="h-4 w-4" />
        {label}
      </span>
    );
  };

  const getInstallActionLabel = (entry: McpRegistryEntry, isConnecting: boolean): string => {
    if (isQichachaRegistryEntry(entry)) {
      return i18nService.t(isConnecting ? 'mcpQichachaConnecting' : 'mcpQichachaConnect');
    }
    return i18nService.t(isConnecting ? 'mcpInstalling' : 'mcpInstall');
  };

  /**
   * One installed/custom server card. Both tabs show the same object, so they
   * share a renderer instead of drifting apart.
   */
  const renderServerCard = (server: McpServerConfig) => {
    const registryEntry = getRegistryEntryForServer(server);
    const launchStatusLabel = getLaunchStatusLabel(server);
    const requiredEnvKeyCount = registryEntry?.requiredEnvKeys?.length ?? 0;
    const oauthPhase = getOAuthPhase(server);
    return (
      <McpCard
        key={server.id}
        title={getServerDisplayName(server)}
        description={getInstalledDescription(server)}
        icon={getServerIcon(server)}
        onOpenDetail={() => openServerDetail(server)}
        actions={(
          <>
            <CardOverflowMenu
              className={CARD_MENU_REVEAL_CLASS}
              items={buildServerMenuItems(server)}
            />
            <CardToggle
              isOn={server.enabled}
              label={i18nService.t(server.enabled ? 'disable' : 'enable')}
              onToggle={() => handleToggleEnabled(server.id)}
            />
          </>
        )}
        meta={(
          <>
            {/* Only the hand-configured origin is labelled; from the
                marketplace is the norm. */}
            {!server.isBuiltIn && (
              <span className="shrink-0 rounded bg-primary-muted px-1.5 py-0.5 font-medium text-primary">
                {i18nService.t('mcpCustom')}
              </span>
            )}
            <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${TRANSPORT_BADGE_COLORS[server.transportType] || ''}`}>
              {server.transportType}
            </span>
            {renderOAuthBadge(server, oauthPhase)}
            {launchStatusLabel && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${getLaunchStatusClass(server)}`}
                title={server.launchResolution?.error || ''}
              >
                {launchStatusLabel}
              </span>
            )}
            {server.launchResolution?.status === 'failed' && (
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); handleRetryLaunchResolution(server.id); }}
                className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10"
              >
                {i18nService.t('mcpLaunchRetry')}
              </button>
            )}
            {requiredEnvKeyCount > 0 && (
              <>
                <span className="shrink-0 text-secondary/50">·</span>
                <span className="shrink-0 text-amber-500 dark:text-amber-400">
                  {requiredEnvKeyCount} key{requiredEnvKeyCount > 1 ? 's' : ''}
                </span>
              </>
            )}
            {renderOAuthAction(server, oauthPhase, 'card')}
          </>
        )}
      />
    );
  };

  /**
   * Listen for MCP bridge sync events from the main process.
   * Main process broadcasts syncStart/syncDone after server config changes.
   */
  const marketplaceCount = useMemo(
    () => dynamicRegistry.length,
    [dynamicRegistry]
  );

  const DETAIL_FOOTER_BUTTON_CLASS =
    `inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 ${MANAGEMENT_BODY_TEXT} text-secondary transition-colors hover:bg-surface-raised hover:text-foreground`;

  const DETAIL_FOOTER_DESTRUCTIVE_CLASS =
    `inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 ${MANAGEMENT_BODY_TEXT} text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400`;

  const renderDetailToggle = (isOn: boolean, onToggle: () => void) => (
    <div className="flex items-center gap-2.5">
      <span className={`${MANAGEMENT_BODY_TEXT} text-secondary`}>{i18nService.t('enable')}</span>
      <CardToggle
        isOn={isOn}
        label={i18nService.t(isOn ? 'disable' : 'enable')}
        onToggle={onToggle}
      />
    </div>
  );

  /** Keys only — values can hold secrets and detail is a read-only view. */
  const getKeyListValue = (record: Record<string, string> | undefined): string =>
    Object.keys(record ?? {}).join(', ');

  const renderServerDetail = (server: McpServerConfig) => {
    const registryEntry = getRegistryEntryForServer(server);
    const displayName = getServerDisplayName(server);
    const launchStatusLabel = getLaunchStatusLabel(server);
    const oauthPhase = getOAuthPhase(server);
    const stats: McpDetailStat[] = [
      {
        label: i18nService.t('mcpDetailStatus'),
        value: i18nService.t(server.enabled ? 'enabled' : 'disabled'),
      },
      { label: i18nService.t('mcpDetailTransport'), value: server.transportType },
      {
        label: i18nService.t('mcpDetailSource'),
        value: i18nService.t(server.isBuiltIn || server.registryId ? 'mcpSourceMarketplace' : 'mcpCustom'),
      },
      ...(oauthPhase && oauthPhase !== OAuthPhase.Unknown
        ? [{ label: i18nService.t('mcpDetailSignIn'), value: i18nService.t(OAUTH_PHASE_BADGES[oauthPhase].labelKey) }]
        : []),
    ];
    const info: McpDetailInfoRow[] = [];
    if (server.transportType === 'stdio' && server.command) {
      info.push({
        label: i18nService.t('mcpDetailCommand'),
        value: [server.command, ...(server.args ?? [])].join(' '),
        mono: true,
      });
    }
    // A connector with credentials may carry one in its URL; show the template instead.
    const connectorUrlTemplate = server.registryId && registryEntry?.connector?.tokenSchema
      ? registryEntry.connector.url
      : undefined;
    if (connectorUrlTemplate) {
      info.push({ label: i18nService.t('mcpDetailUrl'), value: connectorUrlTemplate, mono: true });
    } else if (server.url) {
      info.push({
        label: i18nService.t('mcpDetailUrl'),
        value: server.url,
        mono: true,
        onSelect: () => window.electron.shell.openExternal(server.url as string),
      });
    }
    const envKeys = getKeyListValue(server.env);
    if (envKeys) info.push({ label: i18nService.t('mcpDetailEnvKeys'), value: envKeys, mono: true });
    const headerKeys = getKeyListValue(server.headers);
    if (headerKeys) info.push({ label: i18nService.t('mcpDetailHeaders'), value: headerKeys, mono: true });
    if (oauthPhase) info.push({ label: i18nService.t('mcpAuthMode'), value: i18nService.t('mcpAuthOAuth') });
    if (server.toolFilter) {
      info.push({ label: i18nService.t('mcpDetailTools'), value: describeMcpToolFilter(server.toolFilter) });
    }
    if (launchStatusLabel) {
      info.push({
        label: i18nService.t('mcpDetailLaunch'),
        value: server.launchResolution?.error
          ? `${launchStatusLabel} · ${server.launchResolution.error}`
          : launchStatusLabel,
      });
    }
    info.push({ label: i18nService.t('mcpDetailId'), value: server.id, mono: true });

    return (
      <McpDetailModal
        title={displayName}
        subtitle={displayName === server.name ? undefined : server.name}
        icon={registryEntry?.icon}
        description={getInstalledDescription(server)}
        stats={stats}
        info={info}
        examples={registryEntry ? getRegistryEntryExamples(registryEntry, currentLanguage) : undefined}
        onClose={closeDetail}
        action={renderOAuthAction(server, oauthPhase, 'detail')}
        footer={(
          <>
            {renderDetailToggle(server.enabled, () => handleToggleEnabled(server.id))}
            <div className="flex items-center gap-1">
              {oauthPhase === OAuthPhase.SignedIn && (
                <button
                  type="button"
                  onClick={() => { void handleOAuthSignOut(server); }}
                  className={DETAIL_FOOTER_BUTTON_CLASS}
                >
                  <ArrowRightStartOnRectangleIcon className="h-4 w-4" />
                  {i18nService.t('mcpOAuthSignOut')}
                </button>
              )}
              <button
                type="button"
                onClick={() => { closeDetail(); handleOpenEditForm(server); }}
                className={DETAIL_FOOTER_BUTTON_CLASS}
              >
                <EditIcon className="h-4 w-4" />
                {i18nService.t('edit')}
              </button>
              <button
                type="button"
                onClick={() => { closeDetail(); handleRequestDelete(server); }}
                className={DETAIL_FOOTER_DESTRUCTIVE_CLASS}
              >
                <TrashIcon className="h-4 w-4" />
                {i18nService.t('delete')}
              </button>
            </div>
          </>
        )}
      />
    );
  };

  const renderRegistryGroupDetail = (item: RegistryGroupItem) => {
    const groupName = getRegistryGroupName(item);
    const groupTransportType = getRegistryGroupTransportType(item);
    const groupEnabled = item.servers.some(server => server.enabled);
    const stats: McpDetailStat[] = [
      {
        label: i18nService.t('mcpDetailStatus'),
        value: i18nService.t(groupEnabled ? 'enabled' : 'disabled'),
      },
      ...(groupTransportType
        ? [{ label: i18nService.t('mcpDetailTransport'), value: groupTransportType }]
        : []),
      { label: i18nService.t('mcpDetailServers'), value: String(item.servers.length) },
    ];
    const info: McpDetailInfoRow[] = [];
    const groupSummary = getRegistryGroupSummary(item);
    if (groupSummary) {
      info.push({ label: i18nService.t('mcpDetailCommand'), value: groupSummary, mono: true });
    }
    info.push({
      label: i18nService.t('mcpDetailIncluded'),
      value: item.servers.map(server => server.name).join(', '),
    });
    info.push({ label: i18nService.t('mcpDetailId'), value: item.registryId, mono: true });

    return (
      <McpDetailModal
        title={groupName}
        icon={item.registryEntry?.icon}
        description={getRegistryGroupDescription(item)}
        stats={stats}
        info={info}
        onClose={closeDetail}
        footer={(
          <>
            {renderDetailToggle(groupEnabled, () => handleToggleRegistryEnabled(
              item.registryId,
              item.servers,
              item.registryEntry,
            ))}
            <button
              type="button"
              onClick={() => {
                closeDetail();
                handleRequestDeleteRegistry(item.registryId, groupName, item.servers, item.registryEntry);
              }}
              className={DETAIL_FOOTER_DESTRUCTIVE_CLASS}
            >
              <TrashIcon className="h-4 w-4" />
              {i18nService.t('mcpUninstall')}
            </button>
          </>
        )}
      />
    );
  };

  const renderMarketplaceDetail = (entry: McpRegistryEntry) => {
    const isInstalled = installedRegistryIds.has(entry.id);
    const isConnecting = connectingRegistryId === entry.id;
    const installedServers = servers.filter(server => server.registryId === entry.id);
    const requiredKeyCount = getRegistryEntryRequiredKeyCount(entry);
    const tokenFields = entry.connector?.tokenSchema?.fields ?? [];
    const getTokenFieldLabels = (required: boolean): string => tokenFields
      .filter(field => field.required === required)
      .map(field => pickMcpConnectorText(currentLanguage, field.label, field.label_en))
      .join(', ');
    const stats: McpDetailStat[] = [
      { label: i18nService.t('mcpDetailCategory'), value: getCategoryLabel(entry) },
      { label: i18nService.t('mcpDetailTransport'), value: entry.transportType },
      ...(requiredKeyCount > 0
        ? [{
          label: i18nService.t('mcpDetailRequiredKeys'),
          value: String(requiredKeyCount),
        }]
        : []),
    ];
    const info: McpDetailInfoRow[] = [];
    const command = getStdioCommandSummary(entry.command, entry.defaultArgs);
    if (entry.connector?.url) {
      info.push({ label: i18nService.t('mcpDetailUrl'), value: entry.connector.url, mono: true });
      if (isOAuthRegistryEntry(entry)) {
        info.push({ label: i18nService.t('mcpAuthMode'), value: i18nService.t('mcpAuthOAuth') });
      }
      const requiredFieldLabels = getTokenFieldLabels(true);
      if (requiredFieldLabels) info.push({ label: i18nService.t('mcpDetailRequiredKeys'), value: requiredFieldLabels });
      const optionalFieldLabels = getTokenFieldLabels(false);
      if (optionalFieldLabels) info.push({ label: i18nService.t('mcpDetailOptionalKeys'), value: optionalFieldLabels });
    } else if (command) {
      info.push({
        label: i18nService.t(entry.transportType === 'stdio' ? 'mcpDetailCommand' : 'mcpDetailUrl'),
        value: entry.transportType === 'stdio'
          ? [entry.command, ...(entry.defaultArgs ?? [])].join(' ')
          : command,
        mono: true,
      });
    }
    if (entry.requiredEnvKeys && entry.requiredEnvKeys.length > 0) {
      info.push({
        label: i18nService.t('mcpDetailRequiredKeys'),
        value: entry.requiredEnvKeys.join(', '),
        mono: true,
      });
    }
    if (entry.optionalEnvKeys && entry.optionalEnvKeys.length > 0) {
      info.push({
        label: i18nService.t('mcpDetailOptionalKeys'),
        value: entry.optionalEnvKeys.join(', '),
        mono: true,
      });
    }
    info.push({ label: i18nService.t('mcpDetailId'), value: entry.id, mono: true });

    return (
      <McpDetailModal
        title={getRegistryEntryName(entry)}
        icon={entry.icon}
        description={getRegistryEntryDescription(entry)}
        stats={stats}
        info={info}
        examples={getRegistryEntryExamples(entry, currentLanguage)}
        onClose={closeDetail}
        action={isInstalled ? renderMarketplaceInstalledState(entry, 'detail') : (
          <button
            type="button"
            onClick={() => {
              // One-click installs stay in the dialog so its header can offer Sign in next.
              if (!isOAuthRegistryEntry(entry)) closeDetail();
              handleInstallFromRegistry(entry);
            }}
            disabled={isConnecting}
            className={DETAIL_ACTION_PILL_CLASS}
          >
            {getInstallActionLabel(entry, isConnecting)}
          </button>
        )}
        footer={isInstalled && installedServers.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              closeDetail();
              handleRequestDeleteRegistry(
                entry.id,
                getRegistryEntryName(entry),
                installedServers,
                entry,
              );
            }}
            className={DETAIL_FOOTER_DESTRUCTIVE_CLASS}
          >
            <TrashIcon className="h-4 w-4" />
            {i18nService.t('mcpUninstall')}
          </button>
        ) : undefined}
      />
    );
  };

  /** The dialog reads live state by id, so toggling inside it stays in sync. */
  const renderDetailModal = () => {
    if (!detailTarget) return null;
    if (detailTarget.kind === 'server') {
      const server = servers.find(item => item.id === detailTarget.id);
      return server ? renderServerDetail(server) : null;
    }
    if (detailTarget.kind === 'registryGroup') {
      const group = installedItems.find(
        (item): item is RegistryGroupItem =>
          item.kind === 'registryGroup' && item.registryId === detailTarget.registryId,
      );
      return group ? renderRegistryGroupDetail(group) : null;
    }
    const entry = dynamicRegistry.find(item => item.id === detailTarget.entryId);
    return entry ? renderMarketplaceDetail(entry) : null;
  };

  const tabClass = (tab: McpTab) =>
    `relative px-2.5 pb-2.5 pt-0.5 ${MANAGEMENT_TITLE_TEXT} font-semibold transition-colors ${
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
      <div className="pb-2">
        <p className={`${MANAGEMENT_BODY_TEXT} text-secondary`}>
          {i18nService.t('mcpDescription')}
        </p>
      </div>

      {actionError && (
        <ErrorMessage
          message={actionError}
          onClose={() => setActionError('')}
        />
      )}

      {/* Sticky toolbar: Search + Tabs + Category pills */}
      <div
        data-skin-management-toolbar="true"
        className="sticky top-0 z-10 space-y-4 bg-background pb-2"
      >
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
                    resultCount: activeTab === McpTab.Marketplace
                      ? filteredMarketplace.length
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
          {/* Adding a server by hand is an action, not a place to browse. */}
          <button
            type="button"
            onClick={handleOpenCreateForm}
            className="px-3 py-2 text-sm rounded-xl border transition-colors bg-surface border-border text-foreground hover:bg-surface-raised flex items-center gap-2"
          >
            <PlusCircleIcon className="h-4 w-4" />
            <span>{i18nService.t('mcpAddServer')}</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center border-b border-border">
          {MCP_TAB_ORDER.map((tab) => {
            const count = tab === McpTab.Installed
              ? installedItems.length
              : (isLoadingMarketplace ? 0 : marketplaceCount);
            return (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  reportMcpAction('tab_change', {
                    source: 'mcp_manager',
                    activeTab,
                    targetTab: tab,
                  });
                  setActiveTab(tab);
                }}
                className={tabClass(tab)}
              >
                {i18nService.t(MCP_TAB_LABEL_KEYS[tab])}
                {count > 0 && (
                  <span className={`ml-1.5 rounded-full bg-surface-raised px-1.5 py-0.5 ${MANAGEMENT_META_TEXT} font-medium text-secondary`}>
                    {count}
                  </span>
                )}
                <div className={tabIndicatorClass(tab)} />
              </button>
            );
          })}
        </div>

        {/* Category filter pills (Marketplace only) */}
        {activeTab === McpTab.Marketplace && !isLoadingMarketplace && (
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
      {activeTab === McpTab.Installed && (
        filteredInstalled.length === 0 ? (
          searchQuery.trim() ? (
            <div className="py-12 text-center text-sm text-secondary">
              {i18nService.t('mcpNoInstalledServers')}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
              <p className="mb-3 text-sm text-secondary">
                {i18nService.t('mcpInstalledEmptyHint')}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    reportMcpAction('tab_change', {
                      source: 'mcp_manager',
                      activeTab,
                      targetTab: McpTab.Marketplace,
                    });
                    setActiveTab(McpTab.Marketplace);
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-raised"
                >
                  {i18nService.t('mcpInstalledEmptyMarket')}
                </button>
                <button
                  type="button"
                  onClick={handleOpenCreateForm}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-raised"
                >
                  <PlusCircleIcon className="h-3.5 w-3.5 text-secondary" />
                  {i18nService.t('mcpAddServer')}
                </button>
              </div>
            </div>
          )
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {filteredInstalled.map((item) => {
              if (item.kind === 'registryGroup') {
                const groupName = getRegistryGroupName(item);
                const groupDescription = getRegistryGroupDescription(item);
                const groupTransportType = getRegistryGroupTransportType(item);
                const groupEnabled = item.servers.some(server => server.enabled);
                return (
                  <McpCard
                    key={item.id}
                    title={groupName}
                    description={groupDescription}
                    icon={item.registryEntry?.icon}
                    onOpenDetail={() => openRegistryGroupDetail(item)}
                    actions={(
                      <>
                        <CardOverflowMenu
                          className={CARD_MENU_REVEAL_CLASS}
                          items={[{
                            key: 'uninstall',
                            label: i18nService.t('mcpUninstall'),
                            icon: <TrashIcon className="h-3.5 w-3.5" />,
                            destructive: true,
                            onSelect: () => handleRequestDeleteRegistry(
                              item.registryId,
                              groupName,
                              item.servers,
                              item.registryEntry,
                            ),
                          }]}
                        />
                        <CardToggle
                          isOn={groupEnabled}
                          label={i18nService.t(groupEnabled ? 'disable' : 'enable')}
                          onToggle={() => handleToggleRegistryEnabled(
                            item.registryId,
                            item.servers,
                            item.registryEntry,
                          )}
                        />
                      </>
                    )}
                    meta={(
                      <>
                        {groupTransportType && (
                          <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${TRANSPORT_BADGE_COLORS[groupTransportType] || ''}`}>
                            {groupTransportType}
                          </span>
                        )}
                        <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-medium">
                          {i18nService.t('mcpServersCount').replace('{count}', String(item.servers.length))}
                        </span>
                      </>
                    )}
                  />
                );
              }
              return renderServerCard(item.server);
            })}
          </div>
        )
      )}

      {/* ── Tab: Marketplace ────────────────────────────── */}
      {activeTab === McpTab.Marketplace && (
        isLoadingMarketplace ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="animate-pulse rounded-2xl border border-border bg-surface p-4">
              <div className="mb-3 flex items-center gap-2.5">
                <div className="h-10 w-10 rounded-[10px] bg-surface-raised" />
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
        <div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {filteredMarketplace.length === 0 ? (
              <div className="col-span-full text-center py-12 text-sm text-secondary">
                {i18nService.t('noMcpServersAvailable')}
              </div>
            ) : (
              filteredMarketplace.map((entry) => {
                const isInstalled = installedRegistryIds.has(entry.id);
                const isConnecting = connectingRegistryId === entry.id;
                const requiredEnvKeyCount = getRegistryEntryRequiredKeyCount(entry);
                return (
                  <McpCard
                    key={entry.id}
                    title={getRegistryEntryName(entry)}
                    description={getRegistryEntryDescription(entry)}
                    icon={entry.icon}
                    onOpenDetail={() => openMarketplaceDetail(entry)}
                    actions={isInstalled ? renderMarketplaceInstalledState(entry, 'cardHeader') : (
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); handleInstallFromRegistry(entry); }}
                        disabled={isConnecting}
                        className={CARD_ACTION_PILL_CLASS}
                      >
                        {getInstallActionLabel(entry, isConnecting)}
                      </button>
                    )}
                    meta={(
                      <>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${TRANSPORT_BADGE_COLORS[entry.transportType] || ''}`}>
                          {entry.transportType}
                        </span>
                        <span className="shrink-0 text-secondary/50">·</span>
                        <span className="min-w-0 truncate">{getRegistryEntryEndpointSummary(entry)}</span>
                        {requiredEnvKeyCount > 0 && (
                          <>
                            <span className="shrink-0 text-secondary/50">·</span>
                            <span className="shrink-0 text-amber-500 dark:text-amber-400">
                              {requiredEnvKeyCount} key{requiredEnvKeyCount > 1 ? 's' : ''}
                            </span>
                          </>
                        )}
                        {isOAuthRegistryEntry(entry) && (
                          <>
                            <span className="shrink-0 text-secondary/50">·</span>
                            <span className="shrink-0">{i18nService.t('mcpAuthOAuth')}</span>
                          </>
                        )}
                      </>
                    )}
                  />
                );
              })
            )}
          </div>
        </div>
        )
      )}

      </div>

      {renderDetailModal()}

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
