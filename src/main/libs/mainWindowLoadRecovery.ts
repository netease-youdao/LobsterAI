export const MainWindowLoadErrorCode = {
  Aborted: -3,
} as const;

const MAIN_WINDOW_LOAD_ABORTED_NAME = 'ERR_ABORTED';
const DEFAULT_MAX_LOAD_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 3_000;
const DEFAULT_SLOW_LOAD_WARNING_MS = 30_000;

interface MainWindowLoadRecoveryLogger {
  debug: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface CreateDevelopmentMainWindowLoadRecoveryOptions {
  isTargetAvailable: () => boolean;
  loadDevelopmentUrl: () => Promise<void>;
  loadErrorPage: () => Promise<void>;
  logger?: MainWindowLoadRecoveryLogger;
  maxLoadAttempts?: number;
  retryDelayMs?: number;
  slowLoadWarningMs?: number;
}

interface MainFrameLoadFailure {
  errorCode: number;
  errorDescription: string;
  isMainFrame: boolean;
  validatedUrl: string;
}

export interface DevelopmentMainWindowLoadRecovery {
  dispose: () => void;
  handleDidFailLoad: (failure: MainFrameLoadFailure) => void;
  handleDidFinishLoad: () => void;
  handleFirstPaint: () => void;
  start: () => void;
}

interface PromiseLoadFailure {
  cause: unknown;
  errorCode?: number;
  errorDescription: string;
}

function normalizePromiseLoadFailure(error: unknown): PromiseLoadFailure {
  const errorRecord = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : null;
  const errorCode = typeof errorRecord?.errno === 'number'
    ? errorRecord.errno
    : undefined;
  const namedCode = typeof errorRecord?.code === 'string' ? errorRecord.code : '';
  const message = error instanceof Error ? error.message : String(error);

  return {
    cause: error,
    errorCode: errorCode ?? (
      namedCode === MAIN_WINDOW_LOAD_ABORTED_NAME || message.includes(MAIN_WINDOW_LOAD_ABORTED_NAME)
        ? MainWindowLoadErrorCode.Aborted
        : undefined
    ),
    errorDescription: namedCode || message || 'unknown error',
  };
}

/**
 * Owns development main-window initial navigation and its bounded recovery.
 *
 * Electron emits both `did-fail-load` and a rejected `loadURL()` promise for
 * one failed navigation. This controller deduplicates those signals per
 * attempt so a single failure can schedule at most one retry.
 */
export function createDevelopmentMainWindowLoadRecovery(
  options: CreateDevelopmentMainWindowLoadRecoveryOptions,
): DevelopmentMainWindowLoadRecovery {
  const logger = options.logger ?? console;
  const maxLoadAttempts = options.maxLoadAttempts ?? DEFAULT_MAX_LOAD_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const slowLoadWarningMs = options.slowLoadWarningMs ?? DEFAULT_SLOW_LOAD_WARNING_MS;

  let currentAttempt = 0;
  let disposed = false;
  let fallbackPageStarted = false;
  let finished = false;
  let handledFailureAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let slowLoadTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const clearSlowLoadTimer = () => {
    if (!slowLoadTimer) return;
    clearTimeout(slowLoadTimer);
    slowLoadTimer = null;
  };

  const canUseTarget = () => !disposed && options.isTargetAvailable();

  const startFallbackPage = () => {
    if (fallbackPageStarted || !canUseTarget()) return;
    fallbackPageStarted = true;
    clearRetryTimer();
    clearSlowLoadTimer();
    logger.error(
      `[Main] development window failed after ${maxLoadAttempts} attempts; showing fallback page`,
    );
    void options.loadErrorPage().catch(error => {
      if (!disposed) {
        logger.error('[Main] failed to load the development fallback page:', error);
      }
    });
  };

  const scheduleSlowLoadWarning = (attempt: number) => {
    clearSlowLoadTimer();
    slowLoadTimer = setTimeout(() => {
      slowLoadTimer = null;
      if (!canUseTarget() || finished || fallbackPageStarted || attempt !== currentAttempt) {
        return;
      }
      logger.warn(
        `[Main] development window is still loading after ${slowLoadWarningMs}ms; waiting without reloading`,
      );
    }, slowLoadWarningMs);
  };

  const navigate = () => {
    if (!canUseTarget() || finished || fallbackPageStarted) return;

    clearRetryTimer();
    currentAttempt += 1;
    const attempt = currentAttempt;
    handledFailureAttempt = 0;
    scheduleSlowLoadWarning(attempt);

    let loadPromise: Promise<void>;
    try {
      loadPromise = options.loadDevelopmentUrl();
    } catch (error) {
      loadPromise = Promise.reject(error);
    }

    void loadPromise.catch(error => {
      const failure = normalizePromiseLoadFailure(error);
      handleAttemptFailure(attempt, failure);
    });
  };

  const handleAttemptFailure = (
    attempt: number,
    failure: PromiseLoadFailure & { validatedUrl?: string },
  ) => {
    if (
      !canUseTarget()
      || finished
      || fallbackPageStarted
      || attempt !== currentAttempt
      || handledFailureAttempt === attempt
    ) {
      return;
    }

    handledFailureAttempt = attempt;
    clearSlowLoadTimer();

    if (failure.errorCode === MainWindowLoadErrorCode.Aborted) {
      logger.debug('[Main] development window navigation was aborted; waiting for the active navigation');
      return;
    }

    const code = failure.errorCode === undefined ? '' : ` ${failure.errorCode}`;
    const url = failure.validatedUrl ? ` (${failure.validatedUrl})` : '';
    const message =
      `[Main] development window failed to load${code}: ${failure.errorDescription}${url}`;
    if (failure.cause === undefined) {
      logger.error(message);
    } else {
      logger.error(message, failure.cause);
    }

    if (currentAttempt >= maxLoadAttempts) {
      startFallbackPage();
      return;
    }

    const failedAttempt = currentAttempt;
    logger.warn(
      `[Main] retrying development window load in ${retryDelayMs}ms (attempt ${currentAttempt + 1}/${maxLoadAttempts})`,
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (failedAttempt !== currentAttempt) return;
      navigate();
    }, retryDelayMs);
  };

  return {
    dispose: () => {
      disposed = true;
      clearRetryTimer();
      clearSlowLoadTimer();
    },
    handleDidFailLoad: failure => {
      if (!failure.isMainFrame) return;
      handleAttemptFailure(currentAttempt, {
        cause: undefined,
        errorCode: failure.errorCode,
        errorDescription: failure.errorDescription,
        validatedUrl: failure.validatedUrl,
      });
    },
    handleDidFinishLoad: () => {
      if (disposed) return;
      finished = true;
      clearRetryTimer();
      clearSlowLoadTimer();
    },
    handleFirstPaint: () => {
      clearSlowLoadTimer();
    },
    start: () => {
      if (currentAttempt > 0) return;
      navigate();
    },
  };
}
