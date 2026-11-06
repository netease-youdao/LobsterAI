import type { ApprovalState } from '../../../shared/cowork/approval';
import type { RemoteOwner } from '../../../shared/remote/constants';
import type { CoworkStore } from '../../coworkStore';
import { t } from '../../i18n';
import { sameOwner } from '../../remote/canonical';
import type { AgentSettingsContext, AgentSettingsWriteLease } from '../agentSettings/types';
import { registerSettingsApproval, settingsApprovalDigest, type SettingsApprovalIntent } from './approval';

type Gateway = { request<T = Record<string, unknown>>(method: string, params?: unknown, options?: { timeoutMs?: number | null }): Promise<T> };
export interface SettingsToolContext { agentId: string; sessionKey: string; runId: string; toolCallId: string }
export interface SettingsConversationSource extends SettingsToolContext { localSessionId: string; commandId: string; remoteRunId: string; owner: RemoteOwner }
interface Dependencies {
  store: CoworkStore;
  gateway(): Gateway | null;
  owner(): RemoteOwner | null;
  epoch(): number;
  resolveSession(sessionKey: string): string | undefined;
  currentRun(sessionId: string, gatewayRunId: string): boolean;
  otherRuns(agentId: string, allowedSessionId?: string): boolean;
  approval(requestId: string): ApprovalState | null;
}
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'reconciling']);
const activeLocalWrites = new Set<string>();
/** Called at existing synchronous local edit entry points, before changing an Agent or workspace. */
export function assertAgentSettingsLocalWriteAllowed(agentId: string): void {
  if (activeLocalWrites.has(agentId)) throw new Error('SETTINGS_OPERATION_PENDING');
}

export class AgentSettingsRuntimeBridge {
  private readonly calls = new Map<string, SettingsConversationSource>();
  constructor(private readonly deps: Dependencies) {}
  async ready(): Promise<boolean> {
    try { return (await this.deps.gateway()?.request<{ ready: boolean }>('lobster.settings.status', {}, { timeoutMs: 3000 }))?.ready === true; }
    catch { return false; }
  }
  /** Called only at the host's actual remote-command dispatch, before chat.send. */
  async bindRemoteRun(sessionId: string, sessionKey: string, runId: string, commandId?: string): Promise<void> {
    if (!commandId) return; // Ordinary desktop conversations never advertise the remote settings tool.
    const gateway = this.deps.gateway(), owner = this.deps.owner();
    const remote = this.deps.store.remote, session = this.deps.store.getSession(sessionId, 0), run = remote.run(sessionId);
    if (!gateway || !owner || !session || session.parentSessionId || !run || terminal.has(run.status)
      || remote.get<string>(`runCommand:${sessionId}`) !== commandId || !sameOwner(remote.owner(sessionId), owner)
      || this.deps.resolveSession(sessionKey) !== sessionId || !this.deps.currentRun(sessionId, runId)) return;
    remote.assertNoDeletionEffect(sessionId); remote.assertActor(sessionId, owner);
    this.deps.store.assertAgentAccess(session.agentId, owner);
    try {
      await gateway.request('lobster.settings.bindRun', { agentId: session.agentId, sessionKey, runId }, { timeoutMs: 3000 });
    } catch {
      // Older runtimes retain ordinary chat. They do not expose this tool or gain settings authority.
    }
  }
  source(context: SettingsToolContext): SettingsConversationSource {
    if (!context || [context.agentId, context.sessionKey, context.runId, context.toolCallId].some(v => typeof v !== 'string' || !v || v.length > 256)) throw new Error('CONVERSATION_SOURCE_INVALID');
    const id = this.deps.resolveSession(context.sessionKey), owner = this.deps.owner();
    if (!id || !owner || !this.deps.currentRun(id, context.runId)) throw new Error('CONVERSATION_SOURCE_INVALID');
    const session = this.deps.store.getSession(id, 0), remote = this.deps.store.remote;
    const run = remote.run(id), commandId = remote.get<string>(`runCommand:${id}`);
    const mapping = remote.get<{ runId: string; remoteRunId: string; sessionKey: string }>(`gatewayRun:${id}`);
    if (!session || session.parentSessionId || session.agentId !== context.agentId || !run || terminal.has(run.status)
      || !commandId || mapping?.runId !== context.runId || mapping.remoteRunId !== run.runId || mapping.sessionKey !== context.sessionKey
      || !sameOwner(owner, remote.owner(id))) throw new Error('CONVERSATION_SOURCE_INVALID');
    remote.assertNoDeletionEffect(id); remote.assertActor(id, owner);
    this.deps.store.assertAgentAccess(context.agentId, owner);
    const source = { ...context, localSessionId: id, commandId, remoteRunId: run.runId, owner };
    this.calls.set(context.toolCallId, source);
    return source;
  }
  forget(toolCallId: string): void { this.calls.delete(toolCallId); }
  assertSource(source: SettingsConversationSource): void {
    const current = this.source(source);
    if (current.commandId !== source.commandId || current.remoteRunId !== source.remoteRunId || !sameOwner(current.owner, source.owner)) throw new Error('CONVERSATION_SOURCE_INVALID');
  }
  async acquireWriteLease(context: AgentSettingsContext): Promise<AgentSettingsWriteLease> {
    const source = context.toolCallId ? this.calls.get(context.toolCallId) : undefined;
    if (context.source === 'conversation' && (!source || source.commandId !== context.commandId || source.remoteRunId !== context.runId)) throw new Error('CONVERSATION_SOURCE_INVALID');
    if (source) this.assertSource(source);
    const gateway = this.deps.gateway(), epoch = this.deps.epoch();
    if (!gateway || !sameOwner(context.owner, this.deps.owner()) || this.deps.otherRuns(context.agentId, source?.localSessionId)
      || activeLocalWrites.has(context.agentId)) throw new Error('AGENT_BUSY');
    activeLocalWrites.add(context.agentId);
    try {
      const lease = await gateway.request<{ token: string; expiresAt: number }>('lobster.settings.acquire', { agentId: context.agentId,
        ...(source ? { sessionKey: source.sessionKey, runId: source.runId, toolCallId: source.toolCallId } : {}) }, { timeoutMs: 12_000 });
      let released = false;
      const assertCurrent = (): void => {
        if (released || !lease.token || !Number.isFinite(lease.expiresAt) || Date.now() + 500 >= lease.expiresAt
          || this.deps.gateway() !== gateway || this.deps.epoch() !== epoch || !sameOwner(context.owner, this.deps.owner())) throw new Error('SETTINGS_LEASE_EXPIRED');
        if (source) this.assertSource(source);
      };
      return { assertCurrent, release: () => {
        if (released) return; released = true; activeLocalWrites.delete(context.agentId);
        void gateway.request('lobster.settings.release', { agentId: context.agentId, token: lease.token }, { timeoutMs: 3000 }).catch((): void => undefined);
      } };
    } catch (error) { activeLocalWrites.delete(context.agentId); throw error; }
  }
  async approve(source: SettingsConversationSource, intent: SettingsApprovalIntent, preview: string): Promise<string> {
    this.assertSource(source);
    const gateway = this.deps.gateway(), epoch = this.deps.epoch();
    if (!gateway) throw new Error('LOCAL_ACTION_REQUIRED');
    const digest = settingsApprovalDigest(intent);
    const title = t('agentSettingsApprovalTitle');
    const description = t('agentSettingsApprovalDescription', { section: t(`agentSettingsSection_${intent.section}`), preview });
    // The gateway sanitizes display controls and bounds descriptions; never silently truncate a change.
    if (description.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(description)) throw new Error('LOCAL_ACTION_REQUIRED');
    const remove = registerSettingsApproval({ ...source, title, description, digest, isCurrent: () => {
      try { this.assertSource(source); return this.deps.epoch() === epoch && this.deps.gateway() === gateway; } catch { return false; }
    } });
    try {
      const request = await gateway.request<{ id?: string }>('plugin.approval.request', { pluginId: 'lobster-agent-settings', toolName: 'lobsterai_agent_settings',
        toolCallId: source.toolCallId, sessionKey: source.sessionKey, agentId: source.agentId, title, description,
        allowedDecisions: ['allow-once', 'deny'], timeoutMs: 120_000, twoPhase: true }, { timeoutMs: 10_000 });
      if (!request.id) throw new Error('LOCAL_ACTION_REQUIRED');
      await gateway.request('plugin.approval.waitDecision', { id: request.id }, { timeoutMs: 125_000 });
      this.assertSource(source);
      const approved = this.deps.approval(request.id);
      if (this.deps.epoch() !== epoch || approved?.operationDigest !== digest || approved.status !== 'approved'
        || approved.runId !== source.remoteRunId || approved.resolution.phase !== 'finished' || approved.resolution.confirmedDecision !== 'approve') throw new Error('SETTINGS_APPROVAL_REQUIRED');
      return request.id;
    } finally { remove(); }
  }
}
