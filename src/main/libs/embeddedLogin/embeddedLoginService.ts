import { AuthLoginFailureReason } from '../../../shared/auth/constants';
import { EmbeddedLoginError, type EmbeddedLoginWindowHandle } from './embeddedLoginWindow';
import { isSameState, type LoginTransaction } from './loginTransaction';
import { buildEmbeddedLoginTarget, isAuthCodeFormat, type NavigationPolicy } from './loginUrlPolicy';

export interface LoginExchangeResult {
  success: boolean;
  error?: string;
}

export interface EmbeddedLoginServiceDeps<TResult extends LoginExchangeResult> {
  resolveLoginUrl(): Promise<string>;
  createTransaction(): LoginTransaction;
  allowedTopLevelOrigins(): readonly string[];
  openWindow(loginUrl: string, policy: NavigationPolicy): EmbeddedLoginWindowHandle;
  exchange(code: string, codeVerifier: string): Promise<TResult>;
}

export interface EmbeddedLoginFailure {
  success: false;
  reason: AuthLoginFailureReason;
  error?: string;
}

/** Runs one embedded login at a time; a repeated request focuses the open window. */
export class EmbeddedLoginService<TResult extends LoginExchangeResult> {
  private pending: Promise<TResult | EmbeddedLoginFailure> | null = null;
  private handle: EmbeddedLoginWindowHandle | null = null;

  constructor(private readonly deps: EmbeddedLoginServiceDeps<TResult>) {}

  login(): Promise<TResult | EmbeddedLoginFailure> {
    if (this.pending) {
      this.handle?.focus();
      return this.pending;
    }
    const pending = this.run().finally(() => {
      this.pending = null;
      this.handle = null;
    });
    this.pending = pending;
    return pending;
  }

  private async run(): Promise<TResult | EmbeddedLoginFailure> {
    const transaction = this.deps.createTransaction();
    const target = buildEmbeddedLoginTarget(await this.deps.resolveLoginUrl(), transaction);
    const policy: NavigationPolicy = {
      target,
      allowedTopLevelOrigins: new Set([target.origin, ...this.deps.allowedTopLevelOrigins()]),
    };

    let completion;
    try {
      this.handle = this.deps.openWindow(target.loginUrl, policy);
      completion = await this.handle.result;
    } catch (error) {
      return {
        success: false,
        reason: error instanceof EmbeddedLoginError ? error.reason : AuthLoginFailureReason.LoadFailed,
      };
    }

    if (!isSameState(transaction.state, completion.state) || !isAuthCodeFormat(completion.code)) {
      console.warn('[EmbeddedLogin] rejected a completion with an unexpected state or code format');
      return { success: false, reason: AuthLoginFailureReason.InvalidCompletion };
    }

    const result = await this.deps.exchange(completion.code, transaction.codeVerifier);
    if (result.success) return result;
    return { success: false, reason: AuthLoginFailureReason.ExchangeFailed, error: result.error };
  }
}
