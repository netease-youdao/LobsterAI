import { randomUUID } from 'crypto';

import { type RemoteAgentSettingsAuthorization, type RemoteAgentSettingsBinding, type RemoteAgentSettingsPermissions,RemoteAgentSettingsSection, RemoteAgentSettingsStatus } from '../../shared/remote/agentSettings';
import type { RemoteOwner } from '../../shared/remote/constants';
import type { AgentSettingsAction, AgentSettingsContext, AgentSettingsPersistence } from '../libs/agentSettings/types';
import { payloadHash, sameOwner, stableJson } from './canonical';

export interface RemoteAgentSettingsConnection {
  owner: RemoteOwner; dataSpaceId: string; dataGeneration: string; deviceId: string;
  route: string; connectionGeneration: string | null; active: boolean;
}
export interface LocalSettingsBinding extends RemoteAgentSettingsBinding { identity: string; connection: RemoteAgentSettingsConnection }
export interface PendingSettingsAccess {
  requestId: string; identity: string; kind: 'authorize' | 'revoke'; connection: RemoteAgentSettingsConnection;
  accountEpoch: string; bindingId?: string; bindingVersion?: string; input?: RemoteAgentSettingsAuthorization;
}
interface AccessState { epoch: string; identity: string | null; bindings: LocalSettingsBinding[]; pending: PendingSettingsAccess[] }
const KEY = 'remote-agent-settings-access-v1';
const UINT = /^[1-9]\d{0,18}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
export function settingsIdentity(context: RemoteAgentSettingsConnection): string {
  return payloadHash([context.owner.userId, context.owner.scopeKey, context.dataSpaceId, context.dataGeneration, context.deviceId, context.route]);
}
export function settingsPermissions(value: unknown, conversationReady: boolean): RemoteAgentSettingsPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SETTINGS_INVALID_REQUEST');
  const record = value as Record<string, unknown>;
  const sections = Object.values(RemoteAgentSettingsSection);
  if (Object.keys(record).length !== sections.length || Object.keys(record).some(key => !sections.includes(key as RemoteAgentSettingsSection))) throw new Error('SETTINGS_INVALID_REQUEST');
  for (const section of sections) {
    const permission = record[section] as Record<string, unknown>;
    if (!permission || typeof permission !== 'object' || Array.isArray(permission)
      || Object.keys(permission).length !== 3 || ['read', 'directUpdate', 'conversationUpdate'].some(key => typeof permission[key] !== 'boolean')) throw new Error('SETTINGS_INVALID_REQUEST');
    const direct = section === RemoteAgentSettingsSection.Model || section === RemoteAgentSettingsSection.Collaboration;
    if ((permission.directUpdate || permission.conversationUpdate) && !permission.read || direct && permission.conversationUpdate
      || !direct && permission.directUpdate || permission.conversationUpdate && !conversationReady) throw new Error('DIRECT_EDIT_NOT_ALLOWED');
  }
  return structuredClone(value) as RemoteAgentSettingsPermissions;
}
/** Only bindings durably confirmed for this account and connection can admit work. */
export class RemoteAgentSettingsAccess {
  private state: AccessState;
  private blocked = false;
  constructor(private readonly store: AgentSettingsPersistence) {
    const saved = store.get<AccessState>(KEY);
    if (saved && (!UINT.test(saved.epoch) || !Array.isArray(saved.bindings) || !Array.isArray(saved.pending))) throw new Error('LOCAL_CLEANUP_REQUIRED');
    this.state = saved ?? { epoch: '1', identity: null, bindings: [], pending: [] };
    if (!saved) this.save();
  }
  private save(): void { try { this.store.set(KEY, this.state); } catch (error) { this.blocked = true; throw error; } }
  epoch(): string { return this.state.epoch; }
  activate(connection: RemoteAgentSettingsConnection): void {
    const identity = settingsIdentity(connection);
    if (identity === this.state.identity) return;
    if (this.state.identity) this.fence();
    this.state.identity = identity; this.save();
  }
  fence(): void {
    // Stop in-memory admission before attempting storage; an I/O failure cannot keep old authority alive.
    this.blocked = true;
    for (const binding of this.state.bindings) {
      if (binding.status === RemoteAgentSettingsStatus.Active) {
        binding.status = RemoteAgentSettingsStatus.Revoked;
        this.state.pending.push({ requestId: randomUUID(), identity: binding.identity, kind: 'revoke', connection: binding.connection,
          accountEpoch: binding.accountEpoch, bindingId: binding.bindingId, bindingVersion: binding.bindingVersion });
      }
    }
    // A pending binding must never be replayed after a local fence.
    this.state.pending = this.state.pending.filter(item => item.kind === 'revoke');
    this.state.epoch = (BigInt(this.state.epoch) + 1n).toString();
    this.save(); this.blocked = false;
  }
  bindings(connection: RemoteAgentSettingsConnection): LocalSettingsBinding[] {
    return structuredClone(this.state.bindings.filter(binding => binding.identity === settingsIdentity(connection)));
  }
  pending(connection: RemoteAgentSettingsConnection): PendingSettingsAccess[] {
    return structuredClone(this.state.pending.filter(item => item.identity === settingsIdentity(connection)));
  }
  authorize(connection: RemoteAgentSettingsConnection, input: RemoteAgentSettingsAuthorization, conversationReady: boolean): PendingSettingsAccess {
    this.current(connection);
    if (input.expectedAccountEpoch !== this.state.epoch || !ID.test(input.agentId) || !ID.test(input.mobileDeviceId)
      || !ID.test(input.grantId) || !UINT.test(input.grantVersion)) throw new Error('SETTINGS_ACCESS_STALE');
    const sections = settingsPermissions(input.sections, conversationReady);
    // Replacing access fences the old binding before the request is submitted.
    for (const binding of this.state.bindings) if (binding.identity === settingsIdentity(connection)
      && binding.agentId === input.agentId && binding.mobileDeviceId === input.mobileDeviceId) binding.status = RemoteAgentSettingsStatus.Revoked;
    const pending: PendingSettingsAccess = { requestId: randomUUID(), kind: 'authorize', identity: settingsIdentity(connection),
      connection: structuredClone(connection), accountEpoch: this.state.epoch, input: { ...input, sections } };
    this.state.pending.push(pending); this.save(); return structuredClone(pending);
  }
  discardPending(requestId: string): void {
    this.state.pending = this.state.pending.filter(item => item.requestId !== requestId); this.save();
  }
  reconcile(connection: RemoteAgentSettingsConnection, remote: RemoteAgentSettingsBinding[], complete = true): void {
    this.current(connection);
    const identity = settingsIdentity(connection);
    for (const local of this.state.bindings) {
      if (local.identity === identity && local.status === RemoteAgentSettingsStatus.Active
        && (complete || remote.some(value => value.mobileDeviceId === local.mobileDeviceId && value.agentId === local.agentId))
        && !remote.some(value => value.status === RemoteAgentSettingsStatus.Active && this.matches(local, value))) local.status = RemoteAgentSettingsStatus.Revoked;
    }
    for (const value of remote) {
      if (value.status !== RemoteAgentSettingsStatus.Active) continue;
      if (!ID.test(value.bindingId) || !UINT.test(value.bindingVersion) || !UINT.test(value.accountEpoch)) throw new Error('SETTINGS_INVALID_RESPONSE');
      if (this.state.bindings.some(local => local.identity === identity && local.status === RemoteAgentSettingsStatus.Active && this.matches(local, value))) continue;
      // A service-only binding can never grant access. Revoke it using the original epoch.
      if (!this.state.pending.some(item => item.kind === 'revoke' && item.bindingId === value.bindingId && item.bindingVersion === value.bindingVersion)) {
        this.state.pending.push({ requestId: randomUUID(), identity, connection: structuredClone(connection), kind: 'revoke',
          bindingId: value.bindingId, bindingVersion: value.bindingVersion, accountEpoch: value.accountEpoch });
      }
    }
    this.save();
  }
  confirm(pending: PendingSettingsAccess, value: { bindingId: string; bindingVersion: string }): void {
    if (!this.state.pending.some(item => item.requestId === pending.requestId)) throw new Error('SETTINGS_ACCESS_STALE');
    if (pending.kind === 'authorize') {
      if (pending.accountEpoch !== this.state.epoch || pending.identity !== this.state.identity || !pending.input
        || !ID.test(value.bindingId) || !UINT.test(value.bindingVersion)) throw new Error('SETTINGS_ACCESS_STALE');
      const input = pending.input;
      this.state.bindings = this.state.bindings.filter(binding => binding.identity !== pending.identity
        || binding.agentId !== input.agentId || binding.mobileDeviceId !== input.mobileDeviceId);
      this.state.bindings.push({ identity: pending.identity, connection: pending.connection, bindingId: value.bindingId, bindingVersion: value.bindingVersion,
        agentId: input.agentId, mobileDeviceId: input.mobileDeviceId, grantId: input.grantId, grantVersion: input.grantVersion,
        accountEpoch: pending.accountEpoch, sections: input.sections, status: RemoteAgentSettingsStatus.Active });
    }
    this.state.pending = this.state.pending.filter(item => item.requestId !== pending.requestId); this.save();
  }
  current(connection: RemoteAgentSettingsConnection, active = true): void {
    if (this.blocked || settingsIdentity(connection) !== this.state.identity || active && (!connection.active || !connection.connectionGeneration)) throw new Error('SETTINGS_ACCESS_STALE');
  }
  resolve(connection: RemoteAgentSettingsConnection, bindingId: string, bindingVersion: string, accountEpoch: string, agentId: string): LocalSettingsBinding {
    this.current(connection);
    const binding = this.state.bindings.find(item => item.identity === settingsIdentity(connection) && item.bindingId === bindingId
      && item.bindingVersion === bindingVersion && item.accountEpoch === accountEpoch && item.agentId === agentId
      && item.status === RemoteAgentSettingsStatus.Active && item.accountEpoch === this.state.epoch);
    if (!binding) throw new Error('SETTINGS_ACCESS_STALE');
    return structuredClone(binding);
  }
  assertAccess(connection: RemoteAgentSettingsConnection, context: AgentSettingsContext, section: RemoteAgentSettingsSection, action: AgentSettingsAction): void {
    if (!sameOwner(context.owner, connection.owner) || context.deviceId !== connection.deviceId || context.dataSpaceId !== connection.dataSpaceId
      || context.dataGeneration !== connection.dataGeneration || !context.bindingId || !context.bindingVersion) throw new Error('SETTINGS_ACCESS_STALE');
    const binding = this.resolve(connection, context.bindingId, context.bindingVersion, context.accountEpoch, context.agentId);
    if (!binding.sections[section]?.[action]) throw new Error('SETTINGS_ACCESS_DENIED');
  }
  matches(left: LocalSettingsBinding, right: RemoteAgentSettingsBinding): boolean {
    return ['bindingId', 'bindingVersion', 'mobileDeviceId', 'agentId', 'grantId', 'grantVersion', 'accountEpoch'].every(key =>
      left[key as keyof LocalSettingsBinding] === right[key as keyof RemoteAgentSettingsBinding]) && stableJson(left.sections) === stableJson(right.sections);
  }
}
