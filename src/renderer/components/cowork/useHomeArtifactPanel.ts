import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { BlankDocumentKind } from '../../../shared/artifactPreview/blankDocument';
import {
  type CoworkSelectedTextSnippet,
  normalizeCoworkSelectedTextSnippets,
} from '../../../shared/cowork/selectedText';
import { findLocalServiceArtifactForUrl } from '../../services/artifactLinkOpen';
import {
  dedupeArtifactsForDisplay,
  normalizeLocalServiceOrigin,
  resolveArtifactIdForDisplay,
} from '../../services/artifactParser';
import {
  createBlankWorkspaceDocument,
  openWorkspaceDirectoryInSystem,
  pickLocalFileForPreview,
} from '../../services/artifactWorkspace';
import { i18nService } from '../../services/i18n';
import { requestOfficeAutoFocus } from '../../services/office/officeFormats';
import {
  loadWorkspaceFileArtifact,
  resolveWorkspaceFileOpenTarget,
  WorkspaceFileOpenTargetKind,
} from '../../services/workspaceFileOpen';
import type { RootState } from '../../store';
import {
  activateArtifactBrowserTab,
  activateArtifactFileListTab,
  activateArtifactNewTab,
  activateArtifactPreviewTab,
  addLinkedFileArtifact,
  type ArtifactPreviewTab,
  ArtifactSpecialTab,
  closeArtifactPreviewTab,
  closePanel,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  openArtifactPreviewTab,
  selectActivePreviewTab,
  selectIsPanelOpen,
  selectPanelWidth,
  togglePanel,
} from '../../store/slices/artifactSlice';
import { addDraftSelectedTextSnippet } from '../../store/slices/coworkSlice';
import { type Artifact, ArtifactTypeValue } from '../../types/artifact';
import { reportArtifactPreviewAction } from '../artifacts/artifactAnalytics';
import { commitArtifactFileRename } from '../artifacts/artifactFileRename';
import { canRenameArtifactFile } from '../artifacts/artifactHeaderPath';
import {
  activateBrowserPreviewTab,
  type BrowserLocalServiceContext,
  type BrowserPreviewTab,
  closeBrowserPreviewTab,
  createBrowserPreviewTab,
  EMPTY_SESSION_BROWSER_TABS_STATE,
  getActiveBrowserPreviewTab,
  insertBrowserPreviewTabAfter,
  openOrReuseBlankBrowserPreviewTab,
  type SessionBrowserTabsState,
  updateBrowserPreviewTab,
} from '../artifacts/browserPreviewTabs';
import {
  ARTIFACT_PANEL_TRANSITION_MS,
  computeArtifactPanelLayout,
  computeArtifactPanelWidthBounds,
  CoworkArtifactScope,
  resolveHomePanelFallbackAfterClose,
  SELECTED_TEXT_ERROR_I18N_KEYS,
} from './artifactPanelChrome';
import type { ArtifactTabActionTarget } from './artifactTabActions';
import { CoworkUiEvent } from './constants';
import type { CoworkPromptInputRef } from './CoworkPromptInput';

const EMPTY_ARTIFACTS: Artifact[] = [];
const EMPTY_PREVIEW_TABS: ArtifactPreviewTab[] = [];
const EMPTY_SELECTED_TEXT_SNIPPETS: CoworkSelectedTextSnippet[] = [];

const HOME_SESSION_ID = CoworkArtifactScope.Home;

function normalizeBrowserPreviewUrlForMatch(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return trimmed;
  }
}

function isSameBrowserPreviewUrl(value: string, previewUrl: string): boolean {
  if (!value || !previewUrl) return false;
  return normalizeBrowserPreviewUrlForMatch(value) === normalizeBrowserPreviewUrlForMatch(previewUrl);
}

export interface UseHomeArtifactPanelOptions {
  isActive: boolean;
  workingDirectory: string;
  promptInputRef: React.RefObject<CoworkPromptInputRef>;
}

export function useHomeArtifactPanel({
  isActive,
  workingDirectory,
  promptInputRef,
}: UseHomeArtifactPanelOptions) {
  const dispatch = useDispatch();
  const isPanelOpen = useSelector((state: RootState) => selectIsPanelOpen(state, HOME_SESSION_ID));
  const panelWidth = useSelector(selectPanelWidth);
  const rawHomeArtifacts = useSelector((state: RootState) => (
    state.artifact.artifactsBySession[HOME_SESSION_ID] ?? EMPTY_ARTIFACTS
  ));
  const artifactPreviewTabs = useSelector((state: RootState) => (
    state.artifact.previewTabsBySession[HOME_SESSION_ID] ?? EMPTY_PREVIEW_TABS
  ));
  const activeArtifactPreviewTab = useSelector((state: RootState) => (
    selectActivePreviewTab(state, HOME_SESSION_ID)
  ));
  const selectedDraftSnippets = useSelector((state: RootState) => (
    state.cowork.draftSelectedTextSnippets[HOME_SESSION_ID] ?? EMPTY_SELECTED_TEXT_SNIPPETS
  ));

  const homeArtifacts = useMemo(
    () => dedupeArtifactsForDisplay(
      rawHomeArtifacts,
      { defaultProjectDirectory: workingDirectory || undefined },
    ),
    [rawHomeArtifacts, workingDirectory],
  );

  const artifactTabsWithArtifacts = useMemo(() => {
    const artifactsById = new Map(homeArtifacts.map(artifact => [artifact.id, artifact]));
    return artifactPreviewTabs
      .map(tab => ({ tab, artifact: artifactsById.get(tab.artifactId) }))
      .filter((item): item is { tab: ArtifactPreviewTab; artifact: Artifact } => Boolean(item.artifact));
  }, [artifactPreviewTabs, homeArtifacts]);

  const [shouldRenderArtifactPanel, setShouldRenderArtifactPanel] = useState(isPanelOpen);
  const [isArtifactPanelVisible, setIsArtifactPanelVisible] = useState(isPanelOpen);
  const [isArtifactPanelTransitioning, setIsArtifactPanelTransitioning] = useState(false);
  const [isNewTabPreviewTabOpen, setIsNewTabPreviewTabOpen] = useState(
    () => isPanelOpen && !activeArtifactPreviewTab,
  );
  const [isFileListPreviewTabOpen, setIsFileListPreviewTabOpen] = useState(false);
  const [browserTabsState, setBrowserTabsState] = useState<SessionBrowserTabsState>(
    EMPTY_SESSION_BROWSER_TABS_STATE,
  );
  const [activeSpecialPreviewTab, setActiveSpecialPreviewTab] = useState<ArtifactSpecialTab>(
    ArtifactSpecialTab.NewTab,
  );
  const [artifactTabsCanScrollLeft, setArtifactTabsCanScrollLeft] = useState(false);
  const [artifactTabsCanScrollRight, setArtifactTabsCanScrollRight] = useState(false);
  const [artifactTabsIsOverflowing, setArtifactTabsIsOverflowing] = useState(false);
  const [artifactPanelMinWidth, setArtifactPanelMinWidth] = useState(MIN_PANEL_WIDTH);
  const [artifactPanelMaxWidth, setArtifactPanelMaxWidth] = useState(MAX_PANEL_WIDTH);
  const [contentRowWidth, setContentRowWidth] = useState(0);
  const [promptInputAreaHeight, setPromptInputAreaHeight] = useState(0);
  const [isArtifactPanelExpanded, setIsArtifactPanelExpanded] = useState(false);
  const [isExpandedPromptInputHidden, setIsExpandedPromptInputHidden] = useState(false);
  const [renamingArtifactTabId, setRenamingArtifactTabId] = useState<string | null>(null);

  const previousArtifactPanelOpenRef = useRef(isPanelOpen);
  const browserTabsRef = useRef<SessionBrowserTabsState>(EMPTY_SESSION_BROWSER_TABS_STATE);
  const browserHtmlPreviewRequestIdByTabRef = useRef<Record<string, number>>({});
  const artifactTabsScrollRef = useRef<HTMLDivElement>(null);
  const contentRowRef = useRef<HTMLDivElement>(null);
  const promptInputAreaRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  const browserTabs = browserTabsState.tabs;
  const activeBrowserTab = useMemo(
    () => getActiveBrowserPreviewTab(browserTabsState),
    [browserTabsState],
  );
  const activeBrowserTabId = activeBrowserTab?.id ?? null;
  const isBrowserPreviewTabOpen = browserTabs.length > 0;

  const browserTabsForPanel = useMemo<BrowserPreviewTab[]>(() => (
    browserTabs.map(tab => {
      if (!tab.htmlPreviewArtifactId) return tab;
      const displayArtifactId = resolveArtifactIdForDisplay(
        rawHomeArtifacts,
        tab.htmlPreviewArtifactId,
        { defaultProjectDirectory: workingDirectory || undefined },
      );
      return displayArtifactId === tab.htmlPreviewArtifactId
        ? tab
        : { ...tab, htmlPreviewArtifactId: displayArtifactId };
    })
  ), [browserTabs, rawHomeArtifacts, workingDirectory]);

  const shouldShowArtifactAddButton = !isNewTabPreviewTabOpen;
  const shouldPinArtifactAddTab = shouldShowArtifactAddButton
    && (artifactTabsIsOverflowing || artifactTabsCanScrollLeft || artifactTabsCanScrollRight);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const tab of browserTabsRef.current.tabs) {
        if (tab.htmlPreviewSessionId) {
          void window.electron?.artifact?.destroyPreviewSession(tab.htmlPreviewSessionId);
        }
      }
      browserTabsRef.current = EMPTY_SESSION_BROWSER_TABS_STATE;
      browserHtmlPreviewRequestIdByTabRef.current = {};
    };
  }, []);

  const updateBrowserTabs = useCallback((
    updater: (current: SessionBrowserTabsState) => SessionBrowserTabsState,
  ): SessionBrowserTabsState => {
    const next = updater(browserTabsRef.current);
    browserTabsRef.current = next;
    setBrowserTabsState(next);
    return next;
  }, []);

  useEffect(() => {
    let animationFrame: number | undefined;
    let transitionTimeout: number | undefined;
    const wasOpen = previousArtifactPanelOpenRef.current;

    previousArtifactPanelOpenRef.current = isPanelOpen;

    if (wasOpen === isPanelOpen) {
      return undefined;
    }

    if (isPanelOpen) {
      setShouldRenderArtifactPanel(true);
      setIsArtifactPanelVisible(false);
      setIsArtifactPanelTransitioning(true);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = window.requestAnimationFrame(() => {
          setIsArtifactPanelVisible(true);
          transitionTimeout = window.setTimeout(() => {
            setIsArtifactPanelTransitioning(false);
          }, ARTIFACT_PANEL_TRANSITION_MS);
        });
      });
    } else {
      setIsArtifactPanelTransitioning(true);
      setIsArtifactPanelVisible(false);
      transitionTimeout = window.setTimeout(() => {
        setShouldRenderArtifactPanel(false);
        setIsArtifactPanelTransitioning(false);
      }, ARTIFACT_PANEL_TRANSITION_MS);
    }

    return () => {
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
      }
      if (transitionTimeout !== undefined) {
        window.clearTimeout(transitionTimeout);
      }
    };
  }, [isPanelOpen]);

  useEffect(() => {
    if (isPanelOpen && isActive) return;
    setIsArtifactPanelExpanded(false);
    setRenamingArtifactTabId(null);
    setIsExpandedPromptInputHidden(false);
  }, [isActive, isPanelOpen]);

  // Keep at least one tab open whenever the home panel is visible.
  useEffect(() => {
    if (!isPanelOpen) return;
    if (
      artifactTabsWithArtifacts.length === 0
      && !isNewTabPreviewTabOpen
      && !isFileListPreviewTabOpen
      && !isBrowserPreviewTabOpen
    ) {
      setIsNewTabPreviewTabOpen(true);
      setActiveSpecialPreviewTab(ArtifactSpecialTab.NewTab);
    }
  }, [
    artifactTabsWithArtifacts.length,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isNewTabPreviewTabOpen,
    isPanelOpen,
  ]);

  const updateArtifactPanelMaxWidth = useCallback(() => {
    const contentWidth = contentRowRef.current?.clientWidth ?? 0;
    if (contentWidth <= 0) return;
    setContentRowWidth(contentWidth);
    const { minWidth, maxWidth } = computeArtifactPanelWidthBounds(contentWidth);
    setArtifactPanelMinWidth(minWidth);
    setArtifactPanelMaxWidth(maxWidth);
  }, []);

  useLayoutEffect(() => {
    if (!isActive) return undefined;
    updateArtifactPanelMaxWidth();
    const container = contentRowRef.current;
    window.addEventListener('resize', updateArtifactPanelMaxWidth);

    if (typeof ResizeObserver === 'undefined' || !container) {
      return () => {
        window.removeEventListener('resize', updateArtifactPanelMaxWidth);
      };
    }

    const resizeObserver = new ResizeObserver(updateArtifactPanelMaxWidth);
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateArtifactPanelMaxWidth);
    };
  }, [isActive, updateArtifactPanelMaxWidth]);

  const updatePromptInputAreaHeight = useCallback(() => {
    setPromptInputAreaHeight(promptInputAreaRef.current?.offsetHeight ?? 0);
  }, []);

  useLayoutEffect(() => {
    if (!isActive) return;
    updatePromptInputAreaHeight();
  }, [
    isActive,
    isArtifactPanelExpanded,
    isExpandedPromptInputHidden,
    updatePromptInputAreaHeight,
  ]);

  useLayoutEffect(() => {
    if (!isActive) return undefined;
    const element = promptInputAreaRef.current;
    window.addEventListener('resize', updatePromptInputAreaHeight);

    if (typeof ResizeObserver === 'undefined' || !element) {
      return () => {
        window.removeEventListener('resize', updatePromptInputAreaHeight);
      };
    }

    const resizeObserver = new ResizeObserver(updatePromptInputAreaHeight);
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePromptInputAreaHeight);
    };
  }, [isActive, updatePromptInputAreaHeight]);

  const applyFallbackAfterSpecialClose = useCallback((
    closing: ArtifactSpecialTab,
    overrides?: {
      hasFileListTab?: boolean;
      hasBrowserTab?: boolean;
      hasNewTab?: boolean;
    },
  ) => {
    const fallback = resolveHomePanelFallbackAfterClose(closing, {
      firstArtifactTabId: artifactTabsWithArtifacts[0]?.tab.id ?? null,
      hasFileListTab: overrides?.hasFileListTab ?? isFileListPreviewTabOpen,
      hasBrowserTab: overrides?.hasBrowserTab ?? isBrowserPreviewTabOpen,
      hasNewTab: overrides?.hasNewTab ?? isNewTabPreviewTabOpen,
    });
    if (fallback.kind === 'artifact') {
      dispatch(activateArtifactPreviewTab({ sessionId: HOME_SESSION_ID, tabId: fallback.tabId }));
      return;
    }
    if (fallback.kind === 'special') {
      setActiveSpecialPreviewTab(fallback.tab);
      if (fallback.tab === ArtifactSpecialTab.FileList) {
        dispatch(activateArtifactFileListTab({ sessionId: HOME_SESSION_ID }));
      } else if (fallback.tab === ArtifactSpecialTab.Browser) {
        dispatch(activateArtifactBrowserTab({ sessionId: HOME_SESSION_ID }));
      } else {
        dispatch(activateArtifactNewTab({ sessionId: HOME_SESSION_ID }));
      }
      return;
    }
    dispatch(closePanel({ sessionId: HOME_SESSION_ID }));
  }, [
    artifactTabsWithArtifacts,
    dispatch,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isNewTabPreviewTabOpen,
  ]);

  const handleBrowserPreviewAddressChange = useCallback((tabId: string, value: string) => {
    updateBrowserTabs(current =>
      updateBrowserPreviewTab(current, tabId, tab => (
        tab.address === value ? tab : { ...tab, address: value }
      )),
    );
  }, [updateBrowserTabs]);

  const handleBrowserLocalServiceContextChange = useCallback((
    tabId: string,
    context: BrowserLocalServiceContext | null,
  ) => {
    updateBrowserTabs(current =>
      updateBrowserPreviewTab(current, tabId, tab => ({ ...tab, localServiceContext: context })),
    );
  }, [updateBrowserTabs]);

  const handleBrowserPreviewUrlChange = useCallback((tabId: string, value: string) => {
    let previewSessionIdToDestroy: string | null = null;
    updateBrowserTabs(current =>
      updateBrowserPreviewTab(current, tabId, tab => {
        const shouldClearHtmlPreview = Boolean(
          tab.htmlPreviewUrl && !isSameBrowserPreviewUrl(value, tab.htmlPreviewUrl),
        );
        if (shouldClearHtmlPreview && tab.htmlPreviewSessionId) {
          previewSessionIdToDestroy = tab.htmlPreviewSessionId;
        }
        const shouldClearLocalServiceContext = Boolean(
          tab.localServiceContext
          && (!value.trim() || normalizeLocalServiceOrigin(value) !== tab.localServiceContext.origin),
        );
        if (
          tab.url === value
          && !shouldClearHtmlPreview
          && !shouldClearLocalServiceContext
        ) {
          return tab;
        }
        return {
          ...tab,
          url: value,
          ...(shouldClearHtmlPreview
            ? {
                htmlPreviewArtifactId: null,
                htmlPreviewSessionId: null,
                htmlPreviewUrl: null,
              }
            : {}),
          ...(shouldClearLocalServiceContext ? { localServiceContext: null } : {}),
        };
      }),
    );
    if (previewSessionIdToDestroy) {
      void window.electron?.artifact?.destroyPreviewSession(previewSessionIdToDestroy);
    }
  }, [updateBrowserTabs]);

  const handleBrowserPreviewTitleChange = useCallback((tabId: string, value: string) => {
    const nextTitle = value.trim();
    updateBrowserTabs(current =>
      updateBrowserPreviewTab(current, tabId, tab => (
        tab.title === nextTitle ? tab : { ...tab, title: nextTitle }
      )),
    );
  }, [updateBrowserTabs]);

  const handleOpenArtifactFileListTab = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'panel_tab_open',
      source: 'artifact_panel',
      params: {
        tabType: 'file_list',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setIsFileListPreviewTabOpen(true);
    setActiveSpecialPreviewTab(ArtifactSpecialTab.FileList);
    dispatch(activateArtifactFileListTab({ sessionId: HOME_SESSION_ID }));
  }, [artifactTabsWithArtifacts.length, dispatch]);

  const handleActivateArtifactFileListTab = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      params: {
        tabType: 'file_list',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setIsFileListPreviewTabOpen(true);
    setActiveSpecialPreviewTab(ArtifactSpecialTab.FileList);
    dispatch(activateArtifactFileListTab({ sessionId: HOME_SESSION_ID }));
  }, [artifactTabsWithArtifacts.length, dispatch]);

  const handleCloseArtifactFileListTab = useCallback(() => {
    const wasActive = !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.FileList;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      params: {
        tabType: 'file_list',
        wasActive,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setIsFileListPreviewTabOpen(false);
    if (!wasActive) return;
    applyFallbackAfterSpecialClose(ArtifactSpecialTab.FileList, { hasFileListTab: false });
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    applyFallbackAfterSpecialClose,
    artifactTabsWithArtifacts.length,
  ]);

  const handleOpenArtifactBrowserTab = useCallback((options?: {
    url?: string;
    afterTabId?: string;
    background?: boolean;
    referrer?: string;
    reuseBlank?: boolean;
  }) => {
    reportArtifactPreviewAction({
      actionType: 'panel_tab_open',
      source: 'artifact_panel',
      params: {
        tabType: 'browser',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    const normalizedUrl = options?.url?.trim() ?? '';
    const newTab = createBrowserPreviewTab({
      address: normalizedUrl,
      url: normalizedUrl,
      ...(options?.referrer ? { initialReferrer: options.referrer } : {}),
    });
    if (options?.afterTabId) {
      updateBrowserTabs(current =>
        insertBrowserPreviewTabAfter(current, {
          afterTabId: options.afterTabId,
          tab: newTab,
          activate: !options.background,
        }),
      );
      if (!options.background) {
        setActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
        dispatch(activateArtifactBrowserTab({ sessionId: HOME_SESSION_ID }));
      }
      return;
    }
    updateBrowserTabs(current =>
      openOrReuseBlankBrowserPreviewTab(current, {
        tab: newTab,
        reuseBlank: options?.reuseBlank ?? !normalizedUrl,
      }).state,
    );
    setActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
    dispatch(activateArtifactBrowserTab({ sessionId: HOME_SESSION_ID }));
  }, [artifactTabsWithArtifacts.length, dispatch, updateBrowserTabs]);

  const handleActivateArtifactBrowserTab = useCallback((tabId?: string) => {
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      params: {
        tabType: 'browser',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    updateBrowserTabs(current => activateBrowserPreviewTab(current, tabId));
    setActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
    dispatch(activateArtifactBrowserTab({ sessionId: HOME_SESSION_ID }));
  }, [artifactTabsWithArtifacts.length, dispatch, updateBrowserTabs]);

  const handleCloseArtifactBrowserTab = useCallback((tabId: string) => {
    const currentState = browserTabsRef.current;
    const currentActiveBrowserTabId = getActiveBrowserPreviewTab(currentState)?.id ?? null;
    const wasActive = !activeArtifactPreviewTab
      && activeSpecialPreviewTab === ArtifactSpecialTab.Browser
      && currentActiveBrowserTabId === tabId;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      params: {
        tabType: 'browser',
        wasActive,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    const { state: nextState, closedTab, nextActiveTabId } = closeBrowserPreviewTab(currentState, tabId);
    browserTabsRef.current = nextState;
    setBrowserTabsState(nextState);
    if (closedTab?.htmlPreviewSessionId) {
      void window.electron?.artifact?.destroyPreviewSession(closedTab.htmlPreviewSessionId);
    }
    delete browserHtmlPreviewRequestIdByTabRef.current[tabId];

    if (!wasActive) return;

    if (nextActiveTabId) {
      setActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
      dispatch(activateArtifactBrowserTab({ sessionId: HOME_SESSION_ID }));
      return;
    }

    applyFallbackAfterSpecialClose(ArtifactSpecialTab.Browser, { hasBrowserTab: false });
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    applyFallbackAfterSpecialClose,
    artifactTabsWithArtifacts.length,
    dispatch,
  ]);

  const handleOpenHtmlFileInBrowser = useCallback(async (artifact: Artifact) => {
    if (artifact.type !== ArtifactTypeValue.Html || !artifact.filePath) return;
    reportArtifactPreviewAction({
      actionType: 'open_lobster_browser',
      source: 'artifact_panel',
      artifact,
      params: { openTarget: 'lobster_browser' },
    });

    const targetDisplayArtifactId = resolveArtifactIdForDisplay(
      rawHomeArtifacts,
      artifact.id,
      { defaultProjectDirectory: workingDirectory || undefined },
    );
    const currentState = browserTabsRef.current;
    const existingTab = currentState.tabs.find(tab => (
      tab.htmlPreviewArtifactId
      && resolveArtifactIdForDisplay(
        rawHomeArtifacts,
        tab.htmlPreviewArtifactId,
        { defaultProjectDirectory: workingDirectory || undefined },
      ) === targetDisplayArtifactId
    ));

    let targetTabId: string;
    const previousPreviewSessionId = existingTab?.htmlPreviewSessionId ?? null;
    if (existingTab) {
      targetTabId = existingTab.id;
      updateBrowserTabs(current =>
        activateBrowserPreviewTab(
          updateBrowserPreviewTab(current, targetTabId, tab => ({
            ...tab,
            localServiceContext: null,
          })),
          targetTabId,
        ),
      );
    } else {
      const pendingTab = createBrowserPreviewTab({
        address: artifact.filePath,
        htmlPreviewArtifactId: artifact.id,
      });
      let createdTabId = pendingTab.id;
      updateBrowserTabs(current => {
        const opened = openOrReuseBlankBrowserPreviewTab(current, {
          tab: pendingTab,
          reuseBlank: true,
        });
        createdTabId = opened.tabId;
        return opened.state;
      });
      targetTabId = createdTabId;
    }

    setActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
    dispatch(activateArtifactBrowserTab({ sessionId: HOME_SESSION_ID }));

    const requestId = (browserHtmlPreviewRequestIdByTabRef.current[targetTabId] ?? 0) + 1;
    browserHtmlPreviewRequestIdByTabRef.current[targetTabId] = requestId;
    try {
      const result = await window.electron?.artifact?.createPreviewSession(artifact.filePath);
      const tabStillOpen = browserTabsRef.current.tabs.some(tab => tab.id === targetTabId);
      if (
        !mountedRef.current
        || browserHtmlPreviewRequestIdByTabRef.current[targetTabId] !== requestId
        || !tabStillOpen
      ) {
        if (result?.success && result.sessionId) {
          void window.electron?.artifact?.destroyPreviewSession(result.sessionId);
        }
        return;
      }
      if (!result?.success || !result.url || !result.sessionId) {
        throw new Error(result?.error || i18nService.t('artifactSourceLoadFailed'));
      }
      if (previousPreviewSessionId && previousPreviewSessionId !== result.sessionId) {
        void window.electron?.artifact?.destroyPreviewSession(previousPreviewSessionId);
      }
      updateBrowserTabs(current =>
        updateBrowserPreviewTab(current, targetTabId, tab => ({
          ...tab,
          address: artifact.filePath!,
          url: result.url!,
          title: '',
          localServiceContext: null,
          htmlPreviewArtifactId: artifact.id,
          htmlPreviewSessionId: result.sessionId!,
          htmlPreviewUrl: result.url!,
        })),
      );
    } catch (error) {
      if (!previousPreviewSessionId) {
        updateBrowserTabs(current =>
          updateBrowserPreviewTab(current, targetTabId, tab => ({
            ...tab,
            htmlPreviewArtifactId: null,
            htmlPreviewSessionId: null,
            htmlPreviewUrl: null,
          })),
        );
      }
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: error instanceof Error ? error.message : i18nService.t('artifactSourceLoadFailed'),
      }));
    }
  }, [dispatch, rawHomeArtifacts, updateBrowserTabs, workingDirectory]);

  const handleOpenLocalServiceArtifact = useCallback((artifact: Artifact) => {
    const url = artifact.url || artifact.content;
    if (!url) return;
    const origin = artifact.localService?.origin || normalizeLocalServiceOrigin(url);
    const projectDirectory = artifact.localService?.projectDirectory?.trim();
    const localServiceContext: BrowserLocalServiceContext = {
      artifactId: artifact.id,
      url,
      origin,
      ...(projectDirectory ? { projectDirectory } : {}),
      ...(artifact.localService?.projectCandidates?.length
        ? { projectCandidates: artifact.localService.projectCandidates }
        : {}),
    };
    const currentState = browserTabsRef.current;
    const existingTab = currentState.tabs.find(tab => (
      tab.localServiceContext?.artifactId === artifact.id
      || isSameBrowserPreviewUrl(tab.url, url)
    ));
    let previewSessionIdToDestroy: string | null = null;
    if (existingTab) {
      if (existingTab.htmlPreviewSessionId) {
        previewSessionIdToDestroy = existingTab.htmlPreviewSessionId;
      }
      updateBrowserTabs(current =>
        activateBrowserPreviewTab(
          updateBrowserPreviewTab(current, existingTab.id, tab => ({
            ...tab,
            address: url,
            url,
            title: isSameBrowserPreviewUrl(tab.url, url) ? tab.title : '',
            localServiceContext,
            htmlPreviewArtifactId: null,
            htmlPreviewSessionId: null,
            htmlPreviewUrl: null,
          })),
          existingTab.id,
        ),
      );
    } else {
      updateBrowserTabs(current =>
        openOrReuseBlankBrowserPreviewTab(current, {
          tab: createBrowserPreviewTab({
            address: url,
            url,
            localServiceContext,
          }),
          reuseBlank: true,
        }).state,
      );
    }
    if (previewSessionIdToDestroy) {
      void window.electron?.artifact?.destroyPreviewSession(previewSessionIdToDestroy);
    }
    setActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
    dispatch(activateArtifactBrowserTab({ sessionId: HOME_SESSION_ID }));
  }, [dispatch, updateBrowserTabs]);

  const handleOpenArtifactNewTab = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'panel_tab_open',
      source: 'artifact_panel',
      params: {
        tabType: 'new_tab',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setIsNewTabPreviewTabOpen(true);
    setActiveSpecialPreviewTab(ArtifactSpecialTab.NewTab);
    dispatch(activateArtifactNewTab({ sessionId: HOME_SESSION_ID }));
  }, [artifactTabsWithArtifacts.length, dispatch]);

  const handleActivateArtifactNewTab = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      params: {
        tabType: 'new_tab',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setIsNewTabPreviewTabOpen(true);
    setActiveSpecialPreviewTab(ArtifactSpecialTab.NewTab);
    dispatch(activateArtifactNewTab({ sessionId: HOME_SESSION_ID }));
  }, [artifactTabsWithArtifacts.length, dispatch]);

  const handleCloseArtifactNewTab = useCallback(() => {
    const wasActive = !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.NewTab;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      params: {
        tabType: 'new_tab',
        wasActive,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setIsNewTabPreviewTabOpen(false);
    if (!wasActive) return;
    applyFallbackAfterSpecialClose(ArtifactSpecialTab.NewTab, { hasNewTab: false });
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    applyFallbackAfterSpecialClose,
    artifactTabsWithArtifacts.length,
  ]);

  const handleNewTabSelectArtifact = useCallback((artifactId: string) => {
    setIsNewTabPreviewTabOpen(false);
    const target = homeArtifacts.find(item => item.id === artifactId);
    if (target?.type === ArtifactTypeValue.Html && target.filePath) {
      void handleOpenHtmlFileInBrowser(target);
      return;
    }
    if (target?.type === ArtifactTypeValue.LocalService) {
      handleOpenLocalServiceArtifact(target);
      return;
    }
    dispatch(openArtifactPreviewTab({ sessionId: HOME_SESSION_ID, artifactId }));
  }, [dispatch, handleOpenHtmlFileInBrowser, handleOpenLocalServiceArtifact, homeArtifacts]);

  const openWorkspaceFileInPanel = useCallback(async (filePath: string): Promise<boolean> => {
    if (!filePath.trim()) return false;
    const target = resolveWorkspaceFileOpenTarget(filePath, homeArtifacts, {
      sessionId: HOME_SESSION_ID,
      cwd: workingDirectory || undefined,
    });
    if (!target || target.kind === WorkspaceFileOpenTargetKind.System) {
      return false;
    }

    const showArtifact = (artifact: Artifact) => {
      if (artifact.type === ArtifactTypeValue.Html && artifact.filePath) {
        void handleOpenHtmlFileInBrowser(artifact);
        return;
      }
      dispatch(openArtifactPreviewTab({ sessionId: HOME_SESSION_ID, artifactId: artifact.id }));
    };

    if (target.kind === WorkspaceFileOpenTargetKind.Existing) {
      showArtifact(target.artifact);
      return true;
    }

    const loaded = await loadWorkspaceFileArtifact(target, workingDirectory || undefined);
    if (!loaded) return false;
    dispatch(addLinkedFileArtifact({ sessionId: HOME_SESSION_ID, artifact: loaded }));
    showArtifact(loaded);
    return true;
  }, [dispatch, handleOpenHtmlFileInBrowser, homeArtifacts, workingDirectory]);

  const handleOpenWorkspaceFilePath = useCallback(async (filePath: string) => {
    if (!filePath.trim()) return;
    const opened = await openWorkspaceFileInPanel(filePath);
    if (opened) return;
    await openWorkspaceDirectoryInSystem(filePath);
  }, [openWorkspaceFileInPanel]);

  const handleNewTabOpenLocalFilePath = useCallback(async (filePath: string) => {
    if (!filePath.trim()) return;
    const opened = await openWorkspaceFileInPanel(filePath);
    if (opened) {
      setIsNewTabPreviewTabOpen(false);
      return;
    }
    await openWorkspaceDirectoryInSystem(filePath);
  }, [openWorkspaceFileInPanel]);

  const handleNewTabOpenLocalFilePicker = useCallback(async () => {
    const picked = await pickLocalFileForPreview(i18nService.t('artifactNewTabOpenLocalFile'));
    if (!picked) return;
    await handleNewTabOpenLocalFilePath(picked);
  }, [handleNewTabOpenLocalFilePath]);

  const handleNewTabCreateBlankDocument = useCallback(async (kind: BlankDocumentKind) => {
    const baseNameKeyByKind: Record<BlankDocumentKind, string> = {
      [BlankDocumentKind.Word]: 'artifactBlankWordName',
      [BlankDocumentKind.Slides]: 'artifactBlankSlidesName',
      [BlankDocumentKind.Sheet]: 'artifactBlankSheetName',
      [BlankDocumentKind.Markdown]: 'artifactBlankMarkdownName',
    };
    const result = await createBlankWorkspaceDocument({
      sessionId: HOME_SESSION_ID,
      cwd: workingDirectory || undefined,
      kind,
      baseName: i18nService.t(baseNameKeyByKind[kind]),
    });
    if (!result.success) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: result.error || i18nService.t('artifactCreateBlankDocumentFailed'),
      }));
      return;
    }
    if (kind === BlankDocumentKind.Word) {
      requestOfficeAutoFocus(result.filePath);
    }
    await handleNewTabOpenLocalFilePath(result.filePath);
  }, [handleNewTabOpenLocalFilePath, workingDirectory]);

  const handleNewTabOpenFileList = useCallback(() => {
    setIsNewTabPreviewTabOpen(false);
    handleOpenArtifactFileListTab();
  }, [handleOpenArtifactFileListTab]);

  const handleNewTabOpenBrowserUrl = useCallback((url?: string) => {
    setIsNewTabPreviewTabOpen(false);
    const trimmed = url?.trim();
    if (trimmed) {
      const localService = findLocalServiceArtifactForUrl(trimmed, homeArtifacts);
      if (localService) {
        handleOpenLocalServiceArtifact({ ...localService, url: trimmed, content: trimmed });
        return;
      }
      handleOpenArtifactBrowserTab({ url: trimmed, reuseBlank: true });
      return;
    }
    handleOpenArtifactBrowserTab();
  }, [handleOpenArtifactBrowserTab, handleOpenLocalServiceArtifact, homeArtifacts]);

  const handleActivateArtifactTab = useCallback((tabId: string) => {
    const artifact = artifactTabsWithArtifacts.find(item => item.tab.id === tabId)?.artifact;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      artifact,
      params: {
        tabType: 'artifact',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    dispatch(activateArtifactPreviewTab({ sessionId: HOME_SESSION_ID, tabId }));
  }, [artifactTabsWithArtifacts, dispatch]);

  const handleStartArtifactTabRename = useCallback((tabId: string) => {
    const item = artifactTabsWithArtifacts.find(({ tab }) => tab.id === tabId);
    if (!item || !canRenameArtifactFile(item.artifact)) return;
    if (activeArtifactPreviewTab?.id !== tabId) {
      dispatch(activateArtifactPreviewTab({ sessionId: HOME_SESSION_ID, tabId }));
    }
    setRenamingArtifactTabId(tabId);
  }, [activeArtifactPreviewTab?.id, artifactTabsWithArtifacts, dispatch]);

  const handleCommitArtifactTabRename = useCallback(async (artifact: Artifact, nextStem: string) => (
    commitArtifactFileRename({
      sessionId: HOME_SESSION_ID,
      artifact,
      nextStem,
      dispatch,
    })
  ), [dispatch]);

  const handleCloseArtifactTab = useCallback((tabId: string) => {
    setRenamingArtifactTabId(current => (current === tabId ? null : current));
    const artifact = artifactTabsWithArtifacts.find(item => item.tab.id === tabId)?.artifact;
    const remainingTabs = artifactTabsWithArtifacts.filter(({ tab }) => tab.id !== tabId);
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      artifact,
      params: {
        tabType: 'artifact',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    dispatch(closeArtifactPreviewTab({ sessionId: HOME_SESSION_ID, tabId }));
    if (
      remainingTabs.length === 0
      && !isNewTabPreviewTabOpen
      && !isFileListPreviewTabOpen
      && !isBrowserPreviewTabOpen
    ) {
      dispatch(closePanel({ sessionId: HOME_SESSION_ID }));
    }
  }, [
    artifactTabsWithArtifacts,
    dispatch,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isNewTabPreviewTabOpen,
  ]);

  const handleToggleArtifactPanelExpanded = useCallback(() => {
    setIsArtifactPanelExpanded(value => {
      const nextValue = !value;
      reportArtifactPreviewAction({
        actionType: 'panel_expand_toggle',
        source: 'artifact_panel',
        params: {
          targetExpanded: nextValue,
          tabCount: artifactTabsWithArtifacts.length,
        },
      });
      if (!nextValue) {
        setIsExpandedPromptInputHidden(false);
      }
      return nextValue;
    });
  }, [artifactTabsWithArtifacts.length]);

  const handleToggleExpandedPromptInput = useCallback(() => {
    setIsExpandedPromptInputHidden(value => !value);
  }, []);

  const handleToggleArtifactPanel = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'panel_toggle',
      source: 'artifact_panel',
      params: {
        targetOpen: !isPanelOpen,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    if (isPanelOpen) {
      dispatch(closePanel({ sessionId: HOME_SESSION_ID }));
      return;
    }

    if (
      artifactTabsWithArtifacts.length === 0
      && !isNewTabPreviewTabOpen
      && !isFileListPreviewTabOpen
      && !isBrowserPreviewTabOpen
    ) {
      setIsNewTabPreviewTabOpen(true);
      setActiveSpecialPreviewTab(ArtifactSpecialTab.NewTab);
      dispatch(activateArtifactNewTab({ sessionId: HOME_SESSION_ID }));
      return;
    }

    dispatch(togglePanel({ sessionId: HOME_SESSION_ID }));
  }, [
    artifactTabsWithArtifacts.length,
    dispatch,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isNewTabPreviewTabOpen,
    isPanelOpen,
  ]);

  useEffect(() => {
    if (!isActive) return undefined;
    window.addEventListener(CoworkUiEvent.ShortcutToggleArtifacts, handleToggleArtifactPanel);
    return () => {
      window.removeEventListener(CoworkUiEvent.ShortcutToggleArtifacts, handleToggleArtifactPanel);
    };
  }, [handleToggleArtifactPanel, isActive]);

  const handleAddSelectedTextSnippet = useCallback((snippet: CoworkSelectedTextSnippet) => {
    const result = normalizeCoworkSelectedTextSnippets([...selectedDraftSnippets, snippet]);
    if (result.success === false) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t(SELECTED_TEXT_ERROR_I18N_KEYS[result.error]),
      }));
      return;
    }
    dispatch(addDraftSelectedTextSnippet({ draftKey: HOME_SESSION_ID, snippet }));
    requestAnimationFrame(() => promptInputRef.current?.focus());
  }, [dispatch, promptInputRef, selectedDraftSnippets]);

  const handleAnnotationSendRequest = useCallback(() => {
    promptInputRef.current?.submit();
  }, [promptInputRef]);

  const handleClosePanel = useCallback(() => {
    dispatch(closePanel({ sessionId: HOME_SESSION_ID }));
  }, [dispatch]);

  const updateArtifactTabsScrollState = useCallback(() => {
    const element = artifactTabsScrollRef.current;
    if (!element) {
      setArtifactTabsCanScrollLeft(false);
      setArtifactTabsCanScrollRight(false);
      setArtifactTabsIsOverflowing(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setArtifactTabsCanScrollLeft(element.scrollLeft > 1);
    setArtifactTabsCanScrollRight(element.scrollLeft < maxScrollLeft - 1);
    setArtifactTabsIsOverflowing(element.scrollWidth > element.clientWidth + 1);
  }, []);

  useLayoutEffect(() => {
    const container = artifactTabsScrollRef.current;
    if (!isActive || !container || !isArtifactPanelVisible) return undefined;

    const animationFrame = window.requestAnimationFrame(() => {
      const activeTab = container.querySelector<HTMLElement>('[data-artifact-preview-active="true"]');
      if (!activeTab) {
        updateArtifactTabsScrollState();
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const activeRect = activeTab.getBoundingClientRect();
      const visibleLeft = containerRect.left;
      const visibleRight = containerRect.right - (shouldPinArtifactAddTab ? 36 : 0);
      const padding = 8;

      if (activeRect.left < visibleLeft + padding) {
        container.scrollLeft -= visibleLeft + padding - activeRect.left;
      } else if (activeRect.right > visibleRight - padding) {
        container.scrollLeft += activeRect.right - visibleRight + padding;
      }

      updateArtifactTabsScrollState();
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [
    activeArtifactPreviewTab?.id,
    activeBrowserTabId,
    activeSpecialPreviewTab,
    browserTabs.length,
    isActive,
    isArtifactPanelVisible,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isNewTabPreviewTabOpen,
    shouldPinArtifactAddTab,
    updateArtifactTabsScrollState,
  ]);

  useLayoutEffect(() => {
    const element = artifactTabsScrollRef.current;
    if (!isActive || !element || !isArtifactPanelVisible) {
      setArtifactTabsCanScrollLeft(false);
      setArtifactTabsCanScrollRight(false);
      setArtifactTabsIsOverflowing(false);
      return undefined;
    }

    updateArtifactTabsScrollState();
    const animationFrame = window.requestAnimationFrame(updateArtifactTabsScrollState);
    element.addEventListener('scroll', updateArtifactTabsScrollState, { passive: true });

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateArtifactTabsScrollState)
      : null;
    resizeObserver?.observe(element);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      element.removeEventListener('scroll', updateArtifactTabsScrollState);
      resizeObserver?.disconnect();
    };
  }, [
    activeArtifactPreviewTab?.id,
    activeBrowserTabId,
    activeSpecialPreviewTab,
    artifactPanelMaxWidth,
    artifactPanelMinWidth,
    artifactTabsWithArtifacts.length,
    browserTabs.length,
    isActive,
    isArtifactPanelVisible,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isNewTabPreviewTabOpen,
    panelWidth,
    updateArtifactTabsScrollState,
  ]);

  const artifactTabActionTargets: ArtifactTabActionTarget[] = [
    ...(isFileListPreviewTabOpen ? [{
      id: ArtifactSpecialTab.FileList,
      active: !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.FileList,
      activate: handleActivateArtifactFileListTab,
      close: handleCloseArtifactFileListTab,
    }] : []),
    ...browserTabs.map(tab => ({
      id: tab.id,
      active: !activeArtifactPreviewTab
        && activeSpecialPreviewTab === ArtifactSpecialTab.Browser
        && activeBrowserTabId === tab.id,
      activate: () => handleActivateArtifactBrowserTab(tab.id),
      close: () => handleCloseArtifactBrowserTab(tab.id),
    })),
    ...artifactTabsWithArtifacts.map(({ tab }) => ({
      id: tab.id,
      active: tab.id === activeArtifactPreviewTab?.id,
      activate: () => handleActivateArtifactTab(tab.id),
      close: () => handleCloseArtifactTab(tab.id),
    })),
    ...(isNewTabPreviewTabOpen ? [{
      id: ArtifactSpecialTab.NewTab,
      active: !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.NewTab,
      activate: handleActivateArtifactNewTab,
      close: handleCloseArtifactNewTab,
    }] : []),
  ];

  const layout = computeArtifactPanelLayout({
    panelWidth,
    contentRowWidth,
    artifactPanelMinWidth,
    artifactPanelMaxWidth,
    isArtifactPanelVisible,
    isArtifactPanelTransitioning,
    isArtifactPanelExpanded,
    isExpandedPromptInputHidden,
    promptInputAreaHeight,
  });

  return {
    sessionId: HOME_SESSION_ID,
    isPanelOpen,
    shouldRenderArtifactPanel,
    isArtifactPanelVisible,
    isArtifactPanelTransitioning,
    isArtifactPanelExpanded,
    isExpandedPromptInputHidden,
    artifactPanelMaxWidth,
    layout,
    contentRowRef,
    promptInputAreaRef,
    artifactTabsScrollRef,
    homeArtifacts,
    artifactTabsWithArtifacts,
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    isNewTabPreviewTabOpen,
    isFileListPreviewTabOpen,
    browserTabs,
    browserTabsForPanel,
    activeBrowserTabId,
    renamingArtifactTabId,
    setRenamingArtifactTabId,
    shouldShowArtifactAddButton,
    shouldPinArtifactAddTab,
    artifactTabsCanScrollLeft,
    artifactTabsCanScrollRight,
    artifactTabActionTargets,
    handleToggleArtifactPanel,
    handleToggleArtifactPanelExpanded,
    handleToggleExpandedPromptInput,
    handleClosePanel,
    handleOpenArtifactNewTab,
    handleActivateArtifactNewTab,
    handleCloseArtifactNewTab,
    handleOpenArtifactFileListTab,
    handleActivateArtifactFileListTab,
    handleCloseArtifactFileListTab,
    handleOpenArtifactBrowserTab,
    handleActivateArtifactBrowserTab,
    handleCloseArtifactBrowserTab,
    handleOpenHtmlFileInBrowser,
    handleOpenLocalServiceArtifact,
    handleBrowserPreviewAddressChange,
    handleBrowserPreviewUrlChange,
    handleBrowserPreviewTitleChange,
    handleBrowserLocalServiceContextChange,
    handleNewTabSelectArtifact,
    handleOpenWorkspaceFilePath,
    handleNewTabOpenLocalFilePath,
    handleNewTabOpenLocalFilePicker,
    handleNewTabCreateBlankDocument,
    handleNewTabOpenFileList,
    handleNewTabOpenBrowserUrl,
    handleActivateArtifactTab,
    handleStartArtifactTabRename,
    handleCommitArtifactTabRename,
    handleCloseArtifactTab,
    handleAddSelectedTextSnippet,
    handleAnnotationSendRequest,
  };
}
