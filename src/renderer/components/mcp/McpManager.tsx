import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  MagnifyingGlassIcon,
  TrashIcon,
  PencilIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import ConnectorIcon from '../icons/ConnectorIcon';
import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import { setMcpServers } from '../../store/slices/mcpSlice';
import { RootState } from '../../store';
import { McpServerConfig, McpServerFormData, McpRegistryEntry } from '../../types/mcp';
import { mcpRegistry, mcpCategories } from '../../data/mcpRegistry';
import ErrorMessage from '../ErrorMessage';
import Tooltip from '../ui/Tooltip';
import McpServerFormModal from './McpServerFormModal';

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

  const installedRegistryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of servers) {
      if (s.registryId) ids.add(s.registryId);
    }
    return ids;
  }, [servers]);

  const filteredInstalled = useMemo(() => {
    const query = searchQuery.toLowerCase();
    if (!query) return servers;
    return servers.filter(server =>
      server.name.toLowerCase().includes(query)
      || server.description.toLowerCase().includes(query)
    );
  }, [servers, searchQuery]);

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
    let entries = mcpRegistry.filter(e => !installedRegistryIds.has(e.id));
    if (query) {
      entries = entries.filter(e =>
        e.name.toLowerCase().includes(query)
        || i18nService.t(e.descriptionKey).toLowerCase().includes(query)
      );
    }
    if (activeCategory !== 'all') {
      entries = entries.filter(e => e.category === activeCategory);
    }
    return entries;
  }, [installedRegistryIds, searchQuery, activeCategory]);

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

  const handleOpenGithub = (url: string) => {
    window.electron.shell.openExternal(url);
  };

  const existingNames = useMemo(() => servers.map(s => s.name), [servers]);

  const marketplaceCount = useMemo(
    () => mcpRegistry.filter(e => !installedRegistryIds.has(e.id)).length,
    [installedRegistryIds]
  );

  const customCount = useMemo(
    () => servers.filter(s => !s.isBuiltIn).length,
    [servers]
  );

  const tabClass = (tab: McpTab) =>
    `px-4 py-2 text-sm font-medium transition-colors relative ${
      activeTab === tab
        ? 'dark:text-claude-darkText text-claude-text'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
    }`;

  const tabIndicatorClass = (tab: McpTab) =>
    `absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
      activeTab === tab ? 'bg-claude-accent' : 'bg-transparent'
    }`;

  return (
    <div className="space-y-4">
      {/* Description */}
      <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('mcpDescription')}
      </p>

      {actionError && (
        <ErrorMessage
          message={actionError}
          onClose={() => setActionError('')}
        />
      )}

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <input
            type="text"
            placeholder={i18nService.t('searchMcpServers')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b dark:border-claude-darkBorder border-claude-border">
        <button type="button" onClick={() => setActiveTab('installed')} className={tabClass('installed')}>
          {i18nService.t('mcpInstalled')}
          {servers.length > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
              {servers.length}
            </span>
          )}
          <div className={tabIndicatorClass('installed')} />
        </button>
        <button type="button" onClick={() => setActiveTab('marketplace')} className={tabClass('marketplace')}>
          {i18nService.t('mcpMarketplace')}
          {marketplaceCount > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
              {marketplaceCount}
            </span>
          )}
          <div className={tabIndicatorClass('marketplace')} />
        </button>
        <button type="button" onClick={() => setActiveTab('custom')} className={tabClass('custom')}>
          {i18nService.t('mcpCustom')}
          {customCount > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
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
            <div className="col-span-2 text-center py-12 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('mcpNoInstalledServers')}
            </div>
          ) : (
            filteredInstalled.map((server) => (
              <div
                key={server.id}
                className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
                      <ConnectorIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                    </div>
                    <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                      {server.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {server.githubUrl && (
                      <button
                        type="button"
                        onClick={() => handleOpenGithub(server.githubUrl!)}
                        className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
                        title={i18nService.t('mcpViewOnGithub')}
                      >
                        <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleOpenEditForm(server)}
                      className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
                      title={i18nService.t('editMcpServer')}
                    >
                      <PencilIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRequestDelete(server)}
                      className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      title={i18nService.t('deleteMcpServer')}
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                    <div
                      className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                        server.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
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
                  <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                    {server.description || getTransportSummary(server)}
                  </p>
                </Tooltip>

                <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
            ))
          )}
        </div>
      )}

      {/* ── Tab: Marketplace ────────────────────────────── */}
      {activeTab === 'marketplace' && (
        <div>
          {/* Category filter pills */}
          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
            {mcpCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveCategory(cat.id)}
                className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                  activeCategory === cat.id
                    ? 'bg-claude-accent text-white'
                    : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover border dark:border-claude-darkBorder border-claude-border'
                }`}
              >
                {i18nService.t(cat.key)}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {filteredMarketplace.length === 0 ? (
              <div className="col-span-2 text-center py-12 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('noMcpServersAvailable')}
              </div>
            ) : (
              filteredMarketplace.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
                        <ConnectorIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                      </div>
                      <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                        {entry.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleOpenGithub(entry.githubUrl)}
                        className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
                        title={i18nService.t('mcpViewOnGithub')}
                      >
                        <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleInstallFromRegistry(entry)}
                        className="px-2.5 py-1 text-xs rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors"
                      >
                        {i18nService.t('mcpInstall')}
                      </button>
                    </div>
                  </div>

                  <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                    {i18nService.t(entry.descriptionKey)}
                  </p>

                  <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${TRANSPORT_BADGE_COLORS[entry.transportType] || ''}`}>
                      {entry.transportType}
                    </span>
                    <span>·</span>
                    <span className="truncate">{entry.command} {entry.defaultArgs[entry.defaultArgs.length - 1]}</span>
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
              className="rounded-xl border-2 border-dashed dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:border-claude-accent hover:text-claude-accent dark:hover:border-claude-accent dark:hover:text-claude-accent transition-colors flex items-center justify-center min-h-[120px] text-sm"
            >
              + {i18nService.t('addMcpServer')}
            </button>
            {filteredCustom.map((server) => (
                <div
                  key={server.id}
                  className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
                        <ConnectorIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                      </div>
                      <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                        {server.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {server.githubUrl && (
                        <button
                          type="button"
                          onClick={() => handleOpenGithub(server.githubUrl!)}
                          className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
                          title={i18nService.t('mcpViewOnGithub')}
                        >
                          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleOpenEditForm(server)}
                        className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
                        title={i18nService.t('editMcpServer')}
                      >
                        <PencilIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRequestDelete(server)}
                        className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                        title={i18nService.t('deleteMcpServer')}
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                      <div
                        className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                          server.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
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
                    <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                      {server.description || getTransportSummary(server)}
                    </p>
                  </Tooltip>

                  <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={handleCancelDelete}
        >
          <div
            className="w-full max-w-sm mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('deleteMcpServer')}
            </div>
            <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
                className="px-3 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
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
          </div>
        </div>
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
