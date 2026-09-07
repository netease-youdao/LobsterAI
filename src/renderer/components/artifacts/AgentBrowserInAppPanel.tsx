import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ComputerDesktopIcon,
  EllipsisVerticalIcon,
  KeyIcon,
  StopIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  BrowserCredentialLoginStatus,
  BrowserCredentialSaveDecision,
} from '@shared/browserCredentials/constants';
import {
  AgentBrowserHostMenuAction,
  type AgentBrowserHostResponse,
  type AgentBrowserHostState,
  AgentBrowserPageUrl,
} from '@shared/browserWebAccess/constants';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import AgentBrowserTabStrip from './AgentBrowserTabStrip';

interface AgentBrowserInAppPanelProps {
  sessionId: string;
  visible: boolean;
}

const AGENT_BROWSER_MENU_ESTIMATED_WIDTH = 224;

const applyResponseState = (
  response: AgentBrowserHostResponse,
  setState: React.Dispatch<React.SetStateAction<AgentBrowserHostState | null>>,
): void => {
  if (response.state) setState(response.state);
};

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const AgentBrowserInAppPanel: React.FC<AgentBrowserInAppPanelProps> = ({
  sessionId,
  visible,
}) => {
  const [state, setState] = useState<AgentBrowserHostState | null>(null);
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resolvingCredentialSave, setResolvingCredentialSave] = useState(false);
  const [browserMenuActionPending, setBrowserMenuActionPending] = useState(false);
  const browserViewportRef = useRef<HTMLDivElement>(null);
  const addressFocusedRef = useRef(false);
  const syncFrameRef = useRef<number | null>(null);
  const browserMenuButtonRef = useRef<HTMLButtonElement>(null);

  const selectedTab = state?.tabs.find(tab => tab.pageId === state.selectedPageId);
  const credentialLoginBusy = state?.credentialLogin?.status === BrowserCredentialLoginStatus.AwaitingApproval
    || state?.credentialLogin?.status === BrowserCredentialLoginStatus.SigningIn;
  const browserControlsBusy = credentialLoginBusy || browserMenuActionPending;
  const credentialLoginStatusKey = state?.credentialLogin
    ? {
        [BrowserCredentialLoginStatus.AwaitingApproval]: 'agentBrowserCredentialAwaitingApproval',
        [BrowserCredentialLoginStatus.SigningIn]: 'agentBrowserCredentialSigningIn',
        [BrowserCredentialLoginStatus.Authenticated]: 'agentBrowserCredentialAuthenticated',
        [BrowserCredentialLoginStatus.Submitted]: 'agentBrowserCredentialSubmitted',
        [BrowserCredentialLoginStatus.NeedsMfa]: 'agentBrowserCredentialNeedsMfa',
        [BrowserCredentialLoginStatus.NeedsCaptcha]: 'agentBrowserCredentialNeedsCaptcha',
        [BrowserCredentialLoginStatus.Denied]: 'agentBrowserCredentialDenied',
        [BrowserCredentialLoginStatus.Failed]: 'agentBrowserCredentialFailed',
      }[state.credentialLogin.status]
    : undefined;

  useEffect(() => {
    if (!addressFocusedRef.current) {
      setAddress(selectedTab?.url === AgentBrowserPageUrl.Blank ? '' : selectedTab?.url ?? '');
    }
  }, [selectedTab?.url]);

  useEffect(() => {
    const browserApi = window.electron?.openclaw?.browser;
    if (!browserApi) return undefined;
    let cancelled = false;
    void browserApi.getHostState({ sessionId }).then(response => {
      if (!cancelled) applyResponseState(response, setState);
    }).catch(() => {});
    const unsubscribe = browserApi.onHostState(event => {
      setState(event.state);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  const syncNativeView = useCallback(async (): Promise<void> => {
    const browserApi = window.electron?.openclaw?.browser;
    const element = browserViewportRef.current;
    if (!browserApi || !element) return;
    const rect = element.getBoundingClientRect();
    const centerX = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const centerY = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(centerX, centerY);
    const unobscured = Boolean(hit && (hit === element || element.contains(hit)));
    const shouldShow = visible
      && rect.width >= 2
      && rect.height >= 2
      && unobscured;
    try {
      const response = await browserApi.setHostView({
        sessionId,
        visible: shouldShow,
        ...(shouldShow
          ? {
              bounds: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
              },
            }
          : {}),
      });
      applyResponseState(response, setState);
    } catch {
      // The native view may be unavailable while the Electron window is closing.
    }
  }, [sessionId, visible]);

  const scheduleNativeViewSync = useCallback(() => {
    if (syncFrameRef.current !== null) window.cancelAnimationFrame(syncFrameRef.current);
    syncFrameRef.current = window.requestAnimationFrame(() => {
      syncFrameRef.current = null;
      void syncNativeView();
    });
  }, [syncNativeView]);

  useEffect(() => {
    const element = browserViewportRef.current;
    if (!element) return undefined;
    const resizeObserver = new ResizeObserver(scheduleNativeViewSync);
    resizeObserver.observe(element);
    const mutationObserver = new MutationObserver(scheduleNativeViewSync);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    window.addEventListener('resize', scheduleNativeViewSync);
    window.addEventListener('scroll', scheduleNativeViewSync, true);
    scheduleNativeViewSync();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', scheduleNativeViewSync);
      window.removeEventListener('scroll', scheduleNativeViewSync, true);
      if (syncFrameRef.current !== null) window.cancelAnimationFrame(syncFrameRef.current);
      void window.electron?.openclaw?.browser.setHostView({ sessionId, visible: false });
    };
  }, [scheduleNativeViewSync, sessionId]);

  const runAction = useCallback(async (
    action: () => Promise<AgentBrowserHostResponse>,
  ) => {
    const response = await action();
    applyResponseState(response, setState);
    return response;
  }, []);

  const handleNavigate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!address.trim()) return;
    setSubmitting(true);
    try {
      await runAction(() => window.electron.openclaw.browser.navigateHost({
        sessionId,
        url: address,
      }));
    } finally {
      setSubmitting(false);
    }
  };

  const resolveCredentialSavePrompt = async (
    decision: BrowserCredentialSaveDecision,
  ): Promise<void> => {
    const prompt = state?.credentialSavePrompt;
    if (!prompt || resolvingCredentialSave) return;
    setResolvingCredentialSave(true);
    try {
      await runAction(() => window.electron.openclaw.browser.resolveCredentialSavePrompt({
        sessionId,
        requestId: prompt.requestId,
        decision,
      }));
    } finally {
      setResolvingCredentialSave(false);
    }
  };

  const dismissCredentialLoginStatus = () => {
    void runAction(() => window.electron.openclaw.browser.dismissCredentialLoginStatus({
      sessionId,
    })).catch(() => {});
  };

  const handleBrowserMenu = async (): Promise<void> => {
    const button = browserMenuButtonRef.current;
    if (!button || browserMenuActionPending) return;

    const rect = button.getBoundingClientRect();
    setBrowserMenuActionPending(true);
    try {
      const menuResponse = await window.electron.openclaw.browser.showHostMenu({
        sessionId,
        x: Math.max(0, rect.right - AGENT_BROWSER_MENU_ESTIMATED_WIDTH),
        y: rect.bottom,
        darkMode: document.documentElement.classList.contains('dark'),
      });
      if (!menuResponse.success) {
        showToast(menuResponse.error || i18nService.t('agentBrowserMenuFailed'));
        return;
      }

      let response: AgentBrowserHostResponse | undefined;
      let successMessage: string | undefined;
      let failureMessage = i18nService.t('agentBrowserActionFailed');
      switch (menuResponse.action) {
        case AgentBrowserHostMenuAction.CaptureScreenshot:
          response = await runAction(() => window.electron.openclaw.browser.captureHostScreenshot({ sessionId }));
          successMessage = i18nService.t('artifactBrowserScreenshotCopied');
          failureMessage = i18nService.t('artifactBrowserScreenshotFailed');
          break;
        case AgentBrowserHostMenuAction.NewBlankPage:
          response = await runAction(() => window.electron.openclaw.browser.createHostPage({ sessionId }));
          break;
        case AgentBrowserHostMenuAction.ClearCookies:
          response = await runAction(() => window.electron.openclaw.browser.clearHostCookies({ sessionId }));
          successMessage = i18nService.t('artifactBrowserCookiesCleared');
          failureMessage = i18nService.t('artifactBrowserClearCookiesFailed');
          break;
        case AgentBrowserHostMenuAction.ClearCache:
          response = await runAction(() => window.electron.openclaw.browser.clearHostCache({ sessionId }));
          successMessage = i18nService.t('artifactBrowserCacheCleared');
          failureMessage = i18nService.t('artifactBrowserClearCacheFailed');
          break;
        default:
          return;
      }

      if (!response.success) {
        showToast(response.error || failureMessage);
      } else if (successMessage) {
        showToast(successMessage);
      }
    } catch {
      showToast(i18nService.t('agentBrowserActionFailed'));
    } finally {
      setBrowserMenuActionPending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <AgentBrowserTabStrip
        tabs={state?.tabs ?? []}
        selectedPageId={state?.selectedPageId}
        disabled={browserControlsBusy}
        onSelect={pageId => {
          void runAction(() => window.electron.openclaw.browser.selectHostPage({
            sessionId,
            pageId,
          })).catch(() => {});
        }}
        onClose={pageId => {
          void runAction(() => window.electron.openclaw.browser.closeHostPage({
            sessionId,
            pageId,
          })).catch(() => {});
        }}
        onCreate={() => {
          void runAction(() => window.electron.openclaw.browser.createHostPage({
            sessionId,
          })).catch(() => {});
        }}
      />

      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <button
          type="button"
          disabled={browserControlsBusy || !selectedTab?.canGoBack}
          onClick={() => void runAction(() => window.electron.openclaw.browser.goBackHost({ sessionId }))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-35"
          title={i18nService.t('agentBrowserBack')}
          aria-label={i18nService.t('agentBrowserBack')}
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={browserControlsBusy || !selectedTab?.canGoForward}
          onClick={() => void runAction(() => window.electron.openclaw.browser.goForwardHost({ sessionId }))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-35"
          title={i18nService.t('agentBrowserForward')}
          aria-label={i18nService.t('agentBrowserForward')}
        >
          <ArrowRightIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={browserControlsBusy || !selectedTab}
          onClick={() => void runAction(() => selectedTab?.loading
            ? window.electron.openclaw.browser.stopHost({ sessionId })
            : window.electron.openclaw.browser.reloadHost({ sessionId }))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-35"
          title={i18nService.t(selectedTab?.loading ? 'agentBrowserStop' : 'agentBrowserReload')}
          aria-label={i18nService.t(selectedTab?.loading ? 'agentBrowserStop' : 'agentBrowserReload')}
        >
          {selectedTab?.loading
            ? <StopIcon className="h-3.5 w-3.5" />
            : <ArrowPathIcon className="h-4 w-4" />}
        </button>
        <form onSubmit={handleNavigate} className="min-w-0 flex-1">
          <input
            value={address}
            onChange={event => setAddress(event.target.value)}
            onFocus={() => { addressFocusedRef.current = true; }}
            onBlur={() => { addressFocusedRef.current = false; }}
            placeholder={i18nService.t('agentBrowserAddressPlaceholder')}
            disabled={submitting || browserControlsBusy}
            className="h-7 w-full rounded-md border border-border bg-surface px-2.5 text-xs text-foreground outline-none placeholder:text-muted focus:border-primary"
          />
        </form>
        <button
          ref={browserMenuButtonRef}
          type="button"
          disabled={browserControlsBusy}
          onClick={() => void handleBrowserMenu()}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-35"
          title={i18nService.t('artifactBrowserMenu')}
          aria-label={i18nService.t('artifactBrowserMenu')}
          aria-haspopup="menu"
        >
          <EllipsisVerticalIcon className="h-4 w-4" />
        </button>
      </div>

      {state?.error ? (
        <div className="shrink-0 truncate border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-700 dark:text-amber-300" title={state.error}>
          {state.error}
        </div>
      ) : null}

      {state?.credentialSavePrompt ? (
        <div className="shrink-0 border-b border-primary/20 bg-primary/5 px-3 py-2">
          <div className="flex items-start gap-2.5">
            <KeyIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-foreground">
                {i18nService.t(state.credentialSavePrompt.updatesExisting
                  ? 'agentBrowserCredentialUpdatePromptTitle'
                  : 'agentBrowserCredentialSavePromptTitle')}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-secondary" title={`${state.credentialSavePrompt.username} · ${state.credentialSavePrompt.origin}`}>
                {state.credentialSavePrompt.username} · {state.credentialSavePrompt.origin}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">
                {i18nService.t('agentBrowserCredentialSavePromptDescription')}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                disabled={resolvingCredentialSave}
                onClick={() => void resolveCredentialSavePrompt(BrowserCredentialSaveDecision.Dismiss)}
                className="rounded-md px-2 py-1 text-[11px] text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
              >
                {i18nService.t('agentBrowserCredentialSaveNotNow')}
              </button>
              <button
                type="button"
                disabled={resolvingCredentialSave}
                onClick={() => void resolveCredentialSavePrompt(BrowserCredentialSaveDecision.Save)}
                className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {i18nService.t(state.credentialSavePrompt.updatesExisting
                  ? 'agentBrowserCredentialUpdate'
                  : 'agentBrowserCredentialSave')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {credentialLoginStatusKey ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-primary/20 bg-primary/10 px-3 py-1 text-[11px] text-primary">
          <span className="min-w-0 flex-1">{i18nService.t(credentialLoginStatusKey)}</span>
          {!credentialLoginBusy ? (
            <button
              type="button"
              onClick={dismissCredentialLoginStatus}
              className="shrink-0 rounded p-0.5 text-primary/70 transition-colors hover:bg-primary/10 hover:text-primary"
              title={i18nService.t('close')}
              aria-label={i18nService.t('close')}
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={browserViewportRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-surface"
      >
        {!state?.tabs.length ? (
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center text-secondary">
            <ComputerDesktopIcon className="h-10 w-10 text-muted" />
            <p className="text-sm">{i18nService.t('agentBrowserInAppEmpty')}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AgentBrowserInAppPanel;
