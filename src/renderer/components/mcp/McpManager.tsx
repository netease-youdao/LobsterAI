import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import SearchIcon from '../icons/SearchIcon';
import TrashIcon from '../icons/TrashIcon';
import PencilIcon from '../icons/PencilIcon';
import ConnectorIcon from '../icons/ConnectorIcon';
import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import { setMcpServers } from '../../store/slices/mcpSlice';
import { RootState } from '../../store';
import { McpServerConfig, McpServerFormData, McpRegistryEntry, McpMarketplaceCategoryInfo } from '../../types/mcp';
import { mcpRegistry, mcpCategories } from '../../data/mcpRegistry';
import ErrorMessage from '../ErrorMessage';
import Tooltip from '../ui/Tooltip';
import McpServerFormModal from './McpServerFormModal';
import Modal from '../common/Modal';

const TRANSPORT_BADGE_COLORS: Record<string, string> = {
  stdio: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  sse: 'bg-green-500/10 text-green-600 dark:text-green-400',
  http: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
};

type McpTab = 'installed' | 'marketplace' | 'custom';

const McpManager: React.FC = () => {
  const dispatch = useDispatch();
  const servers = useSelector((state: RootState) => state.mcp.servers);

  const [activeTab, setActiveTab] = useState<McpTab>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<McpServerConfig | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [installingRegistry, setInstallingRegistry] = useState<McpRegistryEntry | null>(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [dynamicRegistry, setDynamicRegistry] = useState<McpRegistryEntry[]>(mcpRegistry);
  const [dynamicCategories, setDynamicCategories] = useState<ReadonlyArray<{ id: string; key: string; name_zh?: string; name_en?: string }>>(mcpCategories);
  const [bridgeSyncing, setBridgeSyncing] = useState(false);
  const [bridgeSyncResult, setBridgeSyncResult] = useState<{ tools: number; error?: string } | null>(null);
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
    let isActive = true;
    const fetchMarketplace = async () => {
      const result = await mcpService.fetchMarketplace();
      if (!isActive || !result) return;
      setDynamicRegistry(result.registry);
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

  const getRegistryEntryDescription = (entry: McpRegistryEntry): string => {
    const remoteDescription = currentLanguage === 'zh' ? entry.description_zh : entry.description_en;
    if (remoteDescription) return remoteDescription;
    if (entry.descriptionKey) return i18nService.t(entry.descriptionKey);
    return '';
  };

  const getStdioCommandSummary = (command?: string, args?: string[]): string => {
    if (!command) return '';
    if (!args || args.length === 0) return command;
    return `${command} ${args[args.length - 1]}`;
  };

  const getRegistryEntryForServer = (server: McpServerConfig): McpRegistryEntry | undefined => {
    if (server.registryId) {
      return dynamicRegistry.find(entry => entry.id === server.registryId);
    }
    if (!server.isBuiltIn) return undefined;
    return dynamicRegistry.find((entry) => (
      entry.name.toLowerCase() === server.name.toLowerCase()
      && entry.transportType === server.transportType
      && entry.command === server.command
    ));
  };

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

  const getInstalledDescription = (server: McpServerConfig): string => {
    const persistedDescription = server.description?.trim();
    if (persistedDescription) return persistedDescription;
    const registryEntry = getRegistryEntryForServer(server);
    if (registryEntry) {
      const registryDescription = getRegistryEntryDescription(registryEntry).trim();
      if (registryDescription) return registryDescription;
    }
    return getTransportSummary(server);
  };

  const filteredInstalled = useMemo(() => {
    const query = searchQuery.toLowerCase();
    if (!query) return servers;
    return servers.filter(server =>
      server.name.toLowerCase().includes(query)
      || getInstalledDescription(server).toLowerCase().includes(query)
    );
  }, [servers, searchQuery, dynamicRegistry, currentLanguage]);

  const filteredCustom = useMemo(() => {
    const custom = servers.filter(s => !s.isBuiltIn);
    const query = searchQuery.toLowerCase();
    if (!query) return custom;
    return custom.filter(s =>
      s.name.toLowerCase().includes(query)
      || s.description.toLowerCase().includes(query)
    );
  }, [servers, searchQuery]);

  const filteredMarketplace = useMemo(() => {
    const query = searchQuery.toLowerCase();
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
  }, [searchQuery, activeCategory, dynamicRegistry, currentLanguage]);

  const handleToggleEnabled = async (serverId: string) => {
    const targetServer = servers.find(s => s.id === serverId);
    if (!targetServer) return;
    try {
      const updatedServers = await mcpService.setServerEnabled(serverId, !targetServer.enabled);
      dispatch(setMcpServers(updatedServers));
      setActionError('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('mcpUpdateFailed'));
    }
  };

  const handleRequestDelete = (server: McpServerConfig) => {
    setActionError('');
    setPendingDelete(server);
  };

  const handleCancelDelete = () => {
    if (isDeleting) return;
    setPendingDelete(null);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || isDeleting) return;
    setIsDeleting(true);
    setActionError('');
    const result = await mcpService.deleteServer(pendingDelete.id);
    if (!result.success) {
      setActionError(result.error || i18nService.t('mcpDeleteFailed'));
      setIsDeleting(false);
      return;
    }
    if (result.servers) {
      dispatch(setMcpServers(result.servers));
    }
    setIsDeleting(false);
    setPendingDelete(null);
  };

  const handleOpenEditForm = (server: McpServerConfig) => {
    setEditingServer(server);
    setInstallingRegistry(null);
    setIsFormOpen(true);
  };

  const handleInstallFromRegistry = (entry: McpRegistryEntry) => {
    setEditingServer(null);
    setInstallingRegistry(entry);
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingServer(null);
    setInstallingRegistry(null);
  };

  const handleSaveForm = async (data: McpServerFormData) => {
    setActionError('');
    if (editingServer && editingServer.id) {
      const result = await mcpService.updateServer(editingServer.id, data);
      if (!result.success) {
        setActionError(result.error || i18nService.t('mcpUpdateFailed'));
        return;
      }
      if (result.servers) {
        dispatch(setMcpServers(result.servers));
      }
    } else {
      const result = await mcpService.createServer(data);
      if (!result.success) {
        setActionError(result.error || i18nService.t('mcpCreateFailed'));
        return;
      }
      if (result.servers) {
        dispatch(setMcpServers(result.servers));
      }
    }
    handleCloseForm();
  };

  const handleOpenCreateForm = () => {
    setEditingServer(null);
    setInstallingRegistry(null);
    setIsFormOpen(true);
  };

  const existingNames = useMemo(() => servers.map(s => s.name), [servers]);

  /**
   * Listen for MCP bridge sync events from the main process.
   * Main process broadcasts syncStart/syncDone after server config changes.
   */
  useEffect(() => {
    let syncTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanupStart = mcpService.onBridgeSyncStart(() => {
      setBridgeSyncing(true);
      setBridgeSyncResult(null);
      // Fallback: auto-clear overlay after 40s to prevent permanent lock
      if (syncTimeout) clearTimeout(syncTimeout);
      syncTimeout = setTimeout(() => {
        setBridgeSyncing(false);
        setBridgeSyncResult({ tools: 0, error: i18nService.t('mcpBridgeSyncError') || 'Sync timed out' });
      }, 40_000);
    });
    const cleanupDone = mcpService.onBridgeSyncDone((data) => {
      if (syncTimeout) { clearTimeout(syncTimeout); syncTimeout = null; }
      setBridgeSyncing(false);
      setBridgeSyncResult({ tools: data.tools, error: data.error });
      if (!data.error) {
        setTimeout(() => setBridgeSyncResult(null), 5000);
      }
    });
    return () => {
      cleanupStart();
      cleanupDone();
      if (syncTimeout) clearTimeout(syncTimeout);
    };
  }, []);

  const marketplaceCount = useMemo(
    () => dynamicRegistry.length,
    [dynamicRegistry]
  );

  const customCount = useMemo(
    () => servers.filter(s => !s.isBuiltIn).length,
    [servers]
  );

  const tabClass = (tab: McpTab) =>
    `px-4 py-2 text-sm font-medium transition-colors relative ${
      activeTab === tab
        ? 'text-foreground'
        : 'text-secondary hover:hover:text-foreground'
    }`;

  const tabIndicatorClass = (tab: McpTab) =>
    `absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
      activeTab === tab ? 'bg-primary' : 'bg-transparent'
    }`;

  return (
    <div className="relative space-y-4">
      {/* Sync overlay — blocks ALL interaction (including sidebar) while MCP bridge is refreshing */}
      {bridgeSyncing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-4 px-10 py-8 rounded-2xl bg-surface border border-border shadow-card">
            <svg className="animate-spin h-8 w-8 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm text-foreground font-medium">
              {i18nService.t('mcpBridgeSyncing') || 'Syncing MCP tools...'}
            </span>
          </div>
        </div>
      )}
      {/* Description */}
      <p className="text-sm text-secondary">
        {i18nService.t('mcpDescription')}
      </p>

      {actionError && (
        <ErrorMessage
          message={actionError}
          onClose={() => setActionError('')}
        />
      )}

      {/* MCP Bridge sync result */}
      {!bridgeSyncing && bridgeSyncResult && (
        <div className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs border ${
          bridgeSyncResult.error
            ? 'dark:bg-red-500/10 bg-red-50 dark:text-red-400 text-red-600 dark:border-red-500/20 border-red-200'
            : 'dark:bg-green-500/10 bg-green-50 dark:text-green-400 text-green-600 dark:border-green-500/20 border-green-200'
        }`}>
          <span>
            {bridgeSyncResult.error
              ? `${i18nService.t('mcpBridgeSyncError') || 'Sync failed'}: ${bridgeSyncResult.error}`
              : `${i18nService.t('mcpBridgeSyncDone') || 'MCP tools synced'}: ${bridgeSyncResult.tools} ${bridgeSyncResult.tools === 1 ? 'tool' : 'tools'}`
            }
          </span>
          <button
            type="button"
            onClick={() => setBridgeSyncResult(null)}
            className="ml-2 opacity-60 hover:opacity-100"
          >
            &times;
          </button>
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
          <input
            type="text"
            placeholder={i18nService.t('searchMcpServers')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b border-border">
        <button type="button" onClick={() => setActiveTab('installed')} className={tabClass('installed')}>
          {i18nService.t('mcpInstalled')}
          {servers.length > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-surface-raised">
              {servers.length}
            </span>
          )}
          <div className={tabIndicatorClass('installed')} />
        </button>
        <button type="button" onClick={() => setActiveTab('marketplace')} className={tabClass('marketplace')}>
          {i18nService.t('mcpMarketplace')}
          {marketplaceCount > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-surface-raised">
              {marketplaceCount}
            </span>
          )}
          <div className={tabIndicatorClass('marketplace')} />
        </button>
        <button type="button" onClick={() => setActiveTab('custom')} className={tabClass('custom')}>
          {i18nService.t('mcpCustom')}
          {customCount > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-surface-raised">
              {customCount}
            </span>
          )}
          <div className={tabIndicatorClass('custom')} />
        </button>
      </div>

      <div>
      {/* ── Tab: Installed ──────────────────────────────── */}
      {activeTab === 'installed' && (
        <div className="grid grid-cols-2 gap-3">
          {filteredInstalled.length === 0 ? (
            <div className="col-span-2 text-center py-12 text-sm text-secondary">
              {i18nService.t('mcpNoInstalledServers')}
            </div>
          ) : (
            filteredInstalled.map((server) => {
              const registryEntry = getRegistryEntryForServer(server);
              const installedDescription = getInstalledDescription(server);
              return (
                <div
                  key={server.id}
                  className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
                        <ConnectorIcon className="h-4 w-4 text-secondary" />
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
                        <PencilIcon className="h-3.5 w-3.5" />
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
                          server.enabled ? 'bg-primary' : 'bg-border'
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

                  <Tooltip
                    content={installedDescription}
                    position="bottom"
                    maxWidth="360px"
                    className="block w-full"
                  >
                    <p className="text-xs text-secondary line-clamp-2 mb-2">
                      {installedDescription}
                    </p>
                  </Tooltip>

                  <div className="flex items-center gap-2 text-[10px] text-secondary">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${TRANSPORT_BADGE_COLORS[server.transportType] || ''}`}>
                      {server.transportType}
                    </span>
                    {server.transportType === 'stdio' && server.command && (
                      <>
                        <span>·</span>
                        <span className="truncate">{getStdioCommandSummary(server.command, server.args)}</span>
                      </>
                    )}
                    {(server.transportType === 'sse' || server.transportType === 'http') && server.url && (
                      <>
                        <span>·</span>
                        <span className="truncate">{server.url}</span>
                      </>
                    )}
                    {registryEntry?.requiredEnvKeys && registryEntry.requiredEnvKeys.length > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-amber-500 dark:text-amber-400">
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
          {/* Category filter pills */}
          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
            {dynamicCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveCategory(cat.id)}
                className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                  activeCategory === cat.id
                    ? 'bg-primary text-white'
                    : 'bg-surface text-secondary hover:bg-surface-raised border border-border'
                }`}
              >
                {(i18nService.getLanguage() === 'zh' ? cat.name_zh : cat.name_en) || i18nService.t(cat.key)}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {filteredMarketplace.length === 0 ? (
              <div className="col-span-2 text-center py-12 text-sm text-secondary">
                {i18nService.t('noMcpServersAvailable')}
              </div>
            ) : (
              filteredMarketplace.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
                        <ConnectorIcon className="h-4 w-4 text-secondary" />
                      </div>
                      <span className="text-sm font-medium text-foreground truncate">
                        {entry.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {installedRegistryIds.has(entry.id) ? (
                        <span className="px-2.5 py-1 text-xs rounded-lg bg-surface text-secondary">
                          {i18nService.t('mcpInstalled')}
                        </span>
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

                  <p className="text-xs text-secondary line-clamp-2 mb-2">
                    {getRegistryEntryDescription(entry)}
                  </p>

                  <div className="flex items-center gap-2 text-[10px] text-secondary">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${TRANSPORT_BADGE_COLORS[entry.transportType] || ''}`}>
                      {entry.transportType}
                    </span>
                    <span>·</span>
                    <span className="truncate">{getStdioCommandSummary(entry.command, entry.defaultArgs)}</span>
                    {entry.requiredEnvKeys && entry.requiredEnvKeys.length > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-amber-500 dark:text-amber-400">
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
          {/* Custom servers grid (add button + server cards) */}
          <div className="grid grid-cols-2 gap-3">
            {/* Add custom server card */}
            <button
              type="button"
              onClick={handleOpenCreateForm}
              className="rounded-xl border-2 border-dashed border-border text-secondary hover:border-primary hover:text-primary dark:hover:border-primary dark:hover:text-primary transition-colors flex items-center justify-center min-h-[120px] text-sm"
            >
              + {i18nService.t('addMcpServer')}
            </button>
            {filteredCustom.map((server) => (
                <div
                  key={server.id}
                  className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
                        <ConnectorIcon className="h-4 w-4 text-secondary" />
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
                        <PencilIcon className="h-3.5 w-3.5" />
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
                          server.enabled ? 'bg-primary' : 'bg-border'
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

                  <Tooltip
                    content={server.description || getTransportSummary(server)}
                    position="bottom"
                    maxWidth="360px"
                    className="block w-full"
                  >
                    <p className="text-xs text-secondary line-clamp-2 mb-2">
                      {server.description || getTransportSummary(server)}
                    </p>
                  </Tooltip>

                  <div className="flex items-center gap-2 text-[10px] text-secondary">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${TRANSPORT_BADGE_COLORS[server.transportType] || ''}`}>
                      {server.transportType}
                    </span>
                    {server.transportType === 'stdio' && server.command && (
                      <>
                        <span>·</span>
                        <span className="truncate">{server.command}</span>
                      </>
                    )}
                    {(server.transportType === 'sse' || server.transportType === 'http') && server.url && (
                      <>
                        <span>·</span>
                        <span className="truncate">{server.url}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
      </div>

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <Modal onClose={handleCancelDelete} overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60" className="w-full max-w-sm mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5">
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('deleteMcpServer')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('mcpDeleteConfirm').replace('{name}', pendingDelete.name)}
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
      />
    </div>
  );
};

export default McpManager;
