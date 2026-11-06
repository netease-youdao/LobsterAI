import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { readSettingsDocument, writeSettingsFile } from './storage';
import {
  AgentSettingsAction, type AgentSettingsContext, type AgentSettingsDependencies, AgentSettingsError,
  type AgentSettingsModelSelection, type AgentSettingsPermit, AgentSettingsPhase, type AgentSettingsPrepared,
  type AgentSettingsProposal, AgentSettingsReason, type AgentSettingsReceipt, AgentSettingsSection,
  type AgentSettingsSnapshot, AgentSettingsSource,
} from './types';

const sections = Object.values(AgentSettingsSection);
const textLimits: Partial<Record<AgentSettingsSection, number>> = {
  identity: 16 * 1024, memory: 64 * 1024, userProfile: 16 * 1024,
};
const fileNames: Partial<Record<AgentSettingsSection, string>> = { identity: 'IDENTITY.md', memory: 'MEMORY.md', userProfile: 'USER.md' };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const fail = (reason: string): never => { throw new AgentSettingsError(reason); };
const textSection = (section: AgentSettingsSection): boolean => textLimits[section] !== undefined;
const validId = (id: string): boolean => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id);
const record = (value: unknown, allowed: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail(AgentSettingsReason.Invalid);
  return value as Record<string, unknown>;
};
interface Source { value: Record<string, unknown>; fingerprint: string; contentHash: string; documentState?: AgentSettingsSnapshot['documentState']; sourceUpdatedAt?: string | null }
interface Journal {
  context: AgentSettingsContext; requestHash: string; proposal: AgentSettingsProposal; proposedDigest: string;
  beforeHash: string; afterHash: string; patch: Record<string, unknown>; phase: string; preparedRevision: string;
  permit?: AgentSettingsPermit; persisted?: boolean; noMutation?: boolean; receipt?: AgentSettingsReceipt; completedAt?: number;
}
interface State { schemaVersion: 1; fingerprint: string; revision: string; activeOperationId?: string; operations: Record<string, Journal> }

/** Domain kernel: transport credentials/approval evidence are checked by mandatory trusted host ports. */
export class AgentSettingsService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly now: () => number;
  constructor(private readonly deps: AgentSettingsDependencies) { this.now = deps.now ?? Date.now; }

  private scope(context: AgentSettingsContext): string {
    return canonical([context.dataSpaceId, context.dataGeneration, context.owner.userId, context.owner.scopeKey,
      context.deviceId, context.agentId, context.accountEpoch]);
  }
  private key(context: AgentSettingsContext, section: AgentSettingsSection): string { return `agent-settings:${this.scope(context)}:${section}`; }
  private fenceKey(context: AgentSettingsContext, section: AgentSettingsSection): string {
    // Physical files/Agent rows survive account and database-generation changes.
    return `agent-settings-write-fence:${context.agentId}:${section}`;
  }
  private reserveFence(context: AgentSettingsContext, section: AgentSettingsSection, operationId: string): void {
    if (this.deps.store.get(this.fenceKey(context, section))) return fail(AgentSettingsReason.Pending);
    this.deps.store.set(this.fenceKey(context, section), { scope: this.scope(context), operationId });
  }
  private releaseFence(context: AgentSettingsContext, section: AgentSettingsSection, operationId: string): void {
    const fence = this.deps.store.get<{ scope: string; operationId: string }>(this.fenceKey(context, section));
    if (fence && fence.scope === this.scope(context) && fence.operationId === operationId) this.deps.store.set(this.fenceKey(context, section), null);
  }
  private assertFence(context: AgentSettingsContext, section: AgentSettingsSection, operationId: string): void {
    const fence = this.deps.store.get<{ scope: string; operationId: string }>(this.fenceKey(context, section));
    if (!fence || fence.scope !== this.scope(context) || fence.operationId !== operationId) return fail(AgentSettingsReason.LocalAction);
  }
  private checkRecoverySource(context: AgentSettingsContext, section: AgentSettingsSection): void {
    if (!this.deps.assertRecoverySourceAccess) { this.check(context, section); return; }
    this.deps.assertRecoverySourceAccess(context);
    const agent = this.deps.getAgent(context);
    if (!agent || agent.id !== context.agentId || !agent.enabled) fail(AgentSettingsReason.Agent);
  }
  private check(context: AgentSettingsContext, section: AgentSettingsSection, write = false): void {
    if (!sections.includes(section) || !validId(context.agentId) || !context.owner?.userId || !context.owner.scopeKey
      || !context.deviceId || !context.dataSpaceId || !context.dataGeneration || !context.accountEpoch
      || !Object.values(AgentSettingsSource).includes(context.source)) fail(AgentSettingsReason.Invalid);
    if (write && textSection(section) && context.source !== AgentSettingsSource.Conversation) fail(AgentSettingsReason.DirectEdit);
    this.deps.assertAccess(context, section, !write ? AgentSettingsAction.Read
      : textSection(section) ? AgentSettingsAction.ConversationUpdate : AgentSettingsAction.DirectUpdate);
    const agent = this.deps.getAgent(context);
    if (!agent || agent.id !== context.agentId || !agent.enabled) fail(AgentSettingsReason.Agent);
  }
  private file(context: AgentSettingsContext, section: AgentSettingsSection): string {
    const filename = fileNames[section];
    if (!filename || !validId(context.agentId)) return fail(AgentSettingsReason.Invalid);
    return path.join(this.deps.stateDir, `workspace-${context.agentId}`, filename);
  }
  private async exclusive<T>(context: AgentSettingsContext, section: AgentSettingsSection, operation: () => Promise<T>): Promise<T> {
    // Main's files are device-shared: do not partition the process lock by account or binding.
    const key = `${context.agentId}:${section}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(key, current);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.queues.get(key) === current) this.queues.delete(key); }
  }
  private load(context: AgentSettingsContext, section: AgentSettingsSection): State {
    const state = this.deps.store.get<State>(this.key(context, section));
    if (!state) return { schemaVersion: 1, fingerprint: '', revision: randomUUID(), operations: {} };
    if (state.schemaVersion !== 1 || typeof state.revision !== 'string' || !state.operations || typeof state.operations !== 'object') return fail(AgentSettingsReason.LocalAction);
    return state;
  }
  private save(context: AgentSettingsContext, section: AgentSettingsSection, state: State): void { this.deps.store.set(this.key(context, section), state); }
  private revision(context: AgentSettingsContext, section: AgentSettingsSection, state: State, source: Source): string {
    if (state.fingerprint !== source.fingerprint) { state.fingerprint = source.fingerprint; state.revision = randomUUID(); this.save(context, section, state); }
    return state.revision;
  }
  private async source(context: AgentSettingsContext, section: AgentSettingsSection, recovery = false): Promise<Source> {
    const assertAccess = () => recovery ? this.checkRecoverySource(context, section) : this.check(context, section);
    assertAccess();
    const agent = this.deps.getAgent(context)!;
    if (section === AgentSettingsSection.Model) {
      const value = { ...await this.deps.readModel(context, agent) };
      assertAccess();
      const fresh = this.deps.getAgent(context)!;
      if (fresh.model !== agent.model || fresh.thinkingLevel !== agent.thinkingLevel || fresh.updatedAt !== agent.updatedAt) return fail(AgentSettingsReason.Conflict);
      const contentHash = digest({ model: agent.model, thinkingLevel: agent.thinkingLevel });
      return { value, contentHash, fingerprint: digest({ value, contentHash, updatedAt: agent.updatedAt }) };
    }
    if (section === AgentSettingsSection.Collaboration) {
      const candidates = await this.deps.listCollaborators(context);
      assertAccess();
      const fresh = this.deps.getAgent(context)!;
      if (canonical(fresh.subagentAllowAgentIds) !== canonical(agent.subagentAllowAgentIds) || fresh.updatedAt !== agent.updatedAt) return fail(AgentSettingsReason.Conflict);
      if (candidates.length > 200 || new Set(candidates.map(item => item.agentId)).size !== candidates.length) return fail(AgentSettingsReason.LocalAction);
      const permitted = candidates.filter(item => item.agentId !== context.agentId);
      const selected = agent.subagentAllowAgentIds.map(id => permitted.find(item => item.agentId === id));
      const requiresLocalCleanup = selected.some(item => !item);
      const value = { candidates: permitted, selected: (requiresLocalCleanup ? [] : selected.filter(item => !!item)).map(item => ({ agentId: item!.agentId, agentVersion: item!.agentVersion })), requiresLocalCleanup };
      const contentHash = digest(agent.subagentAllowAgentIds);
      return { value, contentHash, fingerprint: digest({ value, contentHash, updatedAt: agent.updatedAt }) };
    }
    const projectionNewline = section === AgentSettingsSection.Identity && context.agentId !== 'main' ? 1 : 0;
    const document = readSettingsDocument(this.file(context, section), textLimits[section]! + projectionNewline);
    const text = section === AgentSettingsSection.Identity && context.agentId !== 'main' ? agent.identity : document.text;
    this.validateText(text, section);
    const contentHash = digest({ text });
    return { value: { text }, contentHash, fingerprint: digest({ text, document, ...(section === AgentSettingsSection.Identity && context.agentId !== 'main' ? { updatedAt: agent.updatedAt } : {}) }),
      documentState: section === AgentSettingsSection.Identity && context.agentId !== 'main' ? (text ? 'present' : 'empty') : document.state,
      sourceUpdatedAt: section === AgentSettingsSection.Identity && context.agentId !== 'main'
        ? agent.updatedAt ? new Date(agent.updatedAt).toISOString() : null : document.modifiedAt };
  }
  private validateText(text: unknown, section: AgentSettingsSection): asserts text is string {
    if (typeof text !== 'string' || text.includes('\0') || Buffer.from(text).toString('utf8') !== text) fail(AgentSettingsReason.Invalid);
    if (Buffer.byteLength(text as string) > textLimits[section]!) fail(AgentSettingsReason.TooLarge);
  }
  async read(context: AgentSettingsContext, section: AgentSettingsSection): Promise<AgentSettingsSnapshot> {
    return this.exclusive(context, section, async () => {
      const source = await this.source(context, section), state = this.load(context, section);
      const revision = this.revision(context, section, state, source);
      this.check(context, section);
      return { revision, value: source.value, readAt: new Date(this.now()).toISOString(),
        ...(source.documentState ? { documentState: source.documentState, sourceUpdatedAt: source.sourceUpdatedAt ?? null } : {}) };
    });
  }
  private async candidate(context: AgentSettingsContext, proposal: AgentSettingsProposal, current: Source): Promise<{ value: unknown; patch: Record<string, unknown>; afterHash: string }> {
    record(proposal, ['operationId', 'section', 'expectedRevision', 'value', 'changeKind', 'selection']);
    if (!textSection(proposal.section) && (proposal.changeKind !== undefined || proposal.selection !== undefined)) return fail(AgentSettingsReason.Invalid);
    if (proposal.section === AgentSettingsSection.Model) {
      const value = record(proposal.value, ['modelRef', 'modelVersion', 'thinkingLevel']);
      if (!validId(value.modelRef as string) || typeof value.modelVersion !== 'string' || !/^\d+$/u.test(value.modelVersion)
        || !(value.thinkingLevel === null || typeof value.thinkingLevel === 'string')) return fail(AgentSettingsReason.Invalid);
      const selection = value as unknown as AgentSettingsModelSelection;
      const patch = await this.deps.resolveModel(context, selection);
      if (!patch.model || typeof patch.thinkingLevel !== 'string') return fail(AgentSettingsReason.Invalid);
      return { value: selection, patch, afterHash: digest(patch) };
    }
    if (proposal.section === AgentSettingsSection.Collaboration) {
      const value = record(proposal.value, ['selected']);
      if (current.value.requiresLocalCleanup) return fail(AgentSettingsReason.Cleanup);
      if (!Array.isArray(value.selected) || value.selected.length > 50) return fail(AgentSettingsReason.Invalid);
      const candidates = current.value.candidates as Array<{ agentId: string; agentVersion: string }>;
      const selected = value.selected.map(item => {
        const entry = record(item, ['agentId', 'agentVersion']);
        if (!validId(entry.agentId as string) || entry.agentId === context.agentId || typeof entry.agentVersion !== 'string'
          || !candidates.some(candidate => candidate.agentId === entry.agentId && candidate.agentVersion === entry.agentVersion)) return fail(AgentSettingsReason.Collaborator);
        return { agentId: entry.agentId as string, agentVersion: entry.agentVersion };
      });
      const ids = selected.map(item => item.agentId);
      if (new Set(ids).size !== ids.length) return fail(AgentSettingsReason.Invalid);
      return { value: { selected }, patch: { subagentAllowAgentIds: ids }, afterHash: digest(ids) };
    }
    const value = record(proposal.value, ['text']);
    this.validateText(value.text, proposal.section);
    // Match the existing SQLite identity -> IDENTITY projection's normalization.
    const text = proposal.section === AgentSettingsSection.Identity && context.agentId !== 'main' ? value.text.trim() : value.text;
    const original = current.value.text as string;
    if (proposal.changeKind === 'append') {
      if (!text.startsWith(original) || proposal.selection !== undefined) return fail(AgentSettingsReason.Invalid);
    } else if (proposal.changeKind === 'replace_selection') {
      const selection = record(proposal.selection, ['start', 'end', 'expectedText']);
      const { start, end, expectedText } = selection;
      if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) < (start as number)
        || (end as number) > original.length || typeof expectedText !== 'string' || original.slice(start as number, end as number) !== expectedText
        || !text.startsWith(original.slice(0, start as number)) || !text.endsWith(original.slice(end as number))
        || text.length < (start as number) + original.length - (end as number)) return fail(AgentSettingsReason.Invalid);
    } else if (proposal.changeKind === 'clear') {
      if (text !== '' || proposal.selection !== undefined) return fail(AgentSettingsReason.Invalid);
    } else if (proposal.changeKind !== 'replace_all' || proposal.selection !== undefined) return fail(AgentSettingsReason.Invalid);
    return { value: { text }, patch: { text }, afterHash: digest({ text }) };
  }
  async prepare(context: AgentSettingsContext, proposal: AgentSettingsProposal): Promise<AgentSettingsPrepared> {
    context = structuredClone(context); proposal = structuredClone(proposal);
    this.check(context, proposal.section, true);
    if (!validId(proposal.operationId) || typeof proposal.expectedRevision !== 'string' || !proposal.expectedRevision) return fail(AgentSettingsReason.Invalid);
    let approvedDigest: string | undefined;
    if (textSection(proposal.section)) {
      const approval = await this.exclusive(context, proposal.section, async () => {
        this.check(context, proposal.section, true);
        const state = this.load(context, proposal.section);
        if (state.operations[proposal.operationId]) return null;
        if (state.activeOperationId || this.deps.store.get(this.fenceKey(context, proposal.section))) return fail(AgentSettingsReason.Pending);
        const source = await this.source(context, proposal.section);
        if (this.revision(context, proposal.section, state, source) !== proposal.expectedRevision) return fail(AgentSettingsReason.Conflict);
        const candidate = await this.candidate(context, proposal, source);
        const normalized = { ...proposal, value: candidate.value };
        return { normalized, proposedDigest: digest({ context, proposal: normalized }), noChange: source.contentHash === candidate.afterHash, revision: state.revision };
      });
      if (approval) {
        if (!this.deps.authorizeConversation || !context.commandId || !context.runId || !context.toolCallId) return fail(AgentSettingsReason.Conversation);
        if (approval.noChange) return { operationId: proposal.operationId, section: proposal.section, revision: approval.revision, proposedDigest: approval.proposedDigest, status: AgentSettingsPhase.NoChange };
        // Never hold the partition queue or writer lease while asking the user to approve.
        await this.deps.authorizeConversation(context, approval.normalized, approval.proposedDigest);
        approvedDigest = approval.proposedDigest;
      }
    }
    return this.exclusive(context, proposal.section, async () => {
      this.check(context, proposal.section, true);
      if (!validId(proposal.operationId) || typeof proposal.expectedRevision !== 'string' || !proposal.expectedRevision) return fail(AgentSettingsReason.Invalid);
      const requestHash = digest({ context, proposal });
      const state = this.load(context, proposal.section), existing = state.operations[proposal.operationId];
      if (existing) {
        if (existing.requestHash !== requestHash) return fail(AgentSettingsReason.OperationConflict);
        return { operationId: proposal.operationId, section: proposal.section, revision: existing.preparedRevision, proposedDigest: existing.proposedDigest, status: AgentSettingsPhase.Prepared };
      }
      if (state.activeOperationId || this.deps.store.get(this.fenceKey(context, proposal.section))) return fail(AgentSettingsReason.Pending);
      const source = await this.source(context, proposal.section);
      if (this.revision(context, proposal.section, state, source) !== proposal.expectedRevision) return fail(AgentSettingsReason.Conflict);
      const candidate = await this.candidate(context, proposal, source);
      this.check(context, proposal.section, true);
      const normalized = { ...proposal, value: candidate.value };
      const proposedDigest = digest({ context, proposal: normalized });
      if (textSection(proposal.section)) {
        if (!approvedDigest || approvedDigest !== proposedDigest) return fail(AgentSettingsReason.Conflict);
        this.check(context, proposal.section, true);
      }
      if (source.contentHash === candidate.afterHash && textSection(proposal.section)) return { operationId: proposal.operationId, section: proposal.section, revision: state.revision, proposedDigest, status: AgentSettingsPhase.NoChange };
      // Persist the physical fence first. A crash before intent persistence stays blocked for local repair.
      this.reserveFence(context, proposal.section, proposal.operationId);
      // A single atomic state write persists both the full prepared intent and its partition fence.
      state.operations[proposal.operationId] = { context: structuredClone(context), requestHash, proposal: normalized, proposedDigest,
        beforeHash: source.contentHash, afterHash: candidate.afterHash, patch: candidate.patch, phase: AgentSettingsPhase.Prepared,
        noMutation: source.contentHash === candidate.afterHash, preparedRevision: state.revision };
      state.activeOperationId = proposal.operationId;
      this.save(context, proposal.section, state);
      return { operationId: proposal.operationId, section: proposal.section, revision: state.revision, proposedDigest, status: AgentSettingsPhase.Prepared };
    });
  }
  private find(context: AgentSettingsContext, operationId: string): { section: AgentSettingsSection; state: State; journal: Journal } {
    for (const section of sections) {
      const state = this.load(context, section), journal = state.operations[operationId];
      if (journal) {
        if (canonical(journal.context) !== canonical(context)) return fail(AgentSettingsReason.OperationConflict);
        return { section, state, journal };
      }
    }
    return fail(AgentSettingsReason.LocalAction);
  }
  async apply(context: AgentSettingsContext, operationId: string, acquirePermit: () => Promise<AgentSettingsPermit>): Promise<AgentSettingsReceipt> {
    const found = this.find(context, operationId);
    return this.exclusive(context, found.section, async () => {
      const { section, state, journal } = this.find(context, operationId);
      this.check(context, section, true);
      if (journal.receipt) { this.releaseFence(context, section, operationId); return journal.receipt; }
      if (journal.phase !== AgentSettingsPhase.Prepared) return { operationId, section, status: AgentSettingsPhase.Reconciling };
      this.assertFence(context, section, operationId);
      const lease = await this.deps.acquireWriteLease(context, section);
      try {
        lease.assertCurrent(); this.check(context, section, true);
        const before = await this.source(context, section);
        if (this.revision(context, section, state, before) !== journal.preparedRevision || before.contentHash !== journal.beforeHash) return fail(AgentSettingsReason.Conflict);
        const candidate = await this.candidate(context, journal.proposal, before);
        if (candidate.afterHash !== journal.afterHash) return fail(AgentSettingsReason.Conflict);
        if (textSection(section)) {
          if (!this.deps.authorizeConversation) return fail(AgentSettingsReason.Conversation);
          await this.deps.authorizeConversation(context, journal.proposal, journal.proposedDigest);
        }
        lease.assertCurrent(); this.check(context, section, true);
        // Persist before the network call: a lost permit response must never look unattempted.
        journal.phase = AgentSettingsPhase.Applying;
        this.save(context, section, state);
        const permit = await acquirePermit();
        journal.permit = permit; this.save(context, section, state);
        lease.assertCurrent(); this.check(context, section, true);
        if (!permit.permitId || !Number.isFinite(permit.startBefore) || permit.startBefore < this.now()) return fail(AgentSettingsReason.Expired);
        const latest = await this.source(context, section);
        if (latest.fingerprint !== before.fingerprint) return fail(AgentSettingsReason.Conflict);
        // The target model may differ from the current default; refresh its catalog version after permit I/O.
        const checkedCandidate = await this.candidate(context, journal.proposal, latest);
        if (checkedCandidate.afterHash !== journal.afterHash) return fail(AgentSettingsReason.Conflict);
        lease.assertCurrent(); this.check(context, section, true);
        if (permit.startBefore < this.now()) return fail(AgentSettingsReason.Expired);
        if (journal.noMutation) { /* Confirm the unchanged value without touching SQLite timestamps. */ }
        else if (textSection(section)) {
          const text = journal.patch.text as string;
          if (section === AgentSettingsSection.Identity && context.agentId !== 'main') {
            this.deps.updateAgent(context, { identity: text });
            writeSettingsFile(this.file(context, section), text ? `${text}\n` : '');
          } else writeSettingsFile(this.file(context, section), text);
        } else this.deps.updateAgent(context, journal.patch);
        journal.phase = AgentSettingsPhase.Persisted; journal.persisted = true; this.save(context, section, state);
        await this.deps.confirmApplied(context, section);
        lease.assertCurrent(); this.check(context, section, true);
        const after = await this.source(context, section);
        if (after.contentHash !== journal.afterHash) return fail(AgentSettingsReason.Conflict);
        const revision = this.revision(context, section, state, after);
        journal.phase = AgentSettingsPhase.Applied;
        journal.receipt = { operationId, section, status: AgentSettingsPhase.Applied, revision, effect: 'future_safe_boundary' };
        journal.completedAt = this.now(); delete state.activeOperationId;
        // Retain evidence, not the user's complete previous/proposed document after completion.
        journal.proposal = { ...journal.proposal, value: null, selection: undefined }; journal.patch = {};
        this.save(context, section, state); this.releaseFence(context, section, operationId);
        return journal.receipt;
      } catch (error) {
        if (journal.phase !== AgentSettingsPhase.Prepared) {
          journal.phase = AgentSettingsPhase.Reconciling;
          // A permit was attempted: recovery never rewrites, so keep only hashes/receipt evidence.
          journal.proposal = { ...journal.proposal, value: null, selection: undefined }; journal.patch = {};
          this.save(context, section, state);
        }
        throw error;
      } finally { lease.release(); }
    });
  }
  /** Cancels only an intent for which this process has never attempted a permit. */
  async cancelPrepared(context: AgentSettingsContext, operationId: string, reason: string = AgentSettingsReason.LocalAction): Promise<AgentSettingsReceipt> {
    const found = this.find(context, operationId);
    return this.exclusive(context, found.section, async () => {
      const { section, state, journal } = this.find(context, operationId);
      if (this.deps.assertRecoveryAccess) this.deps.assertRecoveryAccess(context);
      else this.check(context, section);
      if (journal.receipt) { this.releaseFence(context, section, operationId); return journal.receipt; }
      if (journal.phase !== AgentSettingsPhase.Prepared) return { operationId, section, status: AgentSettingsPhase.Reconciling };
      journal.phase = AgentSettingsPhase.Rejected;
      journal.receipt = { operationId, section, status: AgentSettingsPhase.Rejected, reason };
      journal.completedAt = this.now(); delete state.activeOperationId;
      journal.proposal = { ...journal.proposal, value: null, selection: undefined }; journal.patch = {};
      this.save(context, section, state); this.releaseFence(context, section, operationId);
      return journal.receipt;
    });
  }
  /** Recovery never repeats the mutation or obtains another permit. */
  async recover(context: AgentSettingsContext, operationId: string): Promise<AgentSettingsReceipt> {
    const found = this.find(context, operationId);
    return this.exclusive(context, found.section, async () => {
      const { section, state, journal } = this.find(context, operationId);
      if (this.deps.assertRecoveryAccess) this.deps.assertRecoveryAccess(context);
      else this.check(context, section);
      if (journal.receipt) { this.releaseFence(context, section, operationId); return journal.receipt; }
      if (journal.phase === AgentSettingsPhase.Prepared) {
        journal.phase = AgentSettingsPhase.Rejected;
        journal.receipt = { operationId, section, status: AgentSettingsPhase.Rejected, reason: AgentSettingsReason.LocalAction };
        journal.completedAt = this.now(); delete state.activeOperationId;
        journal.proposal = { ...journal.proposal, value: null, selection: undefined }; journal.patch = {};
        this.save(context, section, state); this.releaseFence(context, section, operationId); return journal.receipt;
      }
      if (!journal.persisted) return { operationId, section, status: AgentSettingsPhase.Reconciling };
      try { this.assertFence(context, section, operationId); this.checkRecoverySource(context, section); }
      catch { return { operationId, section, status: AgentSettingsPhase.Reconciling }; }
      const lease = await (this.deps.acquireRecoveryLease ?? this.deps.acquireWriteLease)(context, section);
      try {
        lease.assertCurrent(); this.checkRecoverySource(context, section);
        const current = await this.source(context, section, true);
        // A matching file alone does not establish who wrote it. Require our durable post-write evidence.
        if (!journal.persisted || current.contentHash !== journal.afterHash) return { operationId, section, status: AgentSettingsPhase.Reconciling };
        await this.deps.confirmApplied(context, section);
        lease.assertCurrent(); this.checkRecoverySource(context, section);
        const confirmed = await this.source(context, section, true);
        if (confirmed.contentHash !== journal.afterHash) return { operationId, section, status: AgentSettingsPhase.Reconciling };
        journal.receipt = { operationId, section, status: AgentSettingsPhase.Applied, revision: this.revision(context, section, state, confirmed), effect: 'future_safe_boundary' };
        journal.phase = AgentSettingsPhase.Applied; journal.completedAt = this.now(); delete state.activeOperationId;
        journal.proposal = { ...journal.proposal, value: null, selection: undefined }; journal.patch = {};
        this.save(context, section, state); this.releaseFence(context, section, operationId); return journal.receipt;
      } finally { lease.release(); }
    });
}
}
