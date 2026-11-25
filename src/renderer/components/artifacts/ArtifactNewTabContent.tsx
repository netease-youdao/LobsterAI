import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  DocumentPlusIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  PresentationChartBarIcon,
  TableCellsIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { BlankDocumentKind } from '@shared/artifactPreview/blankDocument';
import type { LocalArtifactItem } from '@shared/library/types';
import type { LocalWebService } from '@shared/localWebServices/constants';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  listRunningLocalWebServices,
  openWorkspaceDirectoryInSystem,
  type ProbeGitWorkspaceResponse,
  probeWorkspaceGitStatus,
  searchLocalLibraryFiles,
} from '@/services/artifactWorkspace';
import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';
import { SubagentSessionStatus, type SubagentSessionSummary } from '@/types/cowork';

import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import {
  ArtifactNewTabCardId,
  classifyOmniBarInput,
  dedupeLibraryItemsAgainstSession,
  extractSessionLocalServicePorts,
  filterSessionArtifactsForOmniBar,
  getWorkspaceDisplayName,
  OmniBarInputKind,
  resolveNewTabMode,
  resolveNewTabOverflowItems,
  resolveNewTabPrimaryCards,
} from './artifactNewTabModel';
import {
  ArtifactBrowserIcon,
  ArtifactPreviewGlobeIcon,
  WorkspaceFilesIcon,
} from './ArtifactPreviewIdentity';
import { getPreviewCardDescriptor, PreviewCardIconKind } from './previewCardPolicy';

const t = (key: string) => i18nService.t(key);

const LIBRARY_SEARCH_DEBOUNCE_MS = 160;
const OMNI_RESULT_LIMIT = 5;
const QUICK_SESSION_FILES_LIMIT = 4;
const QUICK_LOCAL_SERVICES_LIMIT = 3;

const EMPTY_GIT_PROBE: ProbeGitWorkspaceResponse = {
  isGitRepository: false,
  changedFileCount: 0,
  branch: null,
};

const OmniResultType = {
  Url: 'url',
  SessionArtifact: 'sessionArtifact',
  LibraryItem: 'libraryItem',
  WebSearch: 'webSearch',
} as const;

type OmniResultItem =
  | { kind: typeof OmniResultType.Url; key: string; url: string; label: string }
  | { kind: typeof OmniResultType.SessionArtifact; key: string; artifact: Artifact }
  | { kind: typeof OmniResultType.LibraryItem; key: string; item: LocalArtifactItem }
  | { kind: typeof OmniResultType.WebSearch; key: string; url: string; query: string };

const WorkspaceDiffIcon: React.FC<{ className?: string }> = ({ className = 'h-[18px] w-[18px]' }) => (
  <svg
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect x="2.5" y="2.5" width="13" height="13" rx="3" />
    <path d="M9 5.5v4M7 7.5h4M7 12.25h4" />
  </svg>
);

const SubagentMiniIcon: React.FC<{ className?: string }> = ({ className = 'h-[18px] w-[18px]' }) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M10 3v2.25" />
    <rect x="4" y="5.5" width="12" height="9.5" rx="3" />
    <circle cx="8" cy="10.25" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12" cy="10.25" r="0.9" fill="currentColor" stroke="none" />
    <path d="M7.75 13h4.5M2.5 9.5v2M17.5 9.5v2" />
  </svg>
);

function formatShortPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : parts.join('/');
}

export interface ArtifactNewTabContentProps {
  sessionId: string;
  workingDirectory?: string;
  artifacts: Artifact[];
  subagents: SubagentSessionSummary[];
  hasAgentBrowserActivity?: boolean;
  onSelectArtifact: (artifactId: string) => void;
  onOpenLocalFilePath: (filePath: string) => Promise<void> | void;
  onOpenLocalFilePicker: () => Promise<void> | void;
  onCreateBlankDocument: (kind: BlankDocumentKind) => Promise<void> | void;
  onOpenFileList: () => void;
  onOpenBrowserUrl: (url?: string) => void;
  onOpenAgentBrowser?: () => void;
  onOpenSubagents?: () => void;
  onOpenWorkspaceChanges?: () => Promise<void> | void;
}

const ArtifactNewTabContent: React.FC<ArtifactNewTabContentProps> = ({
  sessionId,
  workingDirectory,
  artifacts,
  subagents,
  hasAgentBrowserActivity = false,
  onSelectArtifact,
  onOpenLocalFilePath,
  onOpenLocalFilePicker,
  onCreateBlankDocument,
  onOpenFileList,
  onOpenBrowserUrl,
  onOpenAgentBrowser,
  onOpenSubagents,
  onOpenWorkspaceChanges,
}) => {
  const [query, setQuery] = useState('');
  const [isOmniFocused, setIsOmniFocused] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [libraryItems, setLibraryItems] = useState<LocalArtifactItem[]>([]);
  const [gitProbe, setGitProbe] = useState<ProbeGitWorkspaceResponse>(EMPTY_GIT_PROBE);
  const [localServices, setLocalServices] = useState<LocalWebService[]>([]);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [busyCardId, setBusyCardId] = useState<ArtifactNewTabCardId | null>(null);

  const omniContainerRef = useRef<HTMLDivElement>(null);
  const omniInputRef = useRef<HTMLInputElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);

  const language = i18nService.getLanguage();
  const supportsWorkspaceChanges = Boolean(onOpenWorkspaceChanges);
  const mode = resolveNewTabMode(gitProbe.isGitRepository && supportsWorkspaceChanges);
  const workspaceName = useMemo(() => getWorkspaceDisplayName(workingDirectory), [workingDirectory]);

  const runningSubagentCount = useMemo(
    () => subagents.filter(item => item.status === SubagentSessionStatus.Running).length,
    [subagents],
  );

  // Probe whether current session workspace is a Git repository for adaptive Work/Code cards.
  useEffect(() => {
    let cancelled = false;
    setGitProbe(EMPTY_GIT_PROBE);
    void probeWorkspaceGitStatus({ sessionId, cwd: workingDirectory }).then(result => {
      if (!cancelled) setGitProbe(result);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, workingDirectory]);

  const sessionLocalServicePorts = useMemo(
    () => extractSessionLocalServicePorts(artifacts),
    [artifacts],
  );
  const sessionLocalServicePortsKey = sessionLocalServicePorts.join(',');

  // Only surface local web services started/referenced in this session, and verify they are online.
  useEffect(() => {
    if (sessionLocalServicePorts.length === 0) {
      setLocalServices([]);
      return undefined;
    }
    const allowedPorts = new Set(sessionLocalServicePorts);
    let cancelled = false;
    void listRunningLocalWebServices(sessionLocalServicePorts).then(services => {
      if (!cancelled) {
        setLocalServices(
          services
            .filter(service => service.online && allowedPorts.has(service.port))
            .slice(0, QUICK_LOCAL_SERVICES_LIMIT),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionLocalServicePorts, sessionLocalServicePortsKey]);

  const classification = useMemo(
    () => classifyOmniBarInput(query, language),
    [query, language],
  );

  // Debounced search across user's local Library ("我的文件") when typing in Omni-Bar.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setLibraryItems([]);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchLocalLibraryFiles(trimmed, OMNI_RESULT_LIMIT).then(items => {
        if (!cancelled) setLibraryItems(items);
      });
    }, LIBRARY_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const sessionMatches = useMemo(
    () => filterSessionArtifactsForOmniBar(artifacts, query, OMNI_RESULT_LIMIT),
    [artifacts, query],
  );

  const dedupedLibraryMatches = useMemo(
    () => dedupeLibraryItemsAgainstSession(libraryItems, sessionMatches, OMNI_RESULT_LIMIT),
    [libraryItems, sessionMatches],
  );

  const omniResults = useMemo<OmniResultItem[]>(() => {
    if (classification.kind === OmniBarInputKind.Empty) return [];
    const items: OmniResultItem[] = [];
    if (classification.kind === OmniBarInputKind.Url && classification.normalizedUrl) {
      items.push({
        kind: OmniResultType.Url,
        key: `url:${classification.normalizedUrl}`,
        url: classification.normalizedUrl,
        label: classification.normalizedUrl,
      });
    }
    for (const artifact of sessionMatches) {
      items.push({
        kind: OmniResultType.SessionArtifact,
        key: `artifact:${artifact.id}`,
        artifact,
      });
    }
    for (const item of dedupedLibraryMatches) {
      items.push({
        kind: OmniResultType.LibraryItem,
        key: `library:${item.itemId}`,
        item,
      });
    }
    if (classification.kind === OmniBarInputKind.Search && classification.normalizedUrl) {
      items.push({
        kind: OmniResultType.WebSearch,
        key: `search:${classification.query}`,
        url: classification.normalizedUrl,
        query: classification.query,
      });
    }
    return items;
  }, [classification, dedupedLibraryMatches, sessionMatches]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query, omniResults.length]);

  // Close Omni-Bar dropdown and overflow menu on outside pointerdown or Escape.
  useEffect(() => {
    if (!isOmniFocused && !showOverflowMenu) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (isOmniFocused && target && !omniContainerRef.current?.contains(target)) {
        setIsOmniFocused(false);
      }
      if (
        showOverflowMenu
        && target
        && !overflowMenuRef.current?.contains(target)
        && !overflowButtonRef.current?.contains(target)
      ) {
        setShowOverflowMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowOverflowMenu(false);
        setIsOmniFocused(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOmniFocused, showOverflowMenu]);

  const executeOmniResult = useCallback((item: OmniResultItem) => {
    setIsOmniFocused(false);
    setQuery('');
    switch (item.kind) {
      case OmniResultType.Url:
      case OmniResultType.WebSearch:
        onOpenBrowserUrl(item.url);
        break;
      case OmniResultType.SessionArtifact:
        onSelectArtifact(item.artifact.id);
        break;
      case OmniResultType.LibraryItem:
        void onOpenLocalFilePath(item.item.filePath);
        break;
    }
  }, [onOpenBrowserUrl, onOpenLocalFilePath, onSelectArtifact]);

  const handleOmniKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' && omniResults.length > 0) {
      event.preventDefault();
      setHighlightedIndex(prev => (prev + 1) % omniResults.length);
      return;
    }
    if (event.key === 'ArrowUp' && omniResults.length > 0) {
      event.preventDefault();
      setHighlightedIndex(prev => (prev - 1 + omniResults.length) % omniResults.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = omniResults[highlightedIndex] ?? omniResults[0];
      if (target) {
        executeOmniResult(target);
      } else if (classification.normalizedUrl) {
        setIsOmniFocused(false);
        setQuery('');
        onOpenBrowserUrl(classification.normalizedUrl);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setIsOmniFocused(false);
      omniInputRef.current?.blur();
    }
  }, [classification.normalizedUrl, executeOmniResult, highlightedIndex, omniResults, onOpenBrowserUrl]);

  const runCardAction = useCallback(async (cardId: ArtifactNewTabCardId) => {
    if (busyCardId) return;
    setShowOverflowMenu(false);
    switch (cardId) {
      case ArtifactNewTabCardId.NewDocument:
        setBusyCardId(cardId);
        try {
          await onCreateBlankDocument(BlankDocumentKind.Word);
        } finally {
          setBusyCardId(null);
        }
        return;
      case ArtifactNewTabCardId.NewPresentation:
        setBusyCardId(cardId);
        try {
          await onCreateBlankDocument(BlankDocumentKind.Slides);
        } finally {
          setBusyCardId(null);
        }
        return;
      case ArtifactNewTabCardId.NewSpreadsheet:
        setBusyCardId(cardId);
        try {
          await onCreateBlankDocument(BlankDocumentKind.Sheet);
        } finally {
          setBusyCardId(null);
        }
        return;
      case ArtifactNewTabCardId.NewMarkdown:
        setBusyCardId(cardId);
        try {
          await onCreateBlankDocument(BlankDocumentKind.Markdown);
        } finally {
          setBusyCardId(null);
        }
        return;
      case ArtifactNewTabCardId.Files:
        onOpenFileList();
        return;
      case ArtifactNewTabCardId.Browser:
        if (hasAgentBrowserActivity && onOpenAgentBrowser) {
          onOpenAgentBrowser();
        } else {
          onOpenBrowserUrl();
        }
        return;
      case ArtifactNewTabCardId.WorkspaceChanges:
        if (!onOpenWorkspaceChanges) return;
        setBusyCardId(cardId);
        try {
          await onOpenWorkspaceChanges();
        } finally {
          setBusyCardId(null);
        }
        return;
      case ArtifactNewTabCardId.Subagents:
        onOpenSubagents?.();
        return;
      case ArtifactNewTabCardId.OpenLocalFile:
        setBusyCardId(cardId);
        try {
          await onOpenLocalFilePicker();
        } finally {
          setBusyCardId(null);
        }
        return;
      case ArtifactNewTabCardId.RevealWorkspace:
        if (workingDirectory) {
          void openWorkspaceDirectoryInSystem(workingDirectory);
        }
        return;
    }
  }, [
    busyCardId,
    hasAgentBrowserActivity,
    onCreateBlankDocument,
    onOpenAgentBrowser,
    onOpenBrowserUrl,
    onOpenFileList,
    onOpenLocalFilePicker,
    onOpenSubagents,
    onOpenWorkspaceChanges,
    workingDirectory,
  ]);

  const primaryCards = useMemo(() => resolveNewTabPrimaryCards(mode), [mode]);
  const overflowItems = useMemo(
    () => resolveNewTabOverflowItems(mode, {
      isGitRepository: gitProbe.isGitRepository && supportsWorkspaceChanges,
      hasWorkingDirectory: Boolean(workingDirectory?.trim()),
      includeSubagents: Boolean(onOpenSubagents),
    }),
    [gitProbe.isGitRepository, mode, onOpenSubagents, supportsWorkspaceChanges, workingDirectory],
  );

  const quickSessionFiles = useMemo(
    () => filterSessionArtifactsForOmniBar(artifacts, '', QUICK_SESSION_FILES_LIMIT),
    [artifacts],
  );

  const getCardMeta = (cardId: ArtifactNewTabCardId): {
    renderIcon: (className: string) => React.ReactNode;
    iconColorClassName: string;
    label: string;
    badge?: React.ReactNode;
  } => {
    switch (cardId) {
      case ArtifactNewTabCardId.NewDocument:
        return {
          renderIcon: className => <DocumentPlusIcon className={className} strokeWidth={1.75} />,
          iconColorClassName: 'text-[#2B579A] dark:text-[#60A5FA]',
          label: t('artifactNewTabNewDocument'),
        };
      case ArtifactNewTabCardId.NewPresentation:
        return {
          renderIcon: className => <PresentationChartBarIcon className={className} strokeWidth={1.75} />,
          iconColorClassName: 'text-[#D24726] dark:text-[#FB923C]',
          label: t('artifactNewTabNewPresentation'),
        };
      case ArtifactNewTabCardId.NewSpreadsheet:
        return {
          renderIcon: className => <TableCellsIcon className={className} strokeWidth={1.75} />,
          iconColorClassName: 'text-[#217346] dark:text-[#34D399]',
          label: t('artifactNewTabNewSpreadsheet'),
        };
      case ArtifactNewTabCardId.NewMarkdown:
        return {
          renderIcon: className => <DocumentTextIcon className={className} strokeWidth={1.75} />,
          iconColorClassName: 'text-indigo-500 dark:text-indigo-400',
          label: t('artifactNewTabNewMarkdown'),
        };
      case ArtifactNewTabCardId.Files:
        return {
          renderIcon: className => <WorkspaceFilesIcon className={className} />,
          iconColorClassName: '',
          label: t('artifactNewTabFiles'),
        };
      case ArtifactNewTabCardId.Browser:
        return {
          renderIcon: className => <ArtifactBrowserIcon className={className} />,
          iconColorClassName: 'text-[#0EA5E9] dark:text-[#38BDF8]',
          label: t('artifactBrowserTab'),
          badge: (hasAgentBrowserActivity || localServices.length > 0) ? (
            <span
              className={`h-2 w-2 rounded-full ${hasAgentBrowserActivity ? 'bg-primary animate-pulse' : 'bg-emerald-500'}`}
              aria-hidden="true"
            />
          ) : undefined,
        };
      case ArtifactNewTabCardId.WorkspaceChanges:
        return {
          renderIcon: className => <WorkspaceDiffIcon className={className} />,
          iconColorClassName: 'text-emerald-600 dark:text-emerald-400',
          label: t('artifactNewTabWorkspaceChanges'),
          badge: gitProbe.changedFileCount > 0 ? (
            <span className="rounded-full bg-background/80 px-1.5 py-0.5 text-[11px] font-medium text-secondary">
              {gitProbe.changedFileCount}
            </span>
          ) : undefined,
        };
      case ArtifactNewTabCardId.Subagents:
        return {
          renderIcon: className => <SubagentMiniIcon className={className} />,
          iconColorClassName: 'text-violet-500 dark:text-violet-400',
          label: t('subagentPanelTitle'),
          badge: runningSubagentCount > 0 ? (
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse" aria-hidden="true" />
          ) : subagents.length > 0 ? (
            <span className="text-[11px] text-muted">{subagents.length}</span>
          ) : undefined,
        };
      case ArtifactNewTabCardId.OpenLocalFile:
        return {
          renderIcon: className => <FolderOpenIcon className={className} strokeWidth={1.6} />,
          iconColorClassName: 'text-secondary group-hover:text-foreground',
          label: t('artifactNewTabOpenLocalFile'),
        };
      case ArtifactNewTabCardId.RevealWorkspace:
        return {
          renderIcon: className => <ArrowUpRightIcon className={className} strokeWidth={1.6} />,
          iconColorClassName: 'text-secondary group-hover:text-foreground',
          label: t('artifactNewTabRevealWorkspace'),
        };
    }
  };

  const showOmniDropdown = isOmniFocused && omniResults.length > 0;
  const showRunningSubagents = runningSubagentCount > 0 && Boolean(onOpenSubagents);
  const hasContextualItems = showRunningSubagents || localServices.length > 0 || quickSessionFiles.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center px-6 py-10">
        {/* Centered Omni-Bar */}
        <div ref={omniContainerRef} className="relative mb-8">
          <div className="flex h-11 items-center gap-2.5 rounded-full border border-border/80 bg-background px-4 shadow-[0_1px_4px_rgba(15,23,42,0.04)] transition-all focus-within:border-border focus-within:shadow-[0_4px_16px_rgba(15,23,42,0.08)] dark:bg-surface/60 dark:shadow-none">
            <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <input
              ref={omniInputRef}
              type="text"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onFocus={() => setIsOmniFocused(true)}
              onKeyDown={handleOmniKeyDown}
              placeholder={t('artifactNewTabOmniPlaceholder')}
              aria-label={t('artifactNewTabOmniPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  omniInputRef.current?.focus();
                }}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-foreground"
                aria-label={t('close')}
              >
                <XMarkIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {showOmniDropdown && (
            <div className="absolute inset-x-0 top-[calc(100%+8px)] z-30 max-h-[300px] overflow-y-auto rounded-2xl border border-border bg-background p-1.5 shadow-xl dark:bg-surface-raised">
              {omniResults.map((item, index) => {
                const isHighlighted = index === highlightedIndex;
                const rowClass = `flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors ${
                  isHighlighted ? 'bg-surface-raised text-foreground dark:bg-surface' : 'text-foreground/90 hover:bg-surface-raised dark:hover:bg-surface'
                }`;

                if (item.kind === OmniResultType.Url) {
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => executeOmniResult(item)}
                      className={rowClass}
                    >
                      <GlobeAltIcon className="h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      <span className="shrink-0 text-[11px] text-muted">{t('artifactNewTabOpenUrlHint')}</span>
                    </button>
                  );
                }

                if (item.kind === OmniResultType.WebSearch) {
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => executeOmniResult(item)}
                      className={rowClass}
                    >
                      <GlobeAltIcon className="h-4 w-4 shrink-0 text-secondary" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('artifactNewTabSearchWebHint').replace('{query}', item.query)}
                      </span>
                      <ArrowUpRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
                    </button>
                  );
                }

                if (item.kind === OmniResultType.SessionArtifact) {
                  const descriptor = getPreviewCardDescriptor(item.artifact);
                  const fileName = item.artifact.fileName || item.artifact.title;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => executeOmniResult(item)}
                      className={rowClass}
                    >
                      {descriptor.iconKind === PreviewCardIconKind.Globe ? (
                        <ArtifactPreviewGlobeIcon className="h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <FileTypeIcon fileName={descriptor.iconFileName} className="h-4 w-4 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{fileName}</span>
                      <span className="shrink-0 text-[11px] text-muted">{t('artifactNewTabSessionBadge')}</span>
                    </button>
                  );
                }

                return (
                  <button
                    key={item.key}
                    type="button"
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => executeOmniResult(item)}
                    className={rowClass}
                  >
                    <FileTypeIcon fileName={item.item.title || item.item.filePath} className="h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{item.item.title}</div>
                      <div className="truncate text-[11px] text-muted">{formatShortPath(item.item.filePath)}</div>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted">{t('artifactNewTabLibraryBadge')}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Section Header + Overflow Menu */}
        <div className="relative mb-3 flex items-center justify-between px-0.5">
          <span className="text-xs font-medium text-secondary">
            {t('artifactNewTabOpenSection')}
          </span>
          <div className="relative">
            <button
              ref={overflowButtonRef}
              type="button"
              onClick={() => setShowOverflowMenu(open => !open)}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                showOverflowMenu
                  ? 'bg-surface-raised text-foreground'
                  : 'text-muted hover:bg-surface-raised hover:text-foreground'
              }`}
              aria-label={t('artifactNewTabMoreTools')}
              title={t('artifactNewTabMoreTools')}
            >
              <EllipsisHorizontalIcon className="h-4 w-4" />
            </button>

            {showOverflowMenu && (
              <div
                ref={overflowMenuRef}
                className="absolute right-0 top-8 z-30 w-52 overflow-hidden rounded-xl border border-border bg-background p-1.5 shadow-xl dark:bg-surface-raised"
              >
                {overflowItems.map(cardId => {
                  const meta = getCardMeta(cardId);
                  return (
                    <button
                      key={cardId}
                      type="button"
                      disabled={busyCardId !== null}
                      onClick={() => void runCardAction(cardId)}
                      className="group flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-surface"
                    >
                      <span className={`flex shrink-0 items-center transition-colors ${meta.iconColorClassName}`}>
                        {meta.renderIcon('h-4 w-4')}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                      {meta.badge}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 2x2 Bento Card Grid */}
        <div className="grid grid-cols-2 gap-3">
          {primaryCards.map(cardId => {
            const meta = getCardMeta(cardId);
            const isBusy = busyCardId === cardId;
            return (
              <button
                key={cardId}
                type="button"
                disabled={busyCardId !== null}
                onClick={() => void runCardAction(cardId)}
                className="group flex min-h-[92px] flex-col justify-between rounded-2xl border border-border/60 bg-surface-raised/80 px-4 py-3.5 text-left transition-all hover:border-foreground/15 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className={`inline-flex transition-colors ${meta.iconColorClassName}`}>
                    {isBusy ? (
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                    ) : (
                      meta.renderIcon('h-5 w-5')
                    )}
                  </span>
                  {meta.badge}
                </div>
                <span className="mt-3 truncate text-[13.5px] font-medium text-foreground">
                  {meta.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Contextual Live Strip (shown only when relevant) */}
        {hasContextualItems && (
          <div className="mt-6 space-y-2">
            {showRunningSubagents && (
              <button
                type="button"
                onClick={onOpenSubagents}
                className="flex w-full items-center gap-2.5 rounded-xl border border-border/70 bg-surface-raised/70 px-3.5 py-2.5 text-left text-xs transition-colors hover:border-foreground/15 hover:bg-surface-raised"
              >
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {t('artifactNewTabRunningSubagents').replace('{count}', String(runningSubagentCount))}
                </span>
                <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
              </button>
            )}

            {localServices.map(service => (
              <button
                key={service.id}
                type="button"
                onClick={() => onOpenBrowserUrl(service.url)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-border/70 bg-surface-raised/70 px-3.5 py-2 text-left text-xs transition-colors hover:border-foreground/15 hover:bg-surface-raised"
              >
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {service.title}
                </span>
                <span className="shrink-0 text-[11px] text-muted">
                  {service.host}:{service.port}
                </span>
                <ArrowUpRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
              </button>
            ))}

            {quickSessionFiles.length > 0 && (
              <div className="pt-1">
                <div className="mb-1.5 flex items-center justify-between px-0.5">
                  <span className="text-[11px] font-medium text-muted">
                    {t('artifactNewTabRecentSessionFiles')}
                  </span>
                  {artifacts.length > QUICK_SESSION_FILES_LIMIT && (
                    <button
                      type="button"
                      onClick={onOpenFileList}
                      className="text-[11px] text-secondary transition-colors hover:text-foreground"
                    >
                      {t('artifactNewTabViewAllFiles').replace('{count}', String(artifacts.length))}
                    </button>
                  )}
                </div>
                <div className="space-y-1">
                  {quickSessionFiles.map(artifact => {
                    const descriptor = getPreviewCardDescriptor(artifact);
                    const fileName = artifact.fileName || artifact.title;
                    return (
                      <button
                        key={artifact.id}
                        type="button"
                        onClick={() => onSelectArtifact(artifact.id)}
                        className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] text-foreground/90 transition-colors hover:bg-surface-raised hover:text-foreground"
                      >
                        {descriptor.iconKind === PreviewCardIconKind.Globe ? (
                          <ArtifactPreviewGlobeIcon className="h-4 w-4 shrink-0 text-primary" />
                        ) : (
                          <FileTypeIcon fileName={descriptor.iconFileName} className="h-4 w-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{fileName}</span>
                        <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Subtle Workspace Footer */}
      {workspaceName && workingDirectory && (
        <div className="flex shrink-0 items-center justify-center px-6 pb-5 pt-2">
          <button
            type="button"
            onClick={() => void openWorkspaceDirectoryInSystem(workingDirectory)}
            title={workingDirectory}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] text-muted transition-colors hover:bg-surface-raised hover:text-secondary"
          >
            <FolderIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{workspaceName}</span>
            {gitProbe.isGitRepository && gitProbe.branch && (
              <span className="shrink-0 opacity-75">· {gitProbe.branch}</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default ArtifactNewTabContent;
