import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  MagnifyingGlassIcon,
  PlusCircleIcon,
  TrashIcon,
  PencilIcon,
  ServerStackIcon,
  ArrowTopRightOnSquareIcon,
  LinkIcon,
} from '@heroicons/react/24/outline';
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

type McpTab = 'installed' | 'marketplace';

/** Parse a URL / npm package / npx command into McpServerFormData for the form modal. */
function parseUrlInput(input: string): Partial<McpServerFormData> | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // npx command: "npx -y @pkg/name arg1 arg2"
  if (trimmed.startsWith('npx ')) {
    const parts = trimmed.split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);
    const pkgArg = args.find(a => !a.startsWith('-'));
    const name = pkgArg ? pkgArg.replace(/^@/, '').replace(/\//g, '-').replace(/@.*$/, '') : 'custom-mcp';
    return { name, transportType: 'stdio', command, args };
  }

  // npm scoped package: "@scope/package"
  if (trimmed.startsWith('@') && trimmed.includes('/') && !trimmed.includes(' ')) {
    const name = trimmed.replace(/^@/, '').replace(/\//g, '-').replace(/@.*$/, '');
    return { name, transportType: 'stdio', command: 'npx', args: ['-y', trimmed] };
  }

  // GitHub URL
  if (trimmed.match(/^https?:\/\/(www\.)?github\.com\//)) {
    const match = trimmed.match(/github\.com\/([^/]+)\/([^/]+)/);
    const name = match ? match[2].replace(/\.git$/, '') : 'github-mcp';
    return { name, transportType: 'stdio', command: 'npx', args: ['-y', name], githubUrl: trimmed };
  }

  // HTTP(S) URL → SSE/HTTP MCP
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const urlObj = new URL(trimmed);
    const name = urlObj.hostname.replace(/\./g, '-');
    return { name, transportType: 'sse', url: trimmed };
  }

  // Plain package name
  if (/^[a-zA-Z0-9@._-]+$/.test(trimmed)) {
    const name = trimmed.replace(/^@/, '').replace(/\//g, '-').replace(/@.*$/, '');
    return { name, transportType: 'stdio', command: 'npx', args: ['-y', trimmed] };
  }

  return null;
}

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
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');

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

  const handleOpenCreateForm = () => {
    setEditingServer(null);
    setInstallingRegistry(null);
    setIsFormOpen(true);
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
    // After installing from marketplace, switch to installed tab to show result
    if (installingRegistry) {
      setActiveTab('installed');
    }
  };

  const handleOpenUrlModal = () => {
    setUrlInput('');
    setUrlError('');
    setIsUrlModalOpen(true);
  };

  const handleCloseUrlModal = () => {
    setIsUrlModalOpen(false);
    setUrlInput('');
    setUrlError('');
  };

  const handleUrlInstall = () => {
    const parsed = parseUrlInput(urlInput);
    if (!parsed) {
      setUrlError(i18nService.t('mcpUrlRequired'));
      return;
    }
    handleCloseUrlModal();
    setInstallingRegistry(null);
    const pseudoServer: McpServerConfig = {
      id: '',
      name: parsed.name || 'custom-mcp',
      description: parsed.description || '',
      enabled: false,
      transportType: parsed.transportType || 'stdio',
      command: parsed.command,
      args: parsed.args,
      env: parsed.env,
      url: parsed.url,
      headers: parsed.headers,
      isBuiltIn: false,
      githubUrl: parsed.githubUrl,
      createdAt: 0,
      updatedAt: 0,
    };
    setEditingServer(pseudoServer);
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

  // Count of available marketplace items (for badge)
  const marketplaceCount = useMemo(
    () => mcpRegistry.filter(e => !installedRegistryIds.has(e.id)).length,
    [installedRegistryIds]
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

      {/* Tab bar + search + actions */}
      <div className="flex items-center gap-3">
        {/* Tabs */}
        <div className="flex items-center border-b dark:border-claude-darkBorder border-claude-border mr-auto">
          <button type="button" onClick={() => setActiveTab('installed')} className={tabClass('installed')}>
            {i18nService.t('mcpInstalled')}
            {servers.length > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurface bg-claude-surface">
                {servers.length}
              </span>
            )}
            <div className={tabIndicatorClass('installed')} />
          </button>
          <button type="button" onClick={() => setActiveTab('marketplace')} className={tabClass('marketplace')}>
            {i18nService.t('mcpMarketplace')}
            {marketplaceCount > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurface bg-claude-surface">
                {marketplaceCount}
              </span>
            )}
            <div className={tabIndicatorClass('marketplace')} />
          </button>
        </div>

        {/* Search */}
        <div className="relative w-48">
          <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <input
            type="text"
            placeholder={i18nService.t('searchMcpServers')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-1 focus:ring-claude-accent"
          />
        </div>

        {/* Actions - only on installed tab */}
        {activeTab === 'installed' && (
          <>
            <button
              type="button"
              onClick={handleOpenUrlModal}
              className="p-1.5 rounded-lg border transition-colors dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
              title={i18nService.t('mcpInstallFromUrl')}
            >
              <LinkIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleOpenCreateForm}
              className="p-1.5 rounded-lg border transition-colors dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
              title={i18nService.t('addMcpServer')}
            >
              <PlusCircleIcon className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

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
                      <ServerStackIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
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
                        <ServerStackIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
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

      {/* URL install modal */}
      {isUrlModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={handleCloseUrlModal}
        >
          <div
            className="w-full max-w-md mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-lg font-semibold dark:text-claude-darkText text-claude-text mb-4">
              {i18nService.t('mcpInstallFromUrlTitle')}
            </div>
            <div className="space-y-3">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setUrlError(''); }}
                placeholder={i18nService.t('mcpInstallFromUrlPlaceholder')}
                className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleUrlInstall(); }}
              />
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('mcpInstallFromUrlHint')}
              </p>
              {urlError && (
                <div className="text-xs text-red-500">{urlError}</div>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCloseUrlModal}
                  className="px-3 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleUrlInstall}
                  className="px-3 py-1.5 text-xs rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors"
                >
                  {i18nService.t('mcpInstall')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit/Install form modal */}
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
