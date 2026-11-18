import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  browserLoginSession,
  type BrowserLoginSessionState,
} from '../../services/browserLoginSession';
import { copyTextToClipboard } from '../../services/clipboard';
import { i18nService } from '../../services/i18n';

const COPIED_FEEDBACK_MS = 2_000;

export const useBrowserLoginSession = (): BrowserLoginSessionState | null => (
  // The third argument serves server rendering (used by component tests).
  useSyncExternalStore(browserLoginSession.subscribe, browserLoginSession.getSnapshot, browserLoginSession.getSnapshot)
);

const writeLoginLinkLog = (level: 'info' | 'warn', message: string): void => {
  try {
    window.electron?.log?.fromRenderer?.(level, 'BrowserLogin', message);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.debug(`[BrowserLogin] renderer log unavailable: ${errorMessage}`);
  }
};

/** Copies the login link and reports success inline for a moment. */
export const useCopyLoginLink = (source: string): {
  copied: boolean;
  copy: (url: string) => Promise<void>;
} => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async (url: string) => {
    if (await copyTextToClipboard(url)) {
      writeLoginLinkLog('info', `login link copied source=${source}`);
      setCopied(true);
      return;
    }
    writeLoginLinkLog('warn', `login link copy failed source=${source}`);
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('copyFailed') }));
  }, [source]);

  return { copied, copy };
};
