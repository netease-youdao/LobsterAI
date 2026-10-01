import { AuthCallbackTransport } from '../../shared/auth/constants';

export const AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY = 'auth_callback_transport_preference';
// Long enough to spare a blocked browser the fallback on every login, short
// enough that the loopback callback gets retried after the blocker is gone.
export const AUTH_CALLBACK_TRANSPORT_PREFERENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const AuthLoginTransportSource = {
  Default: 'default',
  Preference: 'preference',
  Requested: 'requested',
} as const;

export type AuthLoginTransportSource = typeof AuthLoginTransportSource[keyof typeof AuthLoginTransportSource];

export interface AuthCallbackTransportPreference {
  transport: AuthCallbackTransport;
  expiresAt: number;
}

export interface AuthLoginTransportStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

interface AuthLoginTransportPolicyOptions {
  getStore: () => AuthLoginTransportStore;
  now?: () => number;
}

interface BrowserLoginAttempt {
  transport: AuthCallbackTransport;
  requested: boolean;
  delivered: boolean;
}

export function isAuthCallbackTransport(value: unknown): value is AuthCallbackTransport {
  return Object.values(AuthCallbackTransport).includes(value as AuthCallbackTransport);
}

export function parseAuthCallbackTransportPreference(
  value: unknown,
  now: number,
): AuthCallbackTransportPreference | null {
  if (!value || typeof value !== 'object') return null;
  const { transport, expiresAt } = value as Partial<AuthCallbackTransportPreference>;
  if (!isAuthCallbackTransport(transport)) return null;
  if (typeof expiresAt !== 'number' || expiresAt <= now) return null;
  return { transport, expiresAt };
}

/**
 * Picks how the portal returns the login code for each browser login, and
 * remembers a device whose browser cannot reach the loopback callback (for
 * example an extension that blocks public pages from opening 127.0.0.1).
 */
export class AuthLoginTransportPolicy {
  private attempt: BrowserLoginAttempt | null = null;
  private readonly now: () => number;

  constructor(private readonly options: AuthLoginTransportPolicyOptions) {
    this.now = options.now ?? Date.now;
  }

  resolve(requested: unknown): { transport: AuthCallbackTransport; source: AuthLoginTransportSource } {
    if (isAuthCallbackTransport(requested)) {
      return { transport: requested, source: AuthLoginTransportSource.Requested };
    }
    const preference = this.readPreference();
    if (preference) {
      return { transport: preference.transport, source: AuthLoginTransportSource.Preference };
    }
    return { transport: AuthCallbackTransport.Loopback, source: AuthLoginTransportSource.Default };
  }

  recordAttempt(transport: AuthCallbackTransport, source: AuthLoginTransportSource): void {
    this.attempt = {
      transport,
      requested: source === AuthLoginTransportSource.Requested,
      delivered: false,
    };
  }

  recordCodeDelivered(via: AuthCallbackTransport): void {
    const attempt = this.attempt;
    if (attempt) {
      this.attempt = { ...attempt, delivered: true };
    }

    if (via === AuthCallbackTransport.Loopback) {
      if (this.readPreference()) {
        console.log('[Auth] loopback login callback works again; cleared the deep link preference');
        this.writePreference(null);
      }
      return;
    }

    // A deep-link code for an undelivered attempt means the loopback callback
    // was bypassed: the portal fell back after its jump to 127.0.0.1 never
    // arrived, or the user switched to the deep link from the waiting notice.
    if (!attempt || attempt.delivered) return;
    if (attempt.transport !== AuthCallbackTransport.Loopback && !attempt.requested) return;
    console.log('[Auth] login completed through the deep link fallback; using it first on this device');
    this.writePreference({
      transport: AuthCallbackTransport.DeepLink,
      expiresAt: this.now() + AUTH_CALLBACK_TRANSPORT_PREFERENCE_TTL_MS,
    });
  }

  private readPreference(): AuthCallbackTransportPreference | null {
    try {
      const value = this.options.getStore().get(AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY);
      return parseAuthCallbackTransportPreference(value, this.now());
    } catch (error) {
      console.warn('[Auth] failed to read the login callback preference:', error);
      return null;
    }
  }

  private writePreference(preference: AuthCallbackTransportPreference | null): void {
    try {
      const store = this.options.getStore();
      if (preference) {
        store.set(AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY, preference);
      } else {
        store.delete(AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY);
      }
    } catch (error) {
      console.warn('[Auth] failed to update the login callback preference:', error);
    }
  }
}
