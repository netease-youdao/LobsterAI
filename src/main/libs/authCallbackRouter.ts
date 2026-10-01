import { AuthIpcChannel } from '../../shared/auth/constants';

export interface AuthCallbackTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: { code: string }): void;
}

interface AuthCallbackRouterOptions {
  getTarget: () => AuthCallbackTarget | null;
  onParseError?: (error: unknown) => void;
}

interface NavigationStartedOptions {
  isMainFrame: boolean;
  isInPlace: boolean;
}

/** Returns the code of a lobsterai://auth/callback URL, or null for other URLs. */
export function readAuthDeepLinkCode(url: URL): string | null {
  if (url.hostname !== 'auth' || url.pathname !== '/callback') return null;
  return url.searchParams.get('code') || null;
}

export class AuthCallbackRouter {
  private pendingAuthCode: string | null = null;
  private listenerReady = false;

  constructor(private readonly options: AuthCallbackRouterOptions) {}

  /** Returns true when the URL carried an auth code. */
  handleDeepLink(url: string): boolean {
    try {
      const code = readAuthDeepLinkCode(new URL(url));
      if (!code) return false;

      this.deliverOrBuffer(code);
      return true;
    } catch (error) {
      this.options.onParseError?.(error);
      return false;
    }
  }

  handleAuthCode(code: string): void {
    if (!code) return;
    this.deliverOrBuffer(code);
  }

  markListenerReadyAndConsumePending(): string | null {
    this.listenerReady = true;
    const code = this.pendingAuthCode;
    this.pendingAuthCode = null;
    return code;
  }

  markRendererUnavailable(): void {
    this.listenerReady = false;
  }

  handleNavigationStarted({ isMainFrame, isInPlace }: NavigationStartedOptions): void {
    if (isMainFrame && !isInPlace) {
      this.markRendererUnavailable();
    }
  }

  private deliverOrBuffer(code: string): void {
    if (this.listenerReady) {
      const target = this.options.getTarget();
      if (target && !target.isDestroyed()) {
        target.send(AuthIpcChannel.Callback, { code });
        return;
      }
    }

    this.pendingAuthCode = code;
  }
}
