import { AuthIpcChannel } from '../../shared/auth/constants';

export interface AuthCallbackTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: { code: string }): void;
}

interface AuthCallbackRouterOptions {
  getTarget: () => AuthCallbackTarget | null;
  onParseError?: (error: unknown) => void;
  acceptsCallback?: () => boolean;
}

interface NavigationStartedOptions {
  isMainFrame: boolean;
  isInPlace: boolean;
}

export class AuthCallbackRouter {
  private pendingAuthCode: string | null = null;
  private listenerReady = false;

  constructor(private readonly options: AuthCallbackRouterOptions) {}

  handleDeepLink(url: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'auth' || parsed.pathname !== '/callback') return;

      const code = parsed.searchParams.get('code');
      if (!code) return;

      this.deliverOrBuffer(code);
    } catch (error) {
      this.options.onParseError?.(error);
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
    return this.options.acceptsCallback?.() === false ? null : code;
  }

  clearPending(): void {
    this.pendingAuthCode = null;
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
    if (this.options.acceptsCallback?.() === false) return;
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
