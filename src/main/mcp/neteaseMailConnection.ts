import { McpAuthMode } from '../../shared/mcp/auth';
import { NeteaseMail, NeteaseMailAction, NeteaseMailError, NeteaseMailFailure, NeteaseMailOutcome } from '../../shared/neteaseMail/constants';
import { getNeteaseMailNativeTools, getNeteaseMailScopes } from '../../shared/neteaseMail/scopes';
import type { NeteaseMailActionResult, NeteaseMailAuthorizationOptions, NeteaseMailBridge, NeteaseMailConfirmationReference, NeteaseMailConfirmationRequest } from '../../shared/neteaseMail/types';
import type { McpStore } from './mcpStore';
import type { NeteaseMailAuthStore } from './neteaseMailAuthStore';
import type { NeteaseMailOAuthConfig } from './neteaseMailConfig';
import { authorizeNeteaseMail, NeteaseMailOAuthError } from './neteaseMailOAuth';

export interface NeteaseMailConnectionDeps {
  config?: NeteaseMailOAuthConfig;
  getAuthStore: () => NeteaseMailAuthStore | undefined;
  getMcpStore: () => McpStore;
  fetch: typeof fetch;
  openExternal: (url: string) => Promise<void>;
  callbackText: () => string;
  sync: (serverId?: string) => Promise<{ success: boolean }>;
  broadcast: () => void;
  confirmations?: {
    invalidate(): void;
    status(reference: NeteaseMailConfirmationReference): boolean;
    resolve(request: NeteaseMailConfirmationRequest): boolean;
  };
}

/** The DSH MCP OAuth manager owns token storage and refresh. */
export class NeteaseMailConnection implements NeteaseMailBridge {
  private pending?: { controller: AbortController; result: Promise<NeteaseMailActionResult> };
  private disconnecting = false;
  private committing = false;
  private runtimeReady = true;

  constructor(private readonly deps: NeteaseMailConnectionDeps) {}

  async getAvailability(reference?: NeteaseMailConfirmationReference) {
    if (reference) {
      return { authorization: Boolean(this.deps.config),
        confirmation: this.runtimeReady && this.deps.confirmations?.status(reference) === true };
    }
    const store = this.deps.getAuthStore();
    if (!store) return { authorization: false, confirmation: false, connected: false };
    const status = await store.status();
    return { authorization: Boolean(this.deps.config), confirmation: false, ...status, connected: status.connected && this.runtimeReady };
  }

  authorize(options: NeteaseMailAuthorizationOptions = {}): Promise<NeteaseMailActionResult> {
    if (this.pending) return this.pending.result;
    if (this.disconnecting) return Promise.resolve({ success: false, code: NeteaseMailFailure.Unavailable });
    const controller = new AbortController();
    const result = this.connect(controller.signal, options).finally(() => { this.pending = undefined; this.committing = false; });
    this.pending = { controller, result };
    return result;
  }

  async cancelAuthorization(): Promise<NeteaseMailActionResult> {
    const pending = this.pending;
    // Once the callback has been exchanged, finish the atomic credential write.
    // A late cancel reports that result; disconnect waits for it and then removes it.
    if (!this.committing) pending?.controller.abort();
    return pending?.result ?? { success: true, outcome: NeteaseMailOutcome.Cancelled };
  }

  /** Used by delete as well as disconnect; no credentials survive removing the connector. */
  async clearCredentials(): Promise<void> {
    const wasDisconnecting = this.disconnecting;
    this.disconnecting = true;
    try {
      await this.cancelAuthorization();
      const store = this.deps.getAuthStore();
      if (!store) throw new NeteaseMailOAuthError(NeteaseMailFailure.StorageFailed);
      await store.remove();
      this.runtimeReady = false;
    } finally { this.disconnecting = wasDisconnecting; }
  }

  async disconnect(): Promise<NeteaseMailActionResult> {
    this.disconnecting = true;
    try {
      await this.clearCredentials();
      const store = this.deps.getMcpStore();
      for (const server of store.listServers()) {
        if (server.registryId === NeteaseMail.RegistryId) store.setEnabled(server.id, false);
      }
      if (!(await this.syncRuntime())) return { success: false, code: NeteaseMailFailure.SyncFailed };
      return { success: true, outcome: NeteaseMailOutcome.Disconnected };
    } catch (error) { return this.failure(error); }
    finally { this.disconnecting = false; }
  }

  invalidateConfirmations(): void { this.deps.confirmations?.invalidate(); }

  async resolveConfirmation(request: NeteaseMailConfirmationRequest): Promise<NeteaseMailActionResult> {
    if (!this.runtimeReady || !this.deps.confirmations?.resolve(request)) {
      return { success: false, code: NeteaseMailError.ConfirmationChanged };
    }
    return { success: true, outcome: request.action === NeteaseMailAction.Cancel ? NeteaseMailOutcome.Cancelled : NeteaseMailOutcome.Submitted };
  }

  private failure(error: unknown): NeteaseMailActionResult {
    // Do not log upstream descriptions, callback URLs, authorization codes or tokens.
    return { success: false, code: error instanceof NeteaseMailOAuthError ? error.code : NeteaseMailFailure.Failed };
  }

  private async syncRuntime(serverId?: string): Promise<boolean> {
    try {
      this.runtimeReady = (await this.deps.sync(serverId)).success;
      return this.runtimeReady;
    } catch {
      this.runtimeReady = false;
      return false;
    } finally {
      this.deps.broadcast();
    }
  }

  private async connect(signal: AbortSignal, options: NeteaseMailAuthorizationOptions): Promise<NeteaseMailActionResult> {
    const { config } = this.deps;
    const authStore = this.deps.getAuthStore();
    if (!config || !authStore) return { success: false, code: NeteaseMailFailure.NotReady };
    try {
      const credential = await authorizeNeteaseMail({
        config, fetch: this.deps.fetch, openExternal: this.deps.openExternal, signal, callbackText: this.deps.callbackText(),
        allowDelete: options.allowDelete === true,
      });
      signal.throwIfAborted();
      this.committing = true;
      this.runtimeReady = false;
      const store = this.deps.getMcpStore();
      const existing = store.listServers().find(server => server.registryId === NeteaseMail.RegistryId);
      const data = {
        name: NeteaseMail.RegistryId, description: 'NetEase Mail', transportType: 'http' as const,
        url: config.mcpUrl, auth: McpAuthMode.OAuth, headers: {},
        registryId: NeteaseMail.RegistryId, isBuiltIn: true,
        toolFilter: { include: getNeteaseMailNativeTools(getNeteaseMailScopes(credential.scope)) },
      };
      const server = existing ? store.updateServer(existing.id, data)! : store.createServer(data);
      await authStore.save(credential);
      store.setEnabled(server.id, true);
      if (!(await this.syncRuntime(server.id))) return { success: false, code: NeteaseMailFailure.SyncFailed };
      return { success: true, outcome: NeteaseMailOutcome.Connected };
    } catch (error) {
      if (signal.aborted) return { success: true, outcome: NeteaseMailOutcome.Cancelled };
      return this.failure(error);
    }
  }
}
