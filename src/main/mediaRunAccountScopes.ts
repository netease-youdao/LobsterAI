import { isMediaAccountScopeCurrent, type MediaAccountScope } from './mediaAccountIsolation';

// Loopback protocol mirrored by lobster-media-generation/runContext.ts.
export const MediaRunLifecycle = {
  Tool: 'lobsterai_media_run',
  Begin: 'begin',
  End: 'end',
} as const;

export type MediaRunContext = { sessionKey: string; runId?: string };

/** Native runs have no renderer IPC. Capture their owner before model execution. */
export class MediaRunAccountScopes {
  private readonly scopes = new Map<string, MediaAccountScope | null>();

  private key(context: MediaRunContext): string | null {
    return context.sessionKey?.trim() && context.runId?.trim()
      ? JSON.stringify([context.sessionKey, context.runId]) : null;
  }

  begin(context: MediaRunContext, account: MediaAccountScope | null): void {
    const key = this.key(context);
    // A retry must not rebind an existing run to a newly logged-in account.
    if (!key || this.scopes.has(key)) return;
    this.scopes.set(key, account ? { ...account } : null);
  }

  resolve(context: MediaRunContext, current: MediaAccountScope | null): MediaAccountScope | null {
    const key = this.key(context);
    const scope = key ? this.scopes.get(key) : null;
    return scope && isMediaAccountScopeCurrent(scope, current) ? { ...scope } : null;
  }

  end(context: MediaRunContext): void {
    const key = this.key(context);
    if (key) this.scopes.delete(key);
  }
}
