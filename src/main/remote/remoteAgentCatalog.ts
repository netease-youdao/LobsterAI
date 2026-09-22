import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { resolve } from 'path';

import { AgentId, AgentOwnerKind } from '../../shared/agent/constants';
import { REMOTE_AGENT_CATALOG_BYTES, REMOTE_AGENT_CATALOG_ITEMS, type RemoteAgentCatalogItem, RemoteAgentReason, RemoteAgentState, type RemoteAgentSummary, type RemoteOwner } from '../../shared/remote/constants';
import type { AgentOwnerStore } from '../agentOwnership';
import { payloadHash, sameOwner } from './canonical';
import type { RemoteStore } from './remoteStore';

interface AgentRow { id: string; name: string; icon: string; enabled: number }
interface WorkspaceBinding { agentId: string; workspaceId: string; path: string; available: boolean }
interface Publication { publicationId: string; expectedCatalogVersion: string; items: RemoteAgentCatalogItem[] }
const AGENT_VERSION_CONFLICT = 47029;
interface CatalogState { catalogVersion: string; syncedHash: string | null; syncedItems?: RemoteAgentCatalogItem[]; pending: Publication | null }
export interface AgentWorkspace { path: string; name: string; available?: boolean }
export class RemoteAgentError extends Error {
  constructor(readonly code: number, readonly reason: string, readonly reasonDetail: string) { super(reason); }
}
const safeName = (name: string): string => Array.from(name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim()).slice(0, 128).join('') || 'Agent';
const emojiBase = (cp: number): boolean => cp >= 0x1f000 && cp <= 0x1faff || cp >= 0x2190 && cp <= 0x23ff
  || cp >= 0x2600 && cp <= 0x27bf || cp >= 0x2b00 && cp <= 0x2bff
  || [0xa9, 0xae, 0x20e3, 0x2122, 0x2139, 0x3030, 0x303d, 0x3297, 0x3299].includes(cp);
const safeIcon = (icon: string): string | null => {
  if (!icon || Buffer.byteLength(icon) > 128) return null;
  if (/^[A-Za-z0-9_-]+$/u.test(icon)) return icon;
  const points = Array.from(icon, char => char.codePointAt(0)!);
  return points.some(emojiBase) && points.every(cp => emojiBase(cp) || cp >= 0xe0020 && cp <= 0xe007f
    || cp >= 0x30 && cp <= 0x39 || [0x23, 0x2a, 0x200d, 0xfe0e, 0xfe0f].includes(cp)) ? icon : null;
};
export const remoteAgentFailure = (detail: string): RemoteAgentError => new RemoteAgentError(47028, 'AGENT_UNAVAILABLE', detail);

/** A device publishes one bounded, durable snapshot; workspace aliases are never repointed. */
export class RemoteAgentCatalog {
  private operationEpoch = 0;
  constructor(private readonly store: RemoteStore, private readonly ownership: AgentOwnerStore,
    private readonly getWorkspace: (agentId: string) => Promise<AgentWorkspace> | AgentWorkspace,
    private readonly getDefaultInput?: (owner: RemoteOwner, deviceId: string, agentId: string) => RemoteAgentCatalogItem['defaultInput'],
    private readonly getTargetId?: () => string | null) {}
  reset(): void { this.operationEpoch++; }
  private targetId(): string | undefined {
    const targetId = this.getTargetId?.();
    if (this.getTargetId && !targetId) throw new Error('Remote target is not ready');
    return targetId ?? undefined;
  }
  private scope(parts: string[]): string { return JSON.stringify([...(this.getTargetId ? [this.targetId()] : []), ...parts]); }
  private key(owner: RemoteOwner, deviceId: string): string { return `agentCatalog:${this.scope([owner.userId, owner.scopeKey, deviceId])}`; }
  private workspaceKey(owner: RemoteOwner, deviceId: string, agentId: string): string { return `agentWorkspaces:${this.scope([owner.userId, owner.scopeKey, deviceId, agentId])}`; }
  private row(agentId: string): AgentRow | undefined { return this.store.db.prepare('SELECT id,name,icon,enabled FROM agents WHERE id=?').get(agentId) as AgentRow | undefined; }
  summary(sessionId: string, actor: RemoteOwner): RemoteAgentSummary | null {
    if (!sameOwner(this.store.owner(sessionId), actor)) return null;
    const session = this.store.db.prepare('SELECT agent_id FROM cowork_sessions WHERE id=?').get(sessionId) as { agent_id: string } | undefined;
    if (!session) return null;
    return this.agentSummary(session.agent_id || AgentId.Main, actor);
  }
  private agentSummary(agentId: string, actor: RemoteOwner): RemoteAgentSummary | null {
    const identity = this.ownership.get(agentId);
    if (!identity || identity.ownerKind === AgentOwnerKind.Quarantined
      || identity.ownerKind === AgentOwnerKind.Owned && !sameOwner(identity.owner, actor)) return null;
    const row = this.row(agentId);
    const cached = this.store.get<RemoteAgentSummary>(`agentSummary:${agentId}`);
    if (!row) return cached ? { ...cached, version: identity.version, state: identity.deletedAt ? RemoteAgentState.Deleted : RemoteAgentState.Unknown } : null;
    const summary: RemoteAgentSummary = { agentId, name: safeName(row.name), icon: safeIcon(row.icon),
      kind: identity.ownerKind, version: identity.version, state: row.enabled ? RemoteAgentState.Available : RemoteAgentState.Disabled };
    this.store.put(`agentSummary:${agentId}`, summary);
    return summary;
  }
  async refresh(owner: RemoteOwner, deviceId: string, stillCurrent: () => boolean,
    canPublishAgent: (agentId: string) => boolean = () => true): Promise<RemoteAgentCatalogItem[]> {
    const targetId = this.targetId(), epoch = this.operationEpoch;
    const isCurrent = () => stillCurrent() && this.getTargetId?.() === targetId && this.operationEpoch === epoch;
    if (!isCurrent()) throw new Error('Account changed');
    const items: RemoteAgentCatalogItem[] = [];
    for (const identity of this.ownership.list()) {
      if (!this.ownership.canView(identity.agentId, owner)) continue;
      this.agentSummary(identity.agentId, owner);
      if (!this.ownership.canPublish(identity.agentId, owner) || !canPublishAgent(identity.agentId)) continue;
      const beforeVersion = this.ownership.get(identity.agentId)!.version;
      let workspace: AgentWorkspace | null = null;
      try { workspace = await this.getWorkspace(identity.agentId); } catch { /* Publish unavailability, never substitute another Agent's path. */ }
      if (!isCurrent()) throw new Error('Account changed');
      if (!canPublishAgent(identity.agentId)) throw new Error('Agent ownership synchronization is waiting for server support');
      if (!this.ownership.canPublish(identity.agentId, owner) || this.ownership.get(identity.agentId)!.version !== beforeVersion) throw new Error('Agent changed while resolving its workspace');
      const path: string | null = workspace?.path ? resolve(workspace.path) : null;
      let available = false;
      try { available = Boolean(path && workspace?.available !== false && statSync(path).isDirectory()); } catch { available = false; }
      const stateKey = `agentWorkspaceState:${this.getTargetId ? this.scope([identity.agentId]) : identity.agentId}`;
      const defaultInput = this.getDefaultInput?.(owner, deviceId, identity.agentId);
      const fingerprint = payloadHash({ path, available, defaultInput: defaultInput || null });
      const previous = this.store.get<string>(stateKey);
      const workspaceKey = this.workspaceKey(owner, deviceId, identity.agentId);
      const bindings = this.store.get<WorkspaceBinding[]>(workspaceKey) || [];
      let binding = path && bindings.at(-1)?.path === path ? bindings.at(-1) : undefined;
      this.store.transaction(() => {
        if (path && !binding) { binding = { agentId: identity.agentId, workspaceId: randomUUID(), path, available }; bindings.push(binding); }
        if (binding) binding.available = available;
        this.store.put(workspaceKey, bindings);
        this.store.put(stateKey, fingerprint);
        if (previous !== null && previous !== fingerprint) this.ownership.touch(identity.agentId);
      });
      const summary = this.agentSummary(identity.agentId, owner)!;
      const row = this.row(identity.agentId)!;
      items.push({ agentId: summary.agentId, name: summary.name, icon: summary.icon, kind: summary.kind as 'default' | 'owned', version: summary.version,
        ...(defaultInput ? { defaultInput } : {}),
        enabled: Boolean(row.enabled), defaultWorkspaceId: binding?.workspaceId || null, workspaceAvailable: available,
        unavailableReason: !row.enabled ? RemoteAgentReason.Disabled : !available ? RemoteAgentReason.WorkspaceUnavailable : null });
    }
    return items.sort((a, b) => a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0);
  }
  resolve(owner: RemoteOwner, deviceId: string, agentId: string, version: string, workspaceId: string): string {
    if (!this.ownership.canPublish(agentId, owner)) throw remoteAgentFailure('NOT_SELECTABLE');
    const identity = this.ownership.get(agentId)!;
    if (identity.version !== version) throw new RemoteAgentError(AGENT_VERSION_CONFLICT, 'AGENT_VERSION_CONFLICT', 'VERSION_CHANGED');
    if (!this.row(agentId)?.enabled) throw remoteAgentFailure('DISABLED');
    const bindings = this.store.get<WorkspaceBinding[]>(this.workspaceKey(owner, deviceId, agentId)) || [];
    const binding = bindings.find(item => item.workspaceId === workspaceId);
    if (!binding || binding.agentId !== agentId) throw remoteAgentFailure('BINDING_MISMATCH');
    try { if (!binding.available || !statSync(binding.path).isDirectory()) throw remoteAgentFailure('WORKSPACE_UNAVAILABLE'); }
    catch { throw remoteAgentFailure('WORKSPACE_UNAVAILABLE'); }
    return binding.path;
  }
  isSynced(owner: RemoteOwner, deviceId: string, agentId: string): boolean {
    const state = this.store.get<CatalogState>(this.key(owner, deviceId));
    if (!state?.syncedItems || state.syncedHash !== payloadHash(state.syncedItems)) return false;
    const identity = this.ownership.get(agentId);
    const item = state.syncedItems.find(value => value.agentId === agentId);
    return this.ownership.canPublish(agentId, owner) && Boolean(item && item.version === identity?.version && item.kind === identity.ownerKind);
  }
  private retireRejectedPublication(owner: RemoteOwner, deviceId: string, state: CatalogState,
    current: { deviceId: string; catalogVersion: string; items: RemoteAgentCatalogItem[] }): void {
    const pending = state.pending!;
    if (current.deviceId !== deviceId || current.catalogVersion !== pending.expectedCatalogVersion || !Array.isArray(current.items)) return;
    const known = new Map(current.items.map(item => [item.agentId, item]));
    const changed: string[] = [];
    let versionReused = false;
    for (const item of pending.items) {
      const before = known.get(item.agentId);
      if (!before) continue;
      const identity = this.ownership.get(item.agentId);
      // Only repair a reused version. A rollback, changed identity, or lost ownership needs investigation.
      if (!identity || !this.ownership.canPublish(item.agentId, owner) || identity.ownerKind !== item.kind
        || before.kind !== item.kind || BigInt(item.version) < BigInt(before.version)
        || BigInt(identity.version) < BigInt(item.version)) return;
      if (item.version === before.version && payloadHash(item) !== payloadHash(before)) {
        versionReused = true;
        if (identity.version === before.version) changed.push(item.agentId);
      }
    }
    if (!versionReused) return;
    this.store.transaction(() => {
      for (const agentId of changed) this.ownership.touch(agentId);
      // The server explicitly rejected this immutable publication; the next tick builds a new ID and snapshot.
      this.store.put(this.key(owner, deviceId), { catalogVersion: current.catalogVersion, syncedHash: null, pending: null });
    });
  }
  async publish(owner: RemoteOwner, deviceId: string, generation: string, api: (path: string, method?: string, body?: unknown) => Promise<any>,
    stillCurrent: () => boolean, limits = { items: REMOTE_AGENT_CATALOG_ITEMS, bytes: REMOTE_AGENT_CATALOG_BYTES },
    canPublishAgent: (agentId: string) => boolean = () => true): Promise<void> {
    const targetId = this.targetId(), epoch = this.operationEpoch;
    const isCurrent = () => stillCurrent() && this.getTargetId?.() === targetId && this.operationEpoch === epoch;
    if (!isCurrent()) throw new Error('Account changed');
    const key = this.key(owner, deviceId);
    const path = `/devices/${deviceId}/agents`;
    let state = this.store.get<CatalogState>(key) || { catalogVersion: '0', syncedHash: null, pending: null };
    // GET first proves whether a previous uncertain PUT committed, including after WS reconnect.
    const current = await api(path);
    if (!isCurrent()) throw new Error('Account changed');
    if (state.pending && current.lastPublicationId === state.pending.publicationId) {
      state = { catalogVersion: current.catalogVersion, syncedHash: payloadHash(state.pending.items), syncedItems: state.pending.items, pending: null };
      this.store.put(key, state);
    } else if (state.pending && current.catalogVersion !== state.pending.expectedCatalogVersion) {
      state = { catalogVersion: current.catalogVersion, syncedHash: null, pending: null };
      this.store.put(key, state);
    } else if (!state.pending) state.catalogVersion = current.catalogVersion;
    if (!state.pending) {
      const items = await this.refresh(owner, deviceId, isCurrent, canPublishAgent);
      if (!isCurrent()) throw new Error('Account changed');
      if (items.length > limits.items || !items.some(item => item.agentId === AgentId.Main && item.kind === AgentOwnerKind.Default)) throw new RemoteAgentError(47012, 'PAYLOAD_TOO_LARGE', 'CATALOG_LIMIT');
      if (state.syncedHash === payloadHash(items) && current.syncStatus === 'ready' && payloadHash(current.items) === state.syncedHash) {
        this.store.put(key, { ...state, syncedItems: items }); return;
      }
      state.pending = { publicationId: randomUUID(), expectedCatalogVersion: state.catalogVersion, items };
      if (Buffer.byteLength(JSON.stringify({ ...state.pending, connectionGeneration: generation })) > limits.bytes) throw new RemoteAgentError(47012, 'PAYLOAD_TOO_LARGE', 'CATALOG_LIMIT');
      this.store.put(key, state);
    }
    // Pending content is immutable. A different admission context may delay it, never filter/rewrite its ID.
    if (state.pending.items.some(item => !canPublishAgent(item.agentId))) throw new Error('Agent ownership synchronization is waiting for server support');
    let result;
    try { result = await api(path, 'PUT', { ...state.pending, connectionGeneration: generation }); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === AGENT_VERSION_CONFLICT && isCurrent()) {
        const latest = await api(path);
        if (!isCurrent()) throw new Error('Account changed');
        if (latest.deviceId === deviceId && latest.lastPublicationId === state.pending.publicationId) {
          this.store.put(key, { catalogVersion: latest.catalogVersion, syncedHash: payloadHash(state.pending.items), syncedItems: state.pending.items, pending: null });
          return;
        }
        this.retireRejectedPublication(owner, deviceId, state, latest);
      }
      throw error;
    }
    if (!isCurrent()) throw new Error('Account changed');
    if (result.publicationId !== state.pending.publicationId || result.deviceId !== deviceId) throw new Error('Agent catalog ACK identity mismatch');
    this.store.put(key, { catalogVersion: result.catalogVersion, syncedHash: payloadHash(state.pending.items), syncedItems: state.pending.items, pending: null });
  }
}
