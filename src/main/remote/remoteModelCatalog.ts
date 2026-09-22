import { randomUUID } from 'crypto';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteInputReason, type RemoteModelItem } from '../../shared/remote/input';
import { payloadHash } from './canonical';
import type { RemoteStore } from './remoteStore';

export interface LocalRemoteModel {
  identity: string; runtimeRef: string; source: 'subscription' | 'custom'; displayName: string; providerLabel: string;
  available: boolean; unavailableReason?: RemoteModelItem['unavailableReason'];
  image: boolean; toolCalling: boolean; thinking: RemoteModelItem['thinking'];
  /** Never serialized into a public record. Includes credentials/routing to invalidate old selections. */
  configuration: unknown;
}
interface Binding { identity: string; modelRef: string; version: string; fingerprint: string; removed: boolean }
interface CatalogState { bindings: Binding[]; catalogVersion: string; pending?: { publicationId: string; expectedCatalogVersion: string; items: RemoteModelItem[] } }
export class RemoteInputError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
const label = (value: string, fallback: string): string => {
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return /(?:https?:\/\/|localhost|\b\d{1,3}(?:\.\d{1,3}){3}\b|sk-[A-Za-z0-9])/iu.test(text) ? fallback : (text || fallback).slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '');
};

/** Persistent opaque identity; deletion never reassigns an old reference to a new model. */
export class RemoteModelCatalog {
  private publicationContext = '';
  private checkedHash = '';
  private checkedAt = 0;
  private retryAt = 0;
  private publicationEpoch = 0;
  constructor(private readonly store: Pick<RemoteStore, 'get' | 'put'>, private readonly models: () => LocalRemoteModel[],
    private readonly getTargetId?: () => string | null) {}
  resetPublication(): void { this.publicationEpoch++; this.publicationContext = ''; this.checkedHash = ''; this.checkedAt = 0; this.retryAt = 0; }
  private targetId(): string | undefined {
    const targetId = this.getTargetId?.();
    if (this.getTargetId && !targetId) throw new RemoteInputError(RemoteInputReason.Stale);
    return targetId ?? undefined;
  }
  private key(owner: RemoteOwner, deviceId: string): string {
    return `inputModels:${JSON.stringify([...(this.getTargetId ? [this.targetId()] : []), owner.userId, owner.scopeKey, deviceId])}`;
  }
  private state(owner: RemoteOwner, deviceId: string): CatalogState { return this.store.get<CatalogState>(this.key(owner, deviceId)) || { bindings: [], catalogVersion: '0' }; }
  refresh(owner: RemoteOwner, deviceId: string): RemoteModelItem[] {
    const state = this.state(owner, deviceId);
    const models = this.models();
    const seen = new Set<string>();
    const items: RemoteModelItem[] = [];
    for (const model of models) {
      if (seen.has(model.identity)) throw new RemoteInputError(RemoteInputReason.ModelUnavailable);
      seen.add(model.identity);
      const fingerprint = payloadHash(model);
      let binding = state.bindings.find(value => value.identity === model.identity && !value.removed);
      if (!binding) { binding = { identity: model.identity, modelRef: randomUUID(), version: '1', fingerprint, removed: false }; state.bindings.push(binding); }
      else if (binding.fingerprint !== fingerprint) { binding.version = String(BigInt(binding.version) + 1n); binding.fingerprint = fingerprint; }
      items.push({ modelRef: binding.modelRef, version: binding.version, source: model.source,
        displayName: label(model.displayName, 'Model'), providerLabel: label(model.providerLabel, model.source),
        available: model.available, unavailableReason: model.available ? null : model.unavailableReason || RemoteInputReason.ModelUnavailable,
        inputCapabilities: { text: true, image: model.image, toolCalling: model.toolCalling },
        thinking: { options: [...model.thinking.options], default: model.thinking.default || null } });
    }
    for (const binding of state.bindings) if (!seen.has(binding.identity)) binding.removed = true;
    this.store.put(this.key(owner, deviceId), state);
    return items.sort((a, b) => a.modelRef.localeCompare(b.modelRef));
  }
  resolve(owner: RemoteOwner, deviceId: string, modelRef: string, version?: string): { item: RemoteModelItem; local: LocalRemoteModel } {
    const item = this.refresh(owner, deviceId).find(value => value.modelRef === modelRef);
    if (!item?.available) throw new RemoteInputError(RemoteInputReason.ModelUnavailable);
    if (version !== undefined && item.version !== version) throw new RemoteInputError(RemoteInputReason.ModelChanged);
    const binding = this.state(owner, deviceId).bindings.find(value => value.modelRef === modelRef && !value.removed)!;
    const local = this.models().find(value => value.identity === binding.identity);
    if (!local || payloadHash(local) !== binding.fingerprint) throw new RemoteInputError(RemoteInputReason.ModelChanged);
    return { item, local };
  }
  resolveRuntime(owner: RemoteOwner, deviceId: string, runtimeRef: string): { item: RemoteModelItem; local: LocalRemoteModel } {
    this.refresh(owner, deviceId);
    const local = this.models().find(value => value.runtimeRef === runtimeRef);
    const binding = local && this.state(owner, deviceId).bindings.find(value => value.identity === local.identity && !value.removed);
    if (!binding) throw new RemoteInputError(RemoteInputReason.ModelUnavailable);
    return this.resolve(owner, deviceId, binding.modelRef);
  }
  async publish(owner: RemoteOwner, deviceId: string, generation: string,
    api: (path: string, method?: string, body?: unknown) => Promise<any>, current: () => boolean): Promise<void> {
    const targetId = this.targetId();
    const isCurrent = () => current() && this.getTargetId?.() === targetId;
    if (!isCurrent()) throw new RemoteInputError(RemoteInputReason.Account);
    const items = this.refresh(owner, deviceId);
    if (items.length > 200 || Buffer.byteLength(JSON.stringify(items)) > 256 * 1024) throw new RemoteInputError(RemoteInputReason.Invalid);
    const context = JSON.stringify([targetId, owner, deviceId, generation]);
    if (this.publicationContext !== context) { this.resetPublication(); this.publicationContext = context; }
    const epoch = this.publicationEpoch;
    const digest = payloadHash(items);
    if (Date.now() < this.retryAt || this.checkedHash === digest && Date.now() - this.checkedAt < 300000) return;
    // Local configuration is checked frequently; unchanged catalogs only need a slow remote reconciliation.
    this.retryAt = Date.now() + 60000;
    const remote = await api(`/devices/${deviceId}/models`);
    if (!isCurrent() || epoch !== this.publicationEpoch) throw new RemoteInputError(RemoteInputReason.Account);
    const state = this.state(owner, deviceId);
    if (state.pending && (remote.lastPublicationId === state.pending.publicationId || remote.catalogVersion !== state.pending.expectedCatalogVersion)) delete state.pending;
    state.catalogVersion = remote.catalogVersion || '0';
    if (!state.pending && payloadHash(remote.items || []) === digest) {
      this.store.put(this.key(owner, deviceId), state);
      this.checkedHash = digest; this.checkedAt = Date.now(); this.retryAt = 0;
      return;
    }
    state.pending ||= { publicationId: randomUUID(), expectedCatalogVersion: state.catalogVersion, items };
    this.store.put(this.key(owner, deviceId), state);
    const publishedHash = payloadHash(state.pending.items);
    const result = await api(`/devices/${deviceId}/models/publish`, 'POST', { ...state.pending, connectionGeneration: generation });
    if (!isCurrent() || epoch !== this.publicationEpoch) throw new RemoteInputError(RemoteInputReason.Account);
    const latest = this.state(owner, deviceId);
    if (latest.pending?.publicationId !== state.pending.publicationId) return;
    latest.catalogVersion = result.catalogVersion; delete latest.pending; this.store.put(this.key(owner, deviceId), latest);
    this.checkedHash = publishedHash; this.checkedAt = Date.now(); this.retryAt = 0;
  }
}
