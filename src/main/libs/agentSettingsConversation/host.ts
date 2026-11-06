import { randomUUID } from 'node:crypto';

import { payloadHash } from '../../remote/canonical';
import type { RemoteAgentSettingsProtocol, SettingsConversationAccess } from '../../remote/remoteAgentSettingsProtocol';
import type { AgentSettingsService } from '../agentSettings/service';
import { type AgentSettingsContext, AgentSettingsPhase, type AgentSettingsProposal, type AgentSettingsSection } from '../agentSettings/types';
import type { AgentSettingsToolRequest, DecisionToolResponse } from '../mcpBridgeServer';
import { type SettingsApprovalIntent,settingsChangePreview } from './approval';
import type { AgentSettingsRuntimeBridge, SettingsConversationSource } from './runtime';

interface Pending {
  source: SettingsConversationSource; access: SettingsConversationAccess; proposal: AgentSettingsProposal; before: string;
  approvalId?: string; digest?: string;
}
interface Dependencies { service: AgentSettingsService; protocol(): RemoteAgentSettingsProtocol | null; runtime(): AgentSettingsRuntimeBridge }
const textSections = new Set(['identity', 'memory', 'userProfile']);
const reason = (error: unknown): string => {
  const data = error instanceof Error && 'data' in error && error.data !== null && typeof error.data === 'object'
    ? error.data as Record<string, unknown> : {};
  const raw = typeof data.reason === 'string' ? data.reason
    : error instanceof Error && 'reason' in error ? String(error.reason) : error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z_]{1,79}$/u.test(raw) ? raw : 'SETTINGS_UNAVAILABLE';
};
const result = (data: Record<string, unknown>, isError = false): DecisionToolResponse => ({ content: [{ type: 'text', text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });

/** Main-process host. Only plugin context and persisted source facts select an Agent. */
export class AgentSettingsConversationHost {
  private readonly pending = new Map<string, Pending>();
  private readonly calls = new Map<string, { source: SettingsConversationSource; hash: string; result: Promise<DecisionToolResponse> }>();
  constructor(private readonly deps: Dependencies) {}
  authorize = async (context: AgentSettingsContext, proposal: AgentSettingsProposal, digest: string): Promise<void> => {
    const pending = this.pending.get(proposal.operationId);
    if (!pending || context.commandId !== pending.source.commandId || context.runId !== pending.source.remoteRunId
      || context.toolCallId !== pending.source.toolCallId || context.agentId !== pending.source.agentId
      || proposal.expectedRevision !== pending.proposal.expectedRevision) throw new Error('CONVERSATION_SOURCE_INVALID');
    const runtime = this.deps.runtime(); runtime.assertSource(pending.source);
    if (pending.digest) {
      if (pending.digest !== digest || !pending.approvalId) throw new Error('SETTINGS_APPROVAL_STALE');
      return;
    }
    const intent: SettingsApprovalIntent = { operationId: proposal.operationId, commandId: context.commandId, runId: context.runId, toolCallId: context.toolCallId,
      agentId: context.agentId, section: proposal.section, expectedRevision: proposal.expectedRevision, proposedDigest: digest, changeKind: proposal.changeKind!,
      bindingId: context.bindingId!, bindingVersion: context.bindingVersion!, accountEpoch: context.accountEpoch,
      dataSpaceId: context.dataSpaceId, dataGeneration: context.dataGeneration, deviceId: context.deviceId };
    const after = (proposal.value as { text: string }).text;
    const approvalId = await runtime.approve(pending.source, intent, settingsChangePreview(pending.before, after));
    pending.digest = digest; pending.approvalId = approvalId;
  };
  handle = async (request: AgentSettingsToolRequest, signal: AbortSignal): Promise<DecisionToolResponse> => {
    for (const [id, cached] of this.calls) {
      try { this.deps.runtime().assertSource(cached.source); } catch { this.calls.delete(id); }
    }
    const source = this.deps.runtime().source(request.context);
    const key = JSON.stringify([source.sessionKey, source.runId, source.toolCallId]);
    const hash = payloadHash(request.args), existing = this.calls.get(key);
    if (existing) return existing.hash === hash ? existing.result : result({ reason: 'SETTINGS_OPERATION_ID_CONFLICT' }, true);
    // Bound transient results. Never evict an in-flight intent to allow a duplicate mutation.
    if (this.calls.size >= 256) return result({ reason: 'SETTINGS_RATE_LIMITED' }, true);
    const work = this.execute(source, request.args, signal).catch(error => result({ reason: reason(error) }, true));
    if (request.args.action !== 'read') this.calls.set(key, { source, hash, result: work });
    return work.finally(() => { if (request.args.action === 'read') this.deps.runtime().forget(source.toolCallId); });
  };
  private async execute(source: SettingsConversationSource, args: Record<string, unknown>, signal: AbortSignal): Promise<DecisionToolResponse> {
    const protocol = this.deps.protocol(), runtime = this.deps.runtime();
    if (!protocol || signal.aborted || Object.keys(args).some(k => !['action', 'section', 'expectedRevision', 'text', 'changeKind', 'selection'].includes(k))
      || !textSections.has(String(args.section))) throw new Error('SETTINGS_INVALID_REQUEST');
    const section = args.section as AgentSettingsSection;
    const sourcePropagationDeadline = Date.now() + 3000;
    let access: SettingsConversationAccess;
    for (;;) {
      runtime.assertSource(source);
      if (signal.aborted) throw new Error('CONVERSATION_SOURCE_INVALID');
      try { access = await protocol.accessForConversation({ agentId: source.agentId, commandId: source.commandId, runId: source.remoteRunId }); break; }
      catch (error) {
        if (!['CONVERSATION_SOURCE_INVALID', 'CONVERSATION_CHANGE_UNAVAILABLE'].includes(reason(error))
          || Date.now() >= sourcePropagationDeadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    const context: AgentSettingsContext = { ...access.context, toolCallId: source.toolCallId };
    runtime.assertSource(source);
    const snapshot = await this.deps.service.read(context, section);
    if (args.action === 'read') {
      if (Object.keys(args).some(k => !['action', 'section'].includes(k))) throw new Error('SETTINGS_INVALID_REQUEST');
      return result({ section, ...snapshot });
    }
    if (args.action !== 'update' || typeof args.text !== 'string' || typeof args.expectedRevision !== 'string'
      || !['append', 'replace_selection', 'replace_all', 'clear'].includes(String(args.changeKind))) throw new Error('SETTINGS_INVALID_REQUEST');
    if (snapshot.revision !== args.expectedRevision) throw new Error('SETTINGS_REVISION_CONFLICT');
    if (snapshot.value.text === args.text) return result({ status: AgentSettingsPhase.NoChange, section, revision: snapshot.revision });
    if (signal.aborted) throw new Error('CONVERSATION_SOURCE_INVALID');
    const operationId = randomUUID();
    const proposal: AgentSettingsProposal = { operationId, section, expectedRevision: args.expectedRevision, value: { text: args.text },
      changeKind: args.changeKind as AgentSettingsProposal['changeKind'], ...(args.selection !== undefined ? { selection: args.selection as AgentSettingsProposal['selection'] } : {}) };
    const pending: Pending = { source, access, proposal, before: String(snapshot.value.text) };
    this.pending.set(operationId, pending);
    let locallyPrepared = false;
    try {
      const prepared = await this.deps.service.prepare(context, proposal);
      if (prepared.status === AgentSettingsPhase.NoChange) return result({ status: prepared.status, section, revision: prepared.revision });
      locallyPrepared = true;
      if (signal.aborted || pending.digest !== prepared.proposedDigest || !pending.approvalId) throw new Error('SETTINGS_APPROVAL_STALE');
      runtime.assertSource(source);
      const registration = { operationId, commandId: source.commandId, runId: source.remoteRunId, toolCallId: source.toolCallId,
        section, expectedRevision: proposal.expectedRevision, proposedDigest: prepared.proposedDigest, changeKind: proposal.changeKind!, approvalId: pending.approvalId };
      const approvalPropagationDeadline = Date.now() + 3000;
      for (;;) {
        runtime.assertSource(source);
        if (signal.aborted) throw new Error('CONVERSATION_SOURCE_INVALID');
        try { await protocol.prepareConversation({ ...access, context }, registration); break; }
        catch (error) {
          // Control facts are published asynchronously. Reuse the exact intent and
          // original journal; never retry a revoked source or renew an operation.
          if (!['SETTINGS_APPROVAL_REQUIRED', 'SETTINGS_APPROVAL_STALE'].includes(reason(error))
            || Date.now() >= approvalPropagationDeadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      const receipt = await this.deps.service.apply(context, operationId, async () => {
        runtime.assertSource(source);
        if (signal.aborted) throw new Error('CONVERSATION_SOURCE_INVALID');
        return protocol.acquirePermit(operationId);
      });
      await protocol.complete(operationId, receipt);
      return result({ ...receipt, commandId: source.commandId, runId: source.remoteRunId }, receipt.status !== AgentSettingsPhase.Applied);
    } catch (error) {
      if (!locallyPrepared) throw error;
      // Only a journal that has never requested a permit may be cancelled. A lost
      // permit/result reply remains reconciling; the protocol worker settles it.
      const receipt = await this.deps.service.cancelPrepared(context, operationId, reason(error));
      await protocol.complete(operationId, receipt).catch((): void => undefined);
      return result({ ...receipt, reason: reason(error), commandId: source.commandId, runId: source.remoteRunId }, true);
    } finally { this.pending.delete(operationId); runtime.forget(source.toolCallId); }
  }
}
