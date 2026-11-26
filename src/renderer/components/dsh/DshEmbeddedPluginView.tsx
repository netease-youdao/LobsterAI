import {
  ArrowPathIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  PuzzlePieceIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  type DshEmbeddedPluginTarget,
  dshHostService,
} from '@/services/dshHost';
import { i18nService } from '@/services/i18n';

import { DSH_ECOSYSTEM_PARTITION } from '../../../shared/dshEngine/hostConstants';
import { MANAGEMENT_PAGE_TITLE_TEXT } from '../common/managementTypography';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import { MAC_TRAFFIC_LIGHT_INSET_CLASS } from '../window/windowZoom';
import {
  buildDshEmbeddedPluginHash,
  buildDshEmbeddedPluginUrl,
} from './pluginViewModel';

interface DshPluginWebviewElement extends HTMLElement {
  reload?: () => void;
  executeJavaScript?: (code: string) => Promise<unknown>;
  getURL?: () => string;
}

interface DshWebviewFailLoadEvent extends Event {
  errorCode?: number;
  errorDescription?: string;
  isMainFrame?: boolean;
}

export interface DshEmbeddedPluginViewProps {
  plugin: DshEmbeddedPluginTarget;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  onManagePlugins?: () => void;
  updateBadge?: React.ReactNode;
}

const readDocumentTheme = (): 'light' | 'dark' =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';

export const DshEmbeddedPluginView: React.FC<DshEmbeddedPluginViewProps> = ({
  plugin,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  onManagePlugins,
  updateBadge,
}) => {
  const t = (key: string) => i18nService.t(key);
  const language: 'zh' | 'en' = i18nService.getLanguage() === 'en' ? 'en' : 'zh';
  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';

  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(readDocumentTheme);
  const [initialWebviewUrl, setInitialWebviewUrl] = useState<string | null>(null);
  const [webviewMountKey, setWebviewMountKey] = useState(0);
  const [isLoadingUrl, setIsLoadingUrl] = useState(true);
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const webviewRef = useRef<DshPluginWebviewElement | null>(null);
  const [webviewNode, setWebviewNode] = useState<DshPluginWebviewElement | null>(null);
  const latestOriginRef = useRef<string | null>(null);
  const latestTargetRef = useRef({
    panelId: plugin.panelId,
    theme: effectiveTheme,
    language,
  });
  latestTargetRef.current = {
    panelId: plugin.panelId,
    theme: effectiveTheme,
    language,
  };

  // Keep embedded DSH plugin appearance aligned with LobsterAI's live light/dark theme.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
    const syncTheme = () => setEffectiveTheme(readDocumentTheme());
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  const fetchAuthenticatedUrl = useCallback(async (forceRemount = false) => {
    setIsLoadingUrl(true);
    setLoadError(null);
    try {
      const res = await dshHostService.getWebUrl();
      if (!res?.ok || !res.url) {
        setLoadError(res?.error || t('dshPluginsEmbeddedHostUnavailable'));
        setInitialWebviewUrl(null);
        return;
      }
      let nextOrigin: string | null = null;
      try {
        nextOrigin = new URL(res.url).origin;
      } catch {
        nextOrigin = null;
      }
      const originChanged = !latestOriginRef.current || latestOriginRef.current !== nextOrigin;
      if (originChanged || forceRemount || !initialWebviewUrl) {
        latestOriginRef.current = nextOrigin;
        setIsWebviewReady(false);
        const { panelId, theme, language: lang } = latestTargetRef.current;
        setInitialWebviewUrl(
          buildDshEmbeddedPluginUrl(res.url, { panelId, theme, language: lang }),
        );
        setWebviewMountKey((prev) => prev + 1);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setInitialWebviewUrl(null);
    } finally {
      setIsLoadingUrl(false);
    }
  }, [initialWebviewUrl]);

  useEffect(() => {
    void fetchAuthenticatedUrl(false);
    // Run on initial mount; subsequent panel/theme/lang changes update hash in-place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleWebviewRef = useCallback((node: DshPluginWebviewElement | null) => {
    if (webviewRef.current === node) return;
    webviewRef.current = node;
    setIsWebviewReady(false);
    setWebviewNode(node);
  }, []);

  const syncEmbedHash = useCallback((node: DshPluginWebviewElement | null) => {
    if (!node?.executeJavaScript) return;
    const { panelId, theme, language: lang } = latestTargetRef.current;
    const nextHash = `#${buildDshEmbeddedPluginHash({ panelId, theme, language: lang })}`;
    void node
      .executeJavaScript(
        `if (window.location.hash !== ${JSON.stringify(nextHash)}) { window.location.hash = ${JSON.stringify(nextHash)}; }`,
      )
      .catch(() => {
        // Ignore transient execution errors during navigation/teardown.
      });
  }, []);

  useEffect(() => {
    if (!webviewNode) return undefined;

    const handleDomReady = () => {
      setLoadError(null);
      setIsWebviewReady(true);
      syncEmbedHash(webviewNode);
    };

    const handleFailLoad = (event: Event) => {
      const failEvent = event as DshWebviewFailLoadEvent;
      // Ignore ERR_ABORTED (-3, fired during normal 303 auth redirects) and subframes.
      if (failEvent.errorCode === -3 || failEvent.isMainFrame === false) {
        return;
      }
      setLoadError(failEvent.errorDescription || t('dshPluginsEmbeddedLoadFailed'));
      setIsWebviewReady(true);
    };

    webviewNode.addEventListener('dom-ready', handleDomReady);
    webviewNode.addEventListener('did-fail-load', handleFailLoad);
    return () => {
      webviewNode.removeEventListener('dom-ready', handleDomReady);
      webviewNode.removeEventListener('did-fail-load', handleFailLoad);
    };
  }, [syncEmbedHash, webviewNode]);

  // Switch plugin panel / theme / language instantaneously without reloading the webview.
  useEffect(() => {
    if (!isWebviewReady || !webviewNode) return;
    syncEmbedHash(webviewNode);
  }, [effectiveTheme, isWebviewReady, language, plugin.panelId, syncEmbedHash, webviewNode]);

  const handleReload = () => {
    setLoadError(null);
    if (webviewRef.current && initialWebviewUrl && isWebviewReady) {
      setIsWebviewReady(false);
      webviewRef.current.reload?.();
      return;
    }
    void fetchAuthenticatedUrl(true);
  };

  const showLoadingOverlay = (isLoadingUrl || (Boolean(initialWebviewUrl) && !isWebviewReady)) && !loadError;

  return (
    <div
      data-skin-management-page="true"
      className="relative z-10 flex h-full flex-col bg-background"
    >
      {/* Native LobsterAI Header Strip */}
      <div className="draggable flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2.5 h-8">
          {isSidebarCollapsed && !isWindows && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? MAC_TRAFFIC_LIGHT_INSET_CLASS : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                aria-label={t('expand')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                aria-label={t('newChat')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}

          <div className="flex min-w-0 items-center gap-2">
            {plugin.icon ? (
              <img
                src={plugin.icon}
                alt=""
                className="h-[18px] w-[18px] shrink-0 rounded object-contain"
              />
            ) : (
              <PuzzlePieceIcon className="h-[18px] w-[18px] shrink-0 text-secondary" />
            )}
            <h1 className={`truncate ${MANAGEMENT_PAGE_TITLE_TEXT} font-semibold text-foreground`}>
              {plugin.title}
            </h1>
          </div>
        </div>

        <div className="non-draggable flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleReload}
            title={t('dshPluginsEmbeddedReload')}
            aria-label={t('dshPluginsEmbeddedReload')}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <ArrowPathIcon className={`h-4 w-4 ${showLoadingOverlay ? 'animate-spin' : ''}`} />
          </button>

          {onManagePlugins && (
            <button
              type="button"
              onClick={onManagePlugins}
              title={t('dshPluginsEmbeddedManage')}
              aria-label={t('dshPluginsEmbeddedManage')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <Cog6ToothIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Chromeless Embedded Plugin Content */}
      <div className="relative flex-1 min-h-0 bg-background">
        {initialWebviewUrl && !loadError && (
          React.createElement('webview', {
            key: webviewMountKey,
            ref: handleWebviewRef,
            src: initialWebviewUrl,
            partition: DSH_ECOSYSTEM_PARTITION,
            className: 'h-full w-full',
            allowpopups: 'true',
          })
        )}

        {showLoadingOverlay && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-background">
            <ArrowPathIcon className="h-5 w-5 animate-spin text-secondary" />
            <p className="text-xs text-secondary">{t('dshPluginsEmbeddedLoading')}</p>
          </div>
        )}

        {loadError && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-amber-400/15 text-amber-600 dark:text-amber-400">
              <ExclamationTriangleIcon className="h-5 w-5" />
            </span>
            <h2 className="mt-3 text-sm font-medium text-foreground">
              {t('dshPluginsEmbeddedLoadFailed')}
            </h2>
            <p className="mt-1 max-w-md text-xs text-secondary">{loadError}</p>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void fetchAuthenticatedUrl(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-action px-3.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
              >
                <ArrowPathIcon className="h-3.5 w-3.5" />
                {t('dshPluginsEmbeddedRetry')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
