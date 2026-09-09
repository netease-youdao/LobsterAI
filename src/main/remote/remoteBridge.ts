import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { resolve } from 'path';

import { REMOTE_PROTOCOL_VERSION, REMOTE_TEXT_BYTES, RemoteCapability, RemoteConnectionReason, type RemoteConnectionReasonValue, RemoteConnectionStatus, type RemoteOwner, type RemoteSettingsState, RemoteSyncStatus, type RemoteWorkspace } from '../../shared/remote/constants';
import { payloadHash, remoteError, sameOwner, stableJson } from './canonical';
import type { RemoteIdentity } from './installationIdentity';
import { type ProjectionRecord, RemoteStore, type SyncRow } from './remoteStore';

export interface RemoteCommand {
  commandId: string; type: string; sessionId?: string; runId?: string; status: string; statusVersion: string;
  expiresAt: string; request: any; requestHash: string; claimId?: string; claimToken?: string; claimUntil?: string;
}
export interface InboxEntry {
  command: RemoteCommand; owner: RemoteOwner; localSessionId: string | null; remoteSessionId: string | null;
  runId: string | null; state: 'prepared' | 'executing' | 'applied' | 'rejected' | 'unknown'; result: any;
}
interface Registration { deviceId: string; userId: string; scopeKey: string; metadataVersion: string }
interface LocalSettings { createSessionAvailable?: boolean; enabled: boolean; name: string; workspaces: Array<RemoteWorkspace & { path: string }>; settingsVersion: string }
interface ControlIntent { createSessionAvailable?: boolean; id: string; enabled: boolean; workspaces: RemoteWorkspace[] }
interface SavedImport { importId: string; sessionId: string; baseSourceSeq: string; snapshotEpoch: number; expectedSourceSeq: string; expectedServerSeq: string; beginConfirmed?: boolean; manifest: any; parts: any[]; stateVersion?: string }
export interface BridgeDependencies {
  store: RemoteStore; identity: RemoteIdentity;
  getDefaultWorkspace?(): { path: string; name: string; available?: boolean } | Promise<{ path: string; name: string; available?: boolean }>;
  onStateChange?(): void;
  getOwner(): RemoteOwner | null;
  getApiBaseUrl(): string;
  request(owner: RemoteOwner, pathname: string, init: RequestInit): Promise<Response>;
  metadata: { name: string; hostName: string; instanceLabel: string; platform: string; appVersion: string };
  prepare(command: RemoteCommand, owner: RemoteOwner, workspacePath: string | null): { localSessionId: string; remoteSessionId: string; runId: string | null };
  execute(entry: InboxEntry, stillPermitted: () => boolean): Promise<any>;
  onAccountChange(previous: RemoteOwner | null, current: RemoteOwner | null): void;
}
export class RemoteApiError extends Error {
  constructor(readonly code: number, message: string, readonly data: any = null, readonly httpStatus: number = 0) { super(message); }
}
const capabilities = ['session.read', RemoteCapability.CreateSession, 'session.continue', 'run.cancel', 'approval.respond'];
const SocketFailureCode = { Transport: 1006, Protocol: 1002, PayloadTooLarge: 1009, HeartbeatTimeout: 4408 } as const;
export class RemoteBridge {
  private owner: RemoteOwner | null = null;
  private registration: Registration | null = null;
  private registrationPending: Promise<void> | null = null;
  private socket: WebSocket | null = null;
  private generation: string | null = null;
  private stopped = false;
  private suspended = false;
  private running = false;
  private tickRequested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private handshake: ReturnType<typeof setTimeout> | null = null;
  private connectionAttempt = 0;
  private lastPong = 0;
  private heartbeatTimeout = 75000;
  private error: string | undefined;
  private errorCode: number | undefined;
  private connectionReason: RemoteConnectionReasonValue = RemoteConnectionReason.Connecting;
  private backoff = 5000;
  private accesses: RemoteSettingsState['accessRequests'] = [];
  private scheduledAt = 0;
  private settingsQueue: Promise<unknown> = Promise.resolve();
  private retryAfter = 0;
  private sameAccountAccess = false;
  private workspaceUnavailable = false;
  constructor(private readonly deps: BridgeDependencies) { deps.store.setWake(() => this.schedule(1000)); }
  start(): void { this.stopped = false; this.accountChanged(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.disconnect(); }
  accountChanged(): void { this.ensureAccount(); this.schedule(0); }
  private changed(): void { this.deps.onStateChange?.(); }
  private settingsKey(): string { return `settings:${this.owner?.userId}:${this.owner?.scopeKey}`; }
  private controlKey(): string { return `controlQueue:${this.owner?.userId}:${this.owner?.scopeKey}`; }
  private nameKey(): string { return `namePending:${this.owner?.userId}:${this.owner?.scopeKey}`; }
  private settings(): LocalSettings {
    const saved = this.owner ? this.deps.store.get<LocalSettings>(this.settingsKey()) : null;
    return { enabled: Boolean(this.owner), name: this.deps.metadata.hostName, workspaces: [], settingsVersion: '0', ...saved };
  }
  private controls(): ControlIntent[] { return this.deps.store.get<ControlIntent[]>(this.controlKey()) || []; }
  state(): RemoteSettingsState {
    const settings = this.settings();
    const connected = sameOwner(this.owner, this.deps.getOwner()) && settings.enabled && this.generation !== null && Date.now() - this.lastPong < this.heartbeatTimeout;
    const pendingSettings = this.controls().length > 0;
    const pendingName = !!this.deps.store.get(this.nameKey());
    return { enabled: settings.enabled, connected, deviceId: this.registration?.deviceId,
      name: settings.name, hostName: this.deps.metadata.hostName, owner: this.owner,
      connectionStatus: connected ? RemoteConnectionStatus.Online : RemoteConnectionStatus.Offline,
      connectionReason: !this.owner ? RemoteConnectionReason.SignedOut : !settings.enabled ? RemoteConnectionReason.Disabled : this.workspaceUnavailable && !this.error ? RemoteConnectionReason.WorkspaceUnavailable : this.connectionReason,
      settingsSyncStatus: pendingSettings ? RemoteSyncStatus.Pending : RemoteSyncStatus.Synced,
      nameSyncStatus: pendingName ? RemoteSyncStatus.Pending : RemoteSyncStatus.Synced,
      workspaces: settings.workspaces.map(({ path: _path, ...w }) => w), error: this.error, errorCode: this.errorCode, accessRequests: this.accesses };
  }
  async configure(changes: { enabled?: boolean; name?: string; workspace?: { name: string; path: string }; removeWorkspaceId?: string; retry?: boolean }): Promise<RemoteSettingsState> {
    this.ensureAccount();
    if (!this.owner) throw new Error('Sign in before enabling remote control');
    const settings = this.settings();
    const wasEnabled = settings.enabled;
    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name || name.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(changes.name)) throw new Error('Invalid device name');
      settings.name = name;
    }
    if (changes.enabled !== undefined) settings.enabled = changes.enabled;
    if (changes.workspace && !settings.workspaces.some(w => w.path === changes.workspace!.path)) settings.workspaces.push({ workspaceId: randomUUID(), ...changes.workspace, available: true });
    // Keep IDs as tombstones: accepted commands must never be redirected to a different path.
    if (changes.removeWorkspaceId) settings.workspaces = settings.workspaces.map(w => w.workspaceId === changes.removeWorkspaceId ? { ...w, available: false } : w);
    this.deps.store.transaction(() => {
      this.deps.store.put(this.settingsKey(), settings);
      if (changes.name !== undefined) this.deps.store.put(this.nameKey(), { id: randomUUID(), name: settings.name });
      if (changes.enabled !== undefined || changes.workspace || changes.removeWorkspaceId) this.queueControl(settings);
    });
    this.retryAfter = 0;
    if (changes.retry || changes.enabled === true && !wasEnabled) {
      this.suspended = false; this.backoff = 5000;
      this.error = undefined; this.errorCode = undefined;
      this.connectionReason = RemoteConnectionReason.Reconnecting;
      if (changes.retry) this.disconnect();
    }
    if (!settings.enabled) { this.deps.store.setEnabledOwner(null); this.disconnect(); }
    this.changed(); this.schedule(0);
    // A successful local save is independent of network availability. The durable queues retry in tick().
    return this.state();
  }
  async decide(requestId: string, decision: 'approve' | 'deny'): Promise<RemoteSettingsState> {
    const key = `decision:${requestId}`;
    const saved = this.deps.store.get<any>(key) || { decisionId: randomUUID(), decision };
    if (saved.decision !== decision) throw new Error('This access request already has a pending decision');
    this.deps.store.put(key, saved);
    await this.api(`/access-requests/${encodeURIComponent(requestId)}/decision`, 'POST', saved);
    this.deps.store.remove(key);
    await this.pollAccess(); this.changed();
    return this.state();
  }
  private ensureAccount(): void {
    const current = this.deps.getOwner();
    if ((current === null && this.owner === null) || sameOwner(current, this.owner)) return;
    const previous = this.owner;
    this.owner = current; this.registration = null; this.registrationPending = null;
    this.retryAfter = 0; this.suspended = false; this.accesses = [];
    this.sameAccountAccess = false; this.workspaceUnavailable = false; this.error = undefined; this.errorCode = undefined;
    this.connectionReason = RemoteConnectionReason.Connecting;
    this.deps.store.setEnabledOwner(null); this.disconnect();
    this.deps.onAccountChange(previous, current); this.changed();
  }
  private queueControl(settings: LocalSettings): void {
    const pending = this.controls();
    const value = { createSessionAvailable: settings.createSessionAvailable !== false, enabled: settings.enabled, workspaces: settings.workspaces.map(({ path: _path, ...w }) => w) };
    if (pending.length && stableJson({ createSessionAvailable: pending.at(-1)!.createSessionAvailable !== false, enabled: pending.at(-1)!.enabled, workspaces: pending.at(-1)!.workspaces }) === stableJson(value)) return;
    pending.push({ id: randomUUID(), ...value });
    this.deps.store.put(this.controlKey(), pending);
  }
  private async ensureDefaultWorkspace(): Promise<void> {
    if (!this.deps.getDefaultWorkspace) return;
    const owner = this.owner;
    const directory = await this.deps.getDefaultWorkspace();
    if (!sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner())) return;
    const settings = this.settings();
    const previous = stableJson(settings.workspaces);
    const couldCreate = settings.createSessionAvailable !== false;
    const normalized = resolve(directory.path);
    let workspace = settings.workspaces.find(w => resolve(w.path) === normalized);
    if (!workspace) {
      if (settings.workspaces.length >= 50) {
        this.workspaceUnavailable = true;
        if (couldCreate) {
          settings.createSessionAvailable = false;
          this.deps.store.transaction(() => { this.deps.store.put(this.settingsKey(), settings); this.queueControl(settings); });
        }
        return;
      }
      workspace = { workspaceId: randomUUID(), name: directory.name, path: normalized, available: true };
      settings.workspaces.push(workspace);
    }
    settings.createSessionAvailable = true;
    for (const item of settings.workspaces) {
      try { item.available = statSync(item.path).isDirectory(); } catch { item.available = false; }
    }
    if (directory.available === false) workspace.available = false;
    this.workspaceUnavailable = !workspace.available;
    workspace.name = directory.name;
    settings.workspaces = [workspace, ...settings.workspaces.filter(w => w !== workspace)];
    if (!couldCreate || stableJson(settings.workspaces) !== previous) this.deps.store.transaction(() => {
      this.deps.store.put(this.settingsKey(), settings); this.queueControl(settings);
    });
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.running && delay <= 1000) { this.tickRequested = true; return; }
    const due = Date.now() + delay;
    if (this.timer && this.scheduledAt <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.scheduledAt = due;
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, delay);
    this.timer.unref?.();
  }
  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.ensureAccount();
    const owner = this.owner;
    try {
      if (!owner || this.suspended) { this.backoff = 5000; return; }
      if (Date.now() < this.retryAfter) { this.backoff = this.retryAfter - Date.now(); return; }
      if (!this.settings().enabled && !this.controls().length && !this.deps.store.get(this.nameKey())) { this.backoff = 30000; return; }
      if (this.settings().enabled) {
        try { await this.ensureDefaultWorkspace(); }
        catch { this.workspaceUnavailable = true; }
      }
      await this.ensureRegistration();
      await this.writeSettings();
      if (!sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner())) return;
      if (!this.settings().enabled) { this.backoff = 30000; return; }
      if (!this.sameAccountAccess) throw new RemoteApiError(47000, 'Server upgrade required for same-account remote access');
      this.retryAfter = 0;
      this.deps.store.setEnabledOwner(this.owner);
      this.deps.store.expireApprovals();
      this.deps.store.transaction((): void => undefined);
      if (!this.socket) {
        try { await this.connect(); }
        catch (error) {
          if (error instanceof RemoteApiError && ![47022, 47011].includes(error.code)) throw error;
          this.recordConnectionFailure(error);
        }
      }
      await this.reconcile();
      await this.syncSessions();
      if (this.generation) await this.claim();
      this.backoff = this.deps.store.entries<InboxEntry>('inbox:').some(row => ['prepared', 'executing', 'unknown'].includes(row.value.state))
        || this.deps.store.sessions(this.owner!).some(row => { const run = this.deps.store.run(row.local_id); return run && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status); }) ? 5000 : 30000;
    } catch (error) {
      if (!sameOwner(owner, this.deps.getOwner()) || !sameOwner(owner, this.owner)) return;
      this.recordConnectionFailure(error);
      if (this.suspended) this.disconnect();
      if (error instanceof RemoteApiError && [404, 47000].includes(error.code)) {
        this.retryAfter = Date.now() + 60000; this.backoff = 60000;
        if (!this.sameAccountAccess) this.registration = null;
      } else this.backoff = Math.min(60000, this.backoff * 2);
    } finally {
      this.running = false; this.changed();
      const accountChanged = owner === null ? this.owner !== null : !sameOwner(owner, this.owner);
      const immediate = accountChanged || this.tickRequested; this.tickRequested = false;
      this.schedule(immediate ? 0 : this.backoff + Math.floor(Math.random() * 1000));
    }
  }
  private recordConnectionFailure(error: unknown): void {
    this.errorCode = error instanceof RemoteApiError ? error.code : undefined;
    this.error = error instanceof RemoteApiError ? `${error.code}: ${error.message}` : 'Remote connection is temporarily unavailable';
    if (this.connectionReason !== RemoteConnectionReason.ServerUpgradeRequired) this.connectionReason = RemoteConnectionReason.ServerUnavailable;
    if (error instanceof RemoteApiError && [47013, 47023].includes(error.code)) {
      this.suspended = true; this.connectionReason = RemoteConnectionReason.DeviceUnavailable;
    }
  }
  private failSocket(code: number, message: string): void {
    this.recordConnectionFailure(new RemoteApiError(code, message));
    this.disconnect(); this.schedule(this.backoff);
  }
  private async api(pathname: string, method = 'GET', body?: unknown, registrationRequired = true): Promise<any> {
    const owner = this.owner;
    if (!owner || !sameOwner(owner, this.deps.getOwner())) throw new Error('Account changed');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (registrationRequired) {
      if (!this.registration) throw new Error('Device is not registered');
      headers['X-Remote-Device-Credential'] = `${this.registration.deviceId}.${this.deps.identity.deviceKey}`;
    }
    const response = await this.deps.request(owner, `/api/remote/v1${pathname}`, { method, headers, body: body === undefined ? undefined : stableJson(body), signal: AbortSignal.timeout(20000) });
    if (!sameOwner(owner, this.deps.getOwner()) || !sameOwner(owner, this.owner)) throw new Error('Account changed during remote request');
    const text = await response.text();
    if (!sameOwner(owner, this.deps.getOwner()) || !sameOwner(owner, this.owner)) throw new Error('Account changed during remote response');
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Remote response is too large');
    let result: any;
    try { result = JSON.parse(text); } catch { throw new RemoteApiError(response.status, 'Invalid remote response'); }
    if (!response.ok || result.code !== 0) throw new RemoteApiError(result.code || response.status, result.message || 'Remote request failed', result.data, response.status);
    return result.data;
  }
  private advertisedCapabilities(createSessionAvailable = true): string[] {
    const supported = createSessionAvailable && this.settings().createSessionAvailable !== false ? capabilities : capabilities.filter(value => value !== RemoteCapability.CreateSession);
    return this.sameAccountAccess ? [...supported, RemoteCapability.SameAccountAccess] : supported;
  }
  private async ensureRegistration(): Promise<void> {
    if (this.registration) return;
    if (this.registrationPending) return this.registrationPending;
    const pending = this.register(); this.registrationPending = pending;
    try { await pending; } finally { if (this.registrationPending === pending) this.registrationPending = null; }
  }
  private async register(): Promise<void> {
    const support = await this.api('/capabilities', 'GET', undefined, false);
    if (!support.enabled || !support.protocolVersions?.includes(REMOTE_PROTOCOL_VERSION)) throw new RemoteApiError(47000, 'Remote control is unavailable');
    this.sameAccountAccess = support.capabilities?.includes(RemoteCapability.SameAccountAccess) === true;
    if (!this.sameAccountAccess) {
      this.connectionReason = RemoteConnectionReason.ServerUpgradeRequired;
      // Legacy servers still receive a saved disable; never announce an unsupported capability to them.
      if (!this.controls().some(intent => !intent.enabled)) throw new RemoteApiError(47000, 'Server upgrade required for same-account remote access');
    }
    const result: Registration = await this.api('/devices/register', 'POST', { ...this.deps.metadata, name: this.settings().name,
      installationId: this.deps.identity.installationId, deviceKey: this.deps.identity.deviceKey,
      kind: 'desktop', protocolVersion: REMOTE_PROTOCOL_VERSION, capabilities: this.advertisedCapabilities() }, false);
    if (!sameOwner(this.owner, result)) throw new Error('Registration owner does not match the authenticated account');
    this.registration = result;
    if (this.sameAccountAccess) this.connectionReason = RemoteConnectionReason.Connecting;
    if (!this.controls().length) this.queueControl(this.settings());
    this.changed();
  }
  private async writeSettings(): Promise<void> {
    const owner = this.owner;
    const pending = this.settingsQueue.catch((): void => undefined).then(async () => {
      if (!sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner())) return;
      await this.performWriteSettings();
      if (sameOwner(owner, this.owner) && sameOwner(owner, this.deps.getOwner())) await this.writeName();
    });
    this.settingsQueue = pending;
    await pending;
  }
  private async performWriteSettings(): Promise<void> {
    if (!this.registration) return;
    const owner = this.owner;
    const path = `/devices/${this.registration.deviceId}/settings`;
    const key = this.controlKey();
    while (sameOwner(owner, this.owner) && sameOwner(owner, this.deps.getOwner())) {
      const next = this.controls()[0];
      if (!next) break;
      if (!this.sameAccountAccess && next.enabled) {
        if (this.controls().some(intent => !intent.enabled)) { this.deps.store.put(key, this.controls().slice(1)); continue; }
        throw new RemoteApiError(47000, 'Server upgrade required for same-account remote access');
      }
      const server = await this.api(path);
      const result = await this.api(path, 'PATCH', { expectedSettingsVersion: server.settingsVersion,
        remoteEnabled: next.enabled, protocolVersion: REMOTE_PROTOCOL_VERSION, capabilities: this.advertisedCapabilities(next.createSessionAvailable !== false), workspaces: next.workspaces });
      const latest = this.settings(); latest.settingsVersion = result.settingsVersion;
      this.deps.store.transaction(() => {
        this.deps.store.put(this.settingsKey(), latest);
        this.deps.store.put(key, this.controls().filter(intent => intent.id !== next.id));
      });
      if (!this.error) this.connectionReason = RemoteConnectionReason.Reconnecting;
      this.disconnect(); this.changed();
    }
  }
  private async writeName(): Promise<void> {
    if (!this.registration) return;
    const key = this.nameKey();
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = this.deps.store.get<{ id: string; name: string }>(key);
      if (!pending) return;
      try {
        const metadata = await this.api(`/devices/${this.registration.deviceId}/metadata`, 'PATCH', {
          name: pending.name, expectedMetadataVersion: this.registration.metadataVersion,
        });
        this.registration.metadataVersion = metadata.metadataVersion;
        if (this.deps.store.get<{ id: string }>(key)?.id === pending.id) this.deps.store.remove(key);
        this.changed();
      } catch (error) {
        if (!(error instanceof RemoteApiError) || error.code !== 47020 || !error.data?.currentMetadataVersion || attempt === 2) throw error;
        this.registration.metadataVersion = String(error.data.currentMetadataVersion);
      }
    }
  }
  private async connect(): Promise<void> {
    const attempt = ++this.connectionAttempt;
    const owner = this.owner;
    let ticket: any;
    try { ticket = await this.api('/connection-tickets', 'POST', { protocolVersion: REMOTE_PROTOCOL_VERSION }); }
    catch (error) { if (attempt !== this.connectionAttempt) return; throw error; }
    if (attempt !== this.connectionAttempt || this.stopped || !sameOwner(owner, this.owner) || !sameOwner(owner, this.deps.getOwner()) || !this.settings().enabled) return;
    const url = new URL(ticket.wsUrl);
    const apiBase = new URL(this.deps.getApiBaseUrl());
    if (url.protocol !== 'wss:' || url.host !== apiBase.host || !url.pathname.startsWith('/api/remote/v1/')) throw new Error('Remote ticket URL origin is not trusted');
    const socket = new WebSocket(url.toString());
    this.handshake = setTimeout(() => { if (this.socket === socket && !this.generation) this.failSocket(SocketFailureCode.Transport, 'Remote WebSocket handshake timed out'); }, 15000);
    this.handshake.unref?.();
    this.socket = socket; this.changed();
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      if (!sameOwner(owner, this.deps.getOwner()) || !sameOwner(owner, this.owner)) { this.accountChanged(); return; }
      const data = String(event.data);
      if (Buffer.byteLength(data) > 65536) { this.failSocket(SocketFailureCode.PayloadTooLarge, 'Remote WebSocket frame is too large'); return; }
      try {
        const frame = JSON.parse(data);
        if (frame.type === 'hello') {
          if (frame.protocolVersion !== REMOTE_PROTOCOL_VERSION || !/^[1-9]\d*$/u.test(String(frame.connectionGeneration))) throw new Error('Invalid remote handshake');
          if (this.handshake) clearTimeout(this.handshake); this.handshake = null;
          this.generation = String(frame.connectionGeneration); this.lastPong = Date.now();
          this.heartbeatTimeout = Math.min(90000, Math.max(20000, (Number(frame.heartbeatTimeoutSeconds) || 75) * 1000));
          this.error = undefined; this.errorCode = undefined;
          this.connectionReason = RemoteConnectionReason.Connecting;
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastPong >= this.heartbeatTimeout) { this.failSocket(SocketFailureCode.HeartbeatTimeout, 'Remote WebSocket heartbeat timed out'); return; }
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', id: randomUUID() }));
          }, Math.max(10000, Math.min(30000, (Number(frame.heartbeatIntervalSeconds) || 25) * 1000)));
          this.heartbeat.unref?.(); this.changed(); this.schedule(0);
        } else if (frame.type === 'pong' && this.generation) {
          const wasConnected = this.state().connected;
          this.lastPong = Date.now();
          if (!wasConnected && this.state().connected) this.changed();
        }
        else if (frame.type === 'reconnect.required' || frame.type === 'access.changed') {
          if (!this.error) this.connectionReason = RemoteConnectionReason.Reconnecting;
          this.disconnect(); this.schedule(0);
        }
        else if (frame.type === 'commands.available' || frame.type === 'access.requested') this.schedule(0);
      } catch { this.failSocket(SocketFailureCode.Protocol, 'Invalid remote WebSocket message'); }
    });
    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      const restarting = this.generation !== null && [1000, 1001, 1012].includes(event.code);
      if (!restarting) this.recordConnectionFailure(new RemoteApiError(event.code, `Remote connection closed (${event.code})`));
      else if (!this.error) this.connectionReason = RemoteConnectionReason.Reconnecting;
      if ([4403, 4409, 4410].includes(event.code)) { this.suspended = true; this.error = `Remote connection closed (${event.code})`; this.errorCode = event.code; this.connectionReason = RemoteConnectionReason.DeviceUnavailable; }
      this.disconnect();
      this.changed(); this.schedule(this.backoff);
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.failSocket(SocketFailureCode.Transport, 'Remote WebSocket connection failed');
    });
  }
  private disconnect(): void {
    this.connectionAttempt++;
    const socket = this.socket; this.socket = null; this.generation = null; this.lastPong = 0;
    if (this.handshake) clearTimeout(this.handshake); this.handshake = null;
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
    if (socket) socket.close();
    this.changed();
  }
  private transport(): Record<string, string> {
    return this.generation ? { mode: 'online', connectionGeneration: this.generation } : { mode: 'recovery' };
  }
  private async pollAccess(): Promise<void> {
    const items: RemoteSettingsState['accessRequests'] = [];
    let cursor: string | null = null;
    do {
      const result = await this.api(`/devices/${this.registration!.deviceId}/access-requests?status=pending&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      items.push(...(result.items || [])); cursor = result.nextCursor || null;
    } while (cursor);
    this.accesses = items;
  }
  private async syncSessions(): Promise<void> {
    if (!this.owner || !this.registration) return;
    for (const row of this.deps.store.sessions(this.owner)) {
      const failure = this.deps.store.get<any>(`syncFailure:${row.local_id}`);
      if (failure?.retryAt > Date.now()) continue;
      try {
      if (!this.generation && !row.device_id) continue;
      if (row.device_id && row.device_id !== this.registration.deviceId) continue;
      if (!row.device_id) this.deps.store.bindRemote(row.local_id, row.session_id, this.registration.deviceId);
      const savedImport = this.deps.store.get<SavedImport>(`import:${row.local_id}`);
      if (row.needs_snapshot || savedImport) { await this.importSession(this.deps.store.sync(row.local_id)!, savedImport); continue; }
      const events = this.deps.store.pending(row.local_id);
      if (!events.length) continue;
      const batchId = payloadHash(events);
      const result = await this.api('/sync/batches', 'POST', { batchId, deviceId: this.registration.deviceId,
        ...this.transport(), owner: this.owner, sessionId: row.session_id, localSessionId: row.local_id, events });
      if (result.batchId !== batchId || result.deviceId !== this.registration.deviceId || result.sessionId !== row.session_id) throw new Error('Remote batch ACK identity mismatch');
      this.deps.store.acknowledge(row.local_id, result.deviceId, result.sessionId, result.committedSourceSeq, result.committedSeq);
      this.deps.store.remove(`syncFailure:${row.local_id}`);
      } catch (error) {
        if (this.isGlobalError(error)) throw error;
        this.deps.store.put(`syncFailure:${row.local_id}`, { code: error instanceof RemoteApiError ? error.code : 47019, retryAt: Date.now() + 30000 });
        this.error = 'Some conversations need synchronization recovery';
      }
    }
  }
  private async importSession(row: SyncRow, saved: SavedImport | null): Promise<void> {
    const key = `import:${row.local_id}`;
    const deleted = this.deps.store.db.prepare('SELECT id FROM cowork_sessions WHERE id=?').get(row.local_id) === undefined;
    if (deleted && saved && !saved.manifest.recordCounts['session.deleted']) {
      try {
        const previous = await this.api(`/sync/imports/${saved.importId}`);
        if (previous.state === 'committed') this.deps.store.acknowledge(row.local_id, this.registration!.deviceId, saved.sessionId, previous.committedSourceSeq, previous.committedSeq, true, saved.snapshotEpoch);
        else if (previous.state === 'uploading') await this.api(`/sync/imports/${saved.importId}/abort`, 'POST', { ...this.transport(), expectedStateVersion: previous.stateVersion, reason: 'session_deleted' });
      } catch (error) { if (!(error instanceof RemoteApiError) || error.httpStatus !== 404 || saved.beginConfirmed) throw error; }
      this.deps.store.remove(key); this.deps.store.requireSnapshot(row.local_id); saved = null; row = this.deps.store.sync(row.local_id)!;
    }
    if (!saved) {
      const snapshot = this.deps.store.snapshot(row.local_id);
      const groups: ProjectionRecord[][] = [[]];
      for (const record of snapshot.records) {
        const group = groups[groups.length - 1];
        if (group.length && Buffer.byteLength(stableJson({ records: [...group, record] })) > 600 * 1024) groups.push([record]);
        else group.push(record);
      }
      const parts = groups.map((records, partNo) => {
        const payload = { records };
        return { partNo, payload, payloadHash: payloadHash(payload), byteSize: Buffer.byteLength(stableJson(payload)) };
      });
      const recordCounts: Record<string, number> = {};
      for (const record of snapshot.records) recordCounts[record.eventType] = (recordCounts[record.eventType] || 0) + 1;
      saved = { importId: randomUUID(), sessionId: row.session_id, baseSourceSeq: snapshot.baseSourceSeq, snapshotEpoch: snapshot.snapshotEpoch, expectedSourceSeq: String(row.ack_seq), expectedServerSeq: row.server_seq, parts,
        manifest: { partCount: parts.length, recordCounts, manifestHash: payloadHash(parts.map(({ partNo, payloadHash: hash, byteSize }) => ({ partNo, payloadHash: hash, byteSize }))) } };
      this.deps.store.put(key, saved);
    }
    let begun: any;
    try {
      begun = await this.api('/sync/imports', 'POST', { importId: saved.importId, deviceId: this.registration!.deviceId,
        owner: this.owner, localSessionId: row.local_id, sessionId: saved.sessionId, baseSourceSeq: saved.baseSourceSeq,
        expectedSourceSeq: saved.expectedSourceSeq, expectedServerSeq: saved.expectedServerSeq, manifest: saved.manifest, ...this.transport() });
    } catch (error) {
      if (error instanceof RemoteApiError && error.code === 47025 && !saved.beginConfirmed
        && !error.data?.currentImport && !error.data?.activeImportId && typeof error.data?.currentSourceSeq === 'string' && /^\d+$/.test(error.data.currentSourceSeq)
        && typeof error.data?.currentServerSeq === 'string' && /^\d+$/.test(error.data.currentServerSeq)) {
        const source = BigInt(error.data.currentSourceSeq); const server = BigInt(error.data.currentServerSeq);
        if (source >= BigInt(saved.expectedSourceSeq) && source <= BigInt(saved.baseSourceSeq)
          && source <= BigInt(this.deps.store.sync(row.local_id)!.source_seq) && server >= BigInt(saved.expectedServerSeq)) {
          // The server proves no import was allocated. Rebase only the unsent snapshot expectation;
          // outbox and acknowledged positions stay untouched until the actual import commits.
          saved.expectedSourceSeq = source.toString(); saved.expectedServerSeq = server.toString();
          this.deps.store.put(key, saved); return;
        }
      }
      throw error;
    }
    saved.beginConfirmed = true; this.deps.store.put(key, saved);
    if (begun.state === 'aborted' || begun.state === 'expired') { this.deps.store.remove(key); this.deps.store.requireSnapshot(row.local_id); return; }
    if (begun.sessionId !== saved.sessionId) throw new Error('Import changed the fixed remote session mapping');
    let result = begun;
    if (begun.state !== 'committed') {
      for (const part of saved.parts) await this.api(`/sync/imports/${saved.importId}/parts/${part.partNo}`, 'PUT', {
        ...this.transport(), payloadHash: part.payloadHash, payload: part.payload });
      result = await this.api(`/sync/imports/${saved.importId}/commit`, 'POST', { ...this.transport(), expectedStateVersion: begun.stateVersion, manifestHash: saved.manifest.manifestHash });
    }
    this.deps.store.transaction(() => {
      this.deps.store.acknowledge(row.local_id, this.registration!.deviceId, saved!.sessionId, result.committedSourceSeq, result.committedSeq, true, saved!.snapshotEpoch);
      this.deps.store.remove(key);
    });
  }
  private isGlobalError(error: unknown): boolean {
    return !(error instanceof RemoteApiError) || [401, 403, 47000, 47013, 47023].includes(error.code) || error.code >= 500 && error.code < 600;
  }
  private async reportCommandError(entry: InboxEntry, error: unknown): Promise<void> {
    if (this.isGlobalError(error)) throw error;
    const current = (error as RemoteApiError).data?.currentCommand;
    if (current && BigInt(current.statusVersion) >= BigInt(entry.command.statusVersion)) {
      entry.command = { ...entry.command, ...current };
      if (['applied', 'rejected', 'expired'].includes(current.status)) entry.state = current.status === 'applied' ? 'applied' : 'rejected';
      this.deps.store.put(`inbox:${entry.command.commandId}`, entry);
    }
    this.deps.store.put(`commandFailure:${entry.command.commandId}`, { code: (error as RemoteApiError).code });
  }
  private async claim(): Promise<void> {
    const generation = this.generation;
    if (!generation) return;
    const result = await this.api(`/devices/${this.registration!.deviceId}/commands/claim`, 'POST', { connectionGeneration: generation, limit: 10 });
    for (const envelope of (Array.isArray(result) ? result : result.items || [])) {
      const command: RemoteCommand = { ...envelope.command, ...envelope };
      delete (command as any).command;
      const existing = this.deps.store.get<InboxEntry>(`inbox:${command.commandId}`);
      if (existing) continue; // Only reconcile may decide whether an existing command can execute.
      let entry: InboxEntry;
      try {
        const request = command.request;
        if (!request || request.commandId !== command.commandId || request.type !== command.type || payloadHash(request) !== command.requestHash) throw new Error('Invalid claimed command');
        const text = request.payload?.text;
        if (['create_session', 'send_message'].includes(command.type) && (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > REMOTE_TEXT_BYTES)) throw new Error('Invalid remote text');
        const workspace = this.settings().workspaces.find(w => w.available && (!request.payload?.workspaceId || w.workspaceId === request.payload.workspaceId));
        if (command.type === 'create_session' && !workspace) throw new Error('Workspace unavailable');
        entry = this.deps.store.transaction(() => {
          const prepared = this.deps.prepare(command, this.owner!, workspace?.path || null);
          this.deps.store.bindRemote(prepared.localSessionId, prepared.remoteSessionId, this.registration!.deviceId);
          const value: InboxEntry = { command, owner: this.owner!, ...prepared, state: 'prepared', result: null };
          this.deps.store.put(`inbox:${command.commandId}`, value);
          return value;
        });
      } catch (error) {
        entry = { command, owner: this.owner!, localSessionId: null, remoteSessionId: command.sessionId || null,
          runId: command.runId || null, state: 'rejected', result: remoteError(47019, 'COMMAND_INVALID', error instanceof Error ? error.message : 'Invalid command') };
        this.deps.store.put(`inbox:${command.commandId}`, entry);
      }
      try { await this.applyEntry(entry, generation); } catch (error) { await this.reportCommandError(entry, error); }
    }
  }
  private async ack(entry: InboxEntry, status: string): Promise<any> {
    return this.api(`/commands/${entry.command.commandId}/ack`, 'POST', { ...this.transport(),
      claimId: entry.command.claimId, claimToken: entry.command.claimToken, expectedStatusVersion: entry.command.statusVersion,
      status, sessionId: entry.remoteSessionId, runId: entry.runId,
      result: status === 'applied' ? entry.result : null, error: status === 'rejected' ? entry.result : null });
  }
  private async applyEntry(entry: InboxEntry, generation: string): Promise<void> {
    if (entry.state === 'rejected') { const result = await this.ack(entry, 'rejected'); entry.command = { ...entry.command, ...result }; this.deps.store.put(`inbox:${entry.command.commandId}`, entry); return; }
    const receipt = await this.ack(entry, 'received');
    entry.command = { ...entry.command, ...receipt };
    if (receipt.status !== 'received') {
      entry.state = receipt.status === 'applied' ? 'applied' : ['rejected', 'expired'].includes(receipt.status) ? 'rejected' : 'unknown';
      entry.result = receipt.result || receipt.error || null;
      this.deps.store.put(`inbox:${entry.command.commandId}`, entry); return;
    }
    this.deps.store.put(`inbox:${entry.command.commandId}`, entry);
    if (this.generation !== generation || !sameOwner(entry.owner, this.deps.getOwner())
      || Date.now() + 1000 >= Date.parse(entry.command.claimUntil || '') || Date.now() >= Date.parse(entry.command.expiresAt)) return;
    // COMMIT before invoking any runner. A crash from this point is unknown, never auto-replayed.
    entry.state = 'executing'; this.deps.store.put(`inbox:${entry.command.commandId}`, entry);
    try { entry.result = await this.deps.execute(entry, () => this.generation === generation
      && sameOwner(entry.owner, this.deps.getOwner()) && this.settings().enabled
      && Date.now() + 250 < Date.parse(entry.command.claimUntil || '') && Date.now() < Date.parse(entry.command.expiresAt)); entry.state = 'applied'; }
    catch { entry.state = 'unknown'; entry.result = null; }
    this.deps.store.put(`inbox:${entry.command.commandId}`, entry);
    if (entry.state === 'applied') { const result = await this.ack(entry, 'applied'); entry.command = { ...entry.command, ...result }; this.deps.store.put(`inbox:${entry.command.commandId}`, entry); }
  }
  private async reconcile(): Promise<void> {
    let cursor: string | null = null;
    do {
      const result = await this.api(`/devices/${this.registration!.deviceId}/commands?state=unresolved&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const envelope of result.items || []) {
        const command: RemoteCommand = { ...envelope.command, ...envelope };
        delete (command as any).command;
        let entry = this.deps.store.get<InboxEntry>(`inbox:${command.commandId}`);
        if (entry && !sameOwner(entry.owner, this.owner)) continue;
        if (!entry && envelope.currentClaimId && this.deps.store.hasCompleteExecutionHistory()
          && payloadHash(command.request) === command.requestHash
          && !this.deps.store.entries<any>('run:').some(row => row.value.runId === command.runId)) {
          const workspace = this.settings().workspaces.find(w => w.available && (!command.request.payload?.workspaceId || w.workspaceId === command.request.payload.workspaceId));
          try {
            entry = this.deps.store.transaction(() => {
              const prepared = this.deps.prepare(command, this.owner!, workspace?.path || null);
              this.deps.store.bindRemote(prepared.localSessionId, prepared.remoteSessionId, this.registration!.deviceId);
              const value: InboxEntry = { owner: this.owner!, command: { ...command, claimId: envelope.currentClaimId }, ...prepared, state: 'prepared', result: null };
              this.deps.store.put(`inbox:${command.commandId}`, value); return value;
            });
          } catch { /* No trustworthy pre-execution reconstruction; report unknown below. */ }
        }
        if (!entry) {
          if (command.status !== 'accepted') await this.api(`/commands/${command.commandId}/reconcile`, 'POST', {
            ...this.transport(), expectedStatusVersion: command.statusVersion, sessionId: command.sessionId || null,
            runId: command.runId || null, observedExecution: 'unknown', result: null, error: null, requestExecutionPermit: false,
          });
          continue;
        }
        try {
        const observedExecution = entry.state === 'applied' ? 'applied' : entry.state === 'rejected' ? 'not_applied'
          : entry.state === 'prepared' && this.deps.store.hasCompleteExecutionHistory()
            && (!entry.runId || this.deps.store.get<boolean>(`runPublished:${entry.runId}`) !== true) ? 'not_started' : 'unknown';
        const reconciled = await this.api(`/commands/${command.commandId}/reconcile`, 'POST', { ...this.transport(),
          expectedStatusVersion: command.statusVersion, claimId: entry.command.claimId, ...(entry.command.claimToken ? { claimToken: entry.command.claimToken } : {}),
          sessionId: entry.remoteSessionId, runId: entry.runId, observedExecution, result: entry.state === 'applied' ? entry.result : null,
          error: entry.state === 'rejected' ? entry.result : null,
          localEvidence: observedExecution === 'not_started' ? { databaseHealthy: this.deps.store.hasCompleteExecutionHistory(), historyComplete: this.deps.store.hasCompleteExecutionHistory(), inboxPersisted: true, executionNeverStarted: true } : null, requestExecutionPermit: observedExecution === 'not_started' && !!this.generation });
        entry.command = { ...entry.command, ...reconciled.command };
        if (reconciled.executionPermit) entry.command = { ...entry.command, ...reconciled.executionPermit };
        this.deps.store.put(`inbox:${command.commandId}`, entry);
        if (reconciled.executionPermit && this.generation) await this.applyEntry(entry, this.generation);
        } catch (error) { await this.reportCommandError(entry, error); }
      }
      cursor = result.nextCursor || null;
    } while (cursor);
  }
}
