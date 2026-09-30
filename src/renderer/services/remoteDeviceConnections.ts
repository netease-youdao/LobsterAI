import {
  RemoteConnectionAction as ConnectionAction,
  type RemoteConnectionOperation,
  RemoteConnectionReasonCode,
  type RemoteConnectionsSnapshot,
  type RemoteDeviceConnection,
} from '../../shared/remote/connections';
import { type RemoteSettingsApi, type RemoteSettingsState } from '../../shared/remote/constants';
import { type RemoteSettingsService,remoteSettingsService } from './remoteSettings';

type ConnectionAction = typeof ConnectionAction[keyof typeof ConnectionAction];
type ManagementApi = Pick<RemoteSettingsApi, 'queryConnections' | 'removeConnection' | 'resumeCurrentConnection' | 'queryConnectionOperation'>;
interface PendingOperation {
  action: ConnectionAction;
  requestId: string;
  deviceId: string;
  expectedConnectionVersion: string;
  busy: boolean;
  unconfirmed: boolean;
  result?: RemoteConnectionOperation;
}
export interface DeviceConnectionsState {
  accountEpoch: string | null;
  data: RemoteConnectionsSnapshot | null;
  loading: boolean;
  error: string | null;
  operations: Record<string, PendingOperation>;
}

/** Page-scoped, account-fenced management reads. This store never enables remote access. */
export class RemoteDeviceConnectionsService {
  private snapshot: DeviceConnectionsState = { accountEpoch: null, data: null, loading: false, error: null, operations: {} };
  private listeners = new Set<() => void>();
  private generation = 0;
  private mutationRevision = 0;
  private identity = '';
  private localConnection = '';
  private enabled = false;
  private foreground = true;
  private consecutiveFailures = 0;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeSettings: (() => void) | undefined;

  constructor(
    private readonly getApi: () => ManagementApi = () => window.electron.remote,
    private readonly settings: Pick<RemoteSettingsService, 'getSnapshot' | 'subscribe' | 'refresh'> = remoteSettingsService,
    private readonly newRequestId: () => string = () => crypto.randomUUID(),
  ) {}

  getSnapshot = (): DeviceConnectionsState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.unsubscribeSettings = this.settings.subscribe(this.onSettings);
      if (typeof document !== 'undefined') {
        this.foreground = document.hasFocus?.() !== false;
        document.addEventListener('visibilitychange', this.onVisibility);
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', this.onWindowFocus);
        window.addEventListener('blur', this.onWindowBlur);
        window.addEventListener('online', this.onNetworkOnline);
      }
      this.onSettings();
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.generation++;
      this.inFlight = null;
      this.unsubscribeSettings?.();
      this.unsubscribeSettings = undefined;
      clearTimeout(this.timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', this.onWindowFocus);
        window.removeEventListener('blur', this.onWindowBlur);
        window.removeEventListener('online', this.onNetworkOnline);
      }
      this.update({ loading: false });
    };
  };

  private onSettings = (): void => {
    const state = this.settings.getSnapshot().state;
    const identity = state?.owner && state.accountEpoch
      ? JSON.stringify([state.accountEpoch, state.owner.userId, state.owner.scopeKey]) : '';
    const enabled = Boolean(identity && state?.deviceConnectionManagementSupported !== false);
    const localConnection = JSON.stringify([state?.deviceId, state?.connected, state?.connectionReason, state?.enabled]);
    const connectionChanged = this.localConnection !== localConnection;
    this.localConnection = localConnection;
    if (this.identity === identity && this.enabled === enabled) {
      if (connectionChanged && enabled && this.listeners.size) void this.refresh();
      return;
    }
    this.consecutiveFailures = 0;
    this.identity = identity;
    this.enabled = enabled;
    this.generation++;
    this.inFlight = null;
    clearTimeout(this.timer);
    this.update({ accountEpoch: state?.owner ? state.accountEpoch ?? null : null, data: null, loading: false, error: null, operations: {} });
    if (enabled && this.listeners.size) void this.refresh();
  };

  private onNetworkOnline = (): void => { void this.refresh(); };
  private onWindowFocus = (): void => { this.foreground = true; void this.refresh(); };
  private onWindowBlur = (): void => { this.foreground = false; this.schedule(); };

  private onVisibility = (): void => {
    clearTimeout(this.timer);
    if (document.visibilityState === 'visible') void this.refresh();
    else this.schedule();
  };

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.enabled || !this.listeners.size) return;
    const background = !this.foreground || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
    // Recover transient read failures promptly, then return to the normal bounded polling rate.
    const foregroundDelay = this.consecutiveFailures ? Math.min(15000, 3000 * 2 ** (this.consecutiveFailures - 1)) : 15000;
    this.timer = setTimeout(() => { void this.refresh(); }, (background ? 60000 : foregroundDelay) + Math.floor(Math.random() * 3000));
  }

  refresh = (): Promise<void> => {
    if (this.inFlight) return this.inFlight;
    const epoch = this.snapshot.accountEpoch;
    if (!this.enabled || !epoch || !this.listeners.size) return Promise.resolve();
    const generation = this.generation;
    const mutationRevision = this.mutationRevision;
    this.update({ loading: true });
    const request = (async () => {
      try {
        const data = await this.getApi().queryConnections({ expectedAccountEpoch: epoch });
        if (generation !== this.generation || mutationRevision !== this.mutationRevision) return;
        this.consecutiveFailures = data.supported && !data.presenceAvailable ? Math.min(this.consecutiveFailures + 1, 4) : 0;
        this.update({ data, error: null });
        // A response timeout is not evidence that a remove failed. Query its original receipt.
        for (const operation of Object.values(this.snapshot.operations)) {
          if (!operation.unconfirmed) continue;
          try {
            const result = await this.getApi().queryConnectionOperation({ expectedAccountEpoch: epoch, requestId: operation.requestId });
            if (generation !== this.generation) return;
            this.updateOperation(operation.deviceId, { ...operation, result, unconfirmed: false });
          } catch { /* Retain the original request ID for a later read or explicit retry. */ }
        }
      } catch {
        if (generation === this.generation) {
          this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 4);
          this.update({ error: 'remoteConnectionsUnavailable' });
        }
      } finally {
        if (generation === this.generation) {
          this.inFlight = null;
          this.update({ loading: false });
          this.schedule();
        }
      }
    })();
    this.inFlight = request;
    return request;
  };

  remove = (device: RemoteDeviceConnection, expectedAccountEpoch = this.snapshot.accountEpoch): Promise<boolean> => this.perform(ConnectionAction.Remove, device, expectedAccountEpoch);
  resume = (device: RemoteDeviceConnection, expectedAccountEpoch = this.snapshot.accountEpoch): Promise<boolean> => this.perform(ConnectionAction.Resume, device, expectedAccountEpoch);

  private async perform(action: ConnectionAction, device: RemoteDeviceConnection, expectedAccountEpoch: string | null): Promise<boolean> {
    const epoch = this.snapshot.accountEpoch;
    const state: RemoteSettingsState | null = this.settings.getSnapshot().state;
    if (!epoch || epoch !== expectedAccountEpoch || state?.accountEpoch !== epoch || !state.owner || !this.enabled || !this.snapshot.data?.supported) return false;
    const previous = this.snapshot.operations[device.deviceId];
    if (previous?.busy) return false;
    // An uncertain attempt is retried verbatim, even if the visible version has changed.
    const operation: PendingOperation = previous?.unconfirmed && previous.action === action ? { ...previous, busy: true }
      : { action, requestId: this.newRequestId(), deviceId: device.deviceId, expectedConnectionVersion: device.connectionVersion, busy: true, unconfirmed: false };
    const generation = this.generation;
    this.mutationRevision++;
    this.updateOperation(device.deviceId, operation);
    this.update({ error: null });
    const request = { expectedAccountEpoch: epoch, requestId: operation.requestId, expectedConnectionVersion: operation.expectedConnectionVersion };
    try {
      const result = action === ConnectionAction.Remove
        ? await this.getApi().removeConnection({ ...request, deviceId: device.deviceId })
        : await this.getApi().resumeCurrentConnection(request);
      if (generation !== this.generation) return false;
      this.mutationRevision++;
      this.updateOperation(device.deviceId, { ...operation, result, busy: false, unconfirmed: false });
      if (this.inFlight) await this.inFlight;
      await this.refresh();
      if (generation !== this.generation) return false;
      void this.settings.refresh();
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      try {
        const result = await this.getApi().queryConnectionOperation({ expectedAccountEpoch: epoch, requestId: operation.requestId });
        if (generation !== this.generation) return false;
        this.mutationRevision++;
        this.updateOperation(device.deviceId, { ...operation, result, busy: false, unconfirmed: false });
        if (this.inFlight) await this.inFlight;
        await this.refresh();
        if (generation !== this.generation) return false;
        void this.settings.refresh();
        return true;
      } catch {
        if (generation !== this.generation) return false;
        const conflict = error instanceof Error && (error.message.includes(RemoteConnectionReasonCode.VersionConflict) || error.message.includes('47120'));
        this.updateOperation(device.deviceId, { ...operation, busy: false, unconfirmed: !conflict });
        await this.refresh();
        if (generation === this.generation) this.update({ error: conflict ? 'remoteConnectionChanged' : 'remoteConnectionOperationUnconfirmed' });
        return false;
      }
    }
  }

  private updateOperation(deviceId: string, operation: PendingOperation): void {
    this.update({ operations: { ...this.snapshot.operations, [deviceId]: operation } });
  }
  private update(changes: Partial<DeviceConnectionsState>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}

export const remoteDeviceConnectionsService = new RemoteDeviceConnectionsService();
