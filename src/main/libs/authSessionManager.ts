import {
  type AuthLifecycleEvent,
  AuthLifecycleEventType,
  AuthRefreshFailureKind,
  type AuthRefreshFailureKind as AuthRefreshFailureKindValue,
  AuthRefreshOutcome,
  type AuthRefreshOutcome as AuthRefreshOutcomeValue,
  AuthRefreshReason,
  type AuthRefreshReason as AuthRefreshReasonValue,
  AuthSessionStatus,
  type AuthSessionStatus as AuthSessionStatusValue,
} from '../../shared/auth/constants';
import { EnterpriseApiErrorCode } from '../../shared/enterpriseAccount/constants';

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export type AuthRefreshResult = {
  outcome: AuthRefreshOutcomeValue;
  reason: AuthRefreshReasonValue;
  durationMs: number;
  joinedRequests: number;
  accessToken?: string;
  failureKind?: AuthRefreshFailureKindValue;
  httpStatus?: number;
  errorCode?: number;
};

type AuthRefreshResultWithoutTiming = Omit<AuthRefreshResult, 'durationMs' | 'joinedRequests'>;

export type AuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

type AuthSessionManagerOptions = {
  getTokens: () => AuthTokens | null;
  getSessionKey?: () => string | null;
  saveTokens: (tokens: AuthTokens) => void;
  fetch: AuthFetch;
  getRefreshUrl: () => string;
  getRequestHeaders?: () => HeadersInit;
  buildRefreshRequestBody: (refreshToken: string) => string;
  onTerminalFailure: (result: AuthRefreshResultWithoutTiming) => void;
  onRefreshSuccess?: (result: AuthRefreshResultWithoutTiming) => void;
  onLifecycleEvent?: (event: AuthLifecycleEvent) => void;
  timeoutMs?: number;
  now?: () => number;
  log?: {
    info: (message: string) => void;
    warn: (message: string, error?: unknown) => void;
  };
};

type PendingRefresh = {
  promise: Promise<AuthRefreshResult>;
  joinedRequests: number;
  context: AuthRequestContext;
};

type AuthRequestContext = {
  sessionKey: string | null;
  refreshUrl: string;
  headers: Headers;
};

const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const TERMINAL_REFRESH_ERROR_CODES = new Set([
  40100,
  40101,
  EnterpriseApiErrorCode.NotMember,
]);

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readAccessToken(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const accessToken = (value as Record<string, unknown>).accessToken;
  return typeof accessToken === 'string' && accessToken.trim() ? accessToken : undefined;
}

function readRefreshToken(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const refreshToken = (value as Record<string, unknown>).refreshToken;
  return typeof refreshToken === 'string' && refreshToken.trim() ? refreshToken : undefined;
}

async function readRefreshResponseBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class AuthSessionRequestError extends Error {
  readonly status: AuthSessionStatusValue;
  readonly failureKind?: AuthRefreshFailureKindValue;
  readonly originalError?: unknown;

  constructor(
    status: AuthSessionStatusValue,
    message: string,
    options: {
      failureKind?: AuthRefreshFailureKindValue;
      originalError?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'AuthSessionRequestError';
    this.status = status;
    this.failureKind = options.failureKind;
    this.originalError = options.originalError;
  }
}

export function resolveAuthSessionStatusFromError(error: unknown): AuthSessionStatusValue {
  return error instanceof AuthSessionRequestError
    ? error.status
    : AuthSessionStatus.TemporarilyUnavailable;
}

export class AuthSessionManager {
  private readonly options: Required<Pick<AuthSessionManagerOptions, 'timeoutMs' | 'now'>> &
    Omit<AuthSessionManagerOptions, 'timeoutMs' | 'now'>;
  private pendingRefresh: PendingRefresh | null = null;
  private readonly requests = new Map<AbortController, AuthRequestContext>();

  constructor(options: AuthSessionManagerOptions) {
    this.options = {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
      now: options.now ?? Date.now,
    };
  }

  async waitForPendingRefresh(): Promise<void> {
    if (this.pendingRefresh && this.isCurrent(this.pendingRefresh.context)) await this.pendingRefresh.promise;
  }

  refresh(reason: AuthRefreshReasonValue): Promise<AuthRefreshResult> {
    return this.refreshForContext(reason, this.captureContext());
  }

  /** Retire queued/in-flight work; completed remote effects still need their original receipts. */
  invalidateContext(): void {
    for (const [controller, context] of this.requests) {
      if (!this.isCurrent(context)) controller.abort();
    }
  }

  private refreshForContext(reason: AuthRefreshReasonValue, context: AuthRequestContext): Promise<AuthRefreshResult> {
    if (!this.isCurrent(context)) return Promise.resolve({ ...this.contextChanged(reason), durationMs: 0, joinedRequests: 0 });
    this.invalidateContext();
    if (this.pendingRefresh && this.sameContext(this.pendingRefresh.context, context)) {
      this.pendingRefresh.joinedRequests += 1;
      return this.pendingRefresh.promise;
    }

    const startedAt = this.options.now();
    const pending: PendingRefresh = {
      joinedRequests: 0,
      context,
      promise: Promise.resolve({
        outcome: AuthRefreshOutcome.NoTokens,
        reason,
        durationMs: 0,
        joinedRequests: 0,
      }),
    };

    const promise = this.performRefresh(reason, context)
      .then(result => {
        const completed: AuthRefreshResult = {
          ...(this.isCurrent(context) ? result : this.contextChanged(reason)),
          durationMs: Math.max(0, this.options.now() - startedAt),
          joinedRequests: pending.joinedRequests,
        };
        if (this.isCurrent(context) && completed.failureKind !== AuthRefreshFailureKind.ContextChanged) this.emitLifecycleEvent(completed);
        return completed;
      })
      .finally(() => {
        if (this.pendingRefresh?.promise === promise) {
          this.pendingRefresh = null;
        }
      });

    pending.promise = promise;
    this.pendingRefresh = pending;
    return promise;
  }

  async fetchWithAuth(url: string, options?: RequestInit, transport: AuthFetch = this.options.fetch): Promise<Response> {
    const context = this.captureContext();
    const initialTokens = this.options.getTokens();
    if (!initialTokens) {
      throw new AuthSessionRequestError(
        AuthSessionStatus.Unauthenticated,
        'No auth tokens are available',
      );
    }
    this.invalidateContext();
    const controller = new AbortController();
    this.requests.set(controller, context);
    const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const requestHeaders = new Headers(options?.headers);
    context.headers.forEach((value, name) => requestHeaders.set(name, value));

    const doFetch = async (accessToken: string): Promise<Response> => {
      this.assertCurrent(context);
      const headers = new Headers(requestHeaders);
      headers.set('Authorization', `Bearer ${accessToken}`);
      try {
        const response = await transport(url, {
          ...options,
          headers,
          signal,
        });
        if (!this.isCurrent(context)) {
          // A streamed response may still hold a transport permit after its headers arrive.
          // Cleanup must not delay rejecting a response from an obsolete auth session.
          try { void response.body?.cancel().catch((): void => undefined); } catch { /* Preserve the auth rejection. */ }
          this.assertCurrent(context);
        }
        return response;
      } catch (error) {
        this.assertCurrent(context);
        if (error instanceof AuthSessionRequestError) {
          throw error;
        }
        throw new AuthSessionRequestError(
          AuthSessionStatus.TemporarilyUnavailable,
          'Authenticated request failed',
          {
            failureKind: AuthRefreshFailureKind.Network,
            originalError: error,
          },
        );
      }
    };

    try {
      let rejectedAccessToken = initialTokens.accessToken;
      let response = await doFetch(rejectedAccessToken);
      this.assertCurrent(context);
      if (response.status !== 401) {
        return response;
      }

      const latestTokens = this.options.getTokens();
      if (latestTokens?.accessToken && latestTokens.accessToken !== rejectedAccessToken) {
        rejectedAccessToken = latestTokens.accessToken;
        response = await doFetch(rejectedAccessToken);
        this.assertCurrent(context);
        if (response.status !== 401) {
          return response;
        }
      }

      const refreshResult = await this.refreshForContext(AuthRefreshReason.Passive, context);
      this.assertCurrent(context);
      if (refreshResult.outcome === AuthRefreshOutcome.Success && refreshResult.accessToken) {
        response = await doFetch(refreshResult.accessToken);
        this.assertCurrent(context);
        return response;
      }
      if (refreshResult.outcome === AuthRefreshOutcome.TerminalFailure) {
        throw new AuthSessionRequestError(
          AuthSessionStatus.Expired,
          'Refresh token was rejected',
          { failureKind: refreshResult.failureKind },
        );
      }
      if (refreshResult.outcome === AuthRefreshOutcome.NoTokens) {
        throw new AuthSessionRequestError(
          AuthSessionStatus.Unauthenticated,
          'Auth tokens were cleared before refresh',
        );
      }
      throw new AuthSessionRequestError(
        AuthSessionStatus.TemporarilyUnavailable,
        'Token refresh is temporarily unavailable',
        { failureKind: refreshResult.failureKind },
      );
    } finally {
      this.requests.delete(controller);
    }
  }

  private async performRefresh(
    reason: AuthRefreshReasonValue,
    context: AuthRequestContext,
  ): Promise<AuthRefreshResultWithoutTiming> {
    const tokens = this.options.getTokens();
    if (!tokens?.refreshToken) {
      return {
        outcome: AuthRefreshOutcome.NoTokens,
        reason,
      };
    }

    const controller = new AbortController();
    this.requests.set(controller, context);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);

    try {
      if (!this.isCurrent(context)) return this.contextChanged(reason);
      const headers = new Headers(context.headers);
      headers.set('Content-Type', 'application/json');
      this.options.log?.info(`[Auth] requesting token refresh (reason: ${reason})`);
      const response = await this.options.fetch(context.refreshUrl, {
        method: 'POST',
        headers,
        body: this.options.buildRefreshRequestBody(tokens.refreshToken),
        signal: controller.signal,
      });
      if (!this.isCurrent(context)) {
        try { void response.body?.cancel().catch((): void => undefined); } catch { /* Preserve context cancellation. */ }
        return this.contextChanged(reason);
      }
      const body = await readRefreshResponseBody(response);
      const errorCode = readNumber(body?.code);
      const data = body?.data;
      const accessToken = readAccessToken(data);
      const currentTokens = this.options.getTokens();

      if (!this.isCurrent(context)) return this.contextChanged(reason);
      if (!currentTokens) {
        this.options.log?.info(
          `[Auth] ignored token refresh response after the auth session changed (reason: ${reason})`,
        );
        return {
          outcome: AuthRefreshOutcome.NoTokens,
          reason,
        };
      }
      if (currentTokens.refreshToken !== tokens.refreshToken) {
        this.options.log?.info(
          `[Auth] ignored token refresh response for a superseded session (reason: ${reason})`,
        );
        return {
          outcome: AuthRefreshOutcome.Success,
          reason,
          accessToken: currentTokens.accessToken,
        };
      }

      if (response.ok && errorCode === 0 && accessToken) {
        const nextTokens = {
          accessToken,
          refreshToken: readRefreshToken(data) ?? tokens.refreshToken,
        };
        this.options.saveTokens(nextTokens);
        if (!this.isCurrent(context)) return this.contextChanged(reason);
        const result: AuthRefreshResultWithoutTiming = {
          outcome: AuthRefreshOutcome.Success,
          reason,
          accessToken,
          httpStatus: response.status,
          errorCode,
        };
        this.invokeSafely(this.options.onRefreshSuccess, result);
        this.options.log?.info(`[Auth] token refresh succeeded (reason: ${reason})`);
        return result;
      }

      const isTerminalFailure = response.status === 401
        || (errorCode !== undefined && TERMINAL_REFRESH_ERROR_CODES.has(errorCode));
      const result: AuthRefreshResultWithoutTiming = {
        outcome: isTerminalFailure
          ? AuthRefreshOutcome.TerminalFailure
          : AuthRefreshOutcome.TransientFailure,
        reason,
        failureKind: isTerminalFailure
          ? AuthRefreshFailureKind.Rejected
          : response.ok
            ? AuthRefreshFailureKind.InvalidResponse
            : AuthRefreshFailureKind.Http,
        httpStatus: response.status,
        errorCode,
      };
      if (result.outcome === AuthRefreshOutcome.TerminalFailure) {
        this.invokeSafely(this.options.onTerminalFailure, result);
      }
      this.options.log?.warn(
        `[Auth] token refresh rejected (reason: ${reason}, status: ${response.status}, code: ${errorCode ?? 'unknown'})`,
      );
      return result;
    } catch (error) {
      if (!this.isCurrent(context)) return this.contextChanged(reason);
      const failureKind = timedOut || isAbortError(error)
        ? AuthRefreshFailureKind.Timeout
        : AuthRefreshFailureKind.Network;
      this.options.log?.warn(
        `[Auth] token refresh failed (reason: ${reason}, kind: ${failureKind})`,
        error,
      );
      return {
        outcome: AuthRefreshOutcome.TransientFailure,
        reason,
        failureKind,
      };
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }

  private emitLifecycleEvent(result: AuthRefreshResult): void {
    this.invokeSafely(this.options.onLifecycleEvent, {
      eventType: AuthLifecycleEventType.TokenRefresh,
      outcome: result.outcome,
      reason: result.reason,
      durationMs: result.durationMs,
      failureKind: result.failureKind,
      httpStatus: result.httpStatus,
      errorCode: result.errorCode,
      joinedRequests: result.joinedRequests,
    });
  }

  private getSessionKey(): string | null {
    return this.options.getSessionKey?.() ?? null;
  }

  private captureContext(): AuthRequestContext {
    return { sessionKey: this.getSessionKey(), refreshUrl: this.options.getRefreshUrl(), headers: new Headers(this.options.getRequestHeaders?.()) };
  }

  private sameContext(left: AuthRequestContext, right: AuthRequestContext): boolean {
    return left.sessionKey === right.sessionKey && left.refreshUrl === right.refreshUrl;
  }

  private isCurrent(context: AuthRequestContext): boolean {
    return context.sessionKey === this.getSessionKey() && context.refreshUrl === this.options.getRefreshUrl();
  }

  private contextChanged(reason: AuthRefreshReasonValue): AuthRefreshResultWithoutTiming {
    return { outcome: AuthRefreshOutcome.TransientFailure, reason, failureKind: AuthRefreshFailureKind.ContextChanged };
  }

  private assertCurrent(context: AuthRequestContext): void {
    if (!this.isCurrent(context)) throw new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable,
      'Auth request context changed', { failureKind: AuthRefreshFailureKind.ContextChanged });
  }

  private invokeSafely<T>(callback: ((value: T) => void) | undefined, value: T): void {
    try {
      callback?.(value);
    } catch (error) {
      this.options.log?.warn('[Auth] lifecycle callback failed', error);
    }
  }
}
