import {
  RemoteConnectionAction, type RemoteConnectionOperation, RemoteConnectionReleaseState, type RemoteConnectionRemoveRequest,
  type RemoteConnectionResumeRequest, type RemoteConnectionsSnapshot, type RemoteDeviceConnection,
} from '../../shared/remote/connections';

interface ConnectionClientDependencies {
  guard(): () => void;
  ensure(): Promise<boolean>;
  request(path: string, method?: string, body?: unknown): Promise<any>;
  deviceId(): string | undefined;
  observe(value: Pick<RemoteDeviceConnection, 'deviceId' | 'connectionState' | 'connectionVersion'> & Partial<RemoteDeviceConnection>): void;
  retry(): void;
}
const validVersion = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,18}$/u.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);

/** HTTP management deliberately does not require an online socket or enabled preference. */
export class RemoteConnectionClient {
  private readonly completedOperations = new Set<string>();
  constructor(private readonly deps: ConnectionClientDependencies) {}
  reset(): void { this.completedOperations.clear(); }

  async query(): Promise<RemoteConnectionsSnapshot> {
    const assertCurrent = this.deps.guard();
    const supported = await this.deps.ensure(); assertCurrent();
    if (!supported) return { supported: false, observedAt: new Date().toISOString(), presenceAvailable: false,
      quota: { maxOnlineDesktops: 5, onlineSlotsUsed: null, scope: 'account_scope' }, currentDevice: null, connections: [] };
    const result: RemoteConnectionsSnapshot = await this.deps.request('/device-connections');
    assertCurrent();
    if (!result || !Array.isArray(result.connections) || !result.quota || typeof result.presenceAvailable !== 'boolean') throw new Error('Invalid connection management response');
    if (result.currentDevice) {
      if (result.currentDevice.deviceId !== this.deps.deviceId() || !validVersion(result.currentDevice.connectionVersion)) throw new Error('Invalid current device identity');
      this.deps.observe(result.currentDevice);
    }
    return { ...result, supported: true };
  }

  async remove(input: RemoteConnectionRemoveRequest): Promise<RemoteConnectionOperation> {
    if (!validId(input?.deviceId)) throw new Error('Invalid target device');
    return this.mutate(RemoteConnectionAction.Remove, input.deviceId, input);
  }

  async resume(input: RemoteConnectionResumeRequest): Promise<RemoteConnectionOperation> {
    const assertCurrent = this.deps.guard();
    const supported = await this.deps.ensure(); assertCurrent();
    if (!supported) throw new Error('Device connection management requires a server upgrade');
    const deviceId = this.deps.deviceId();
    if (!deviceId) throw new Error('Device is not registered');
    return this.mutate(RemoteConnectionAction.Resume, deviceId, input, assertCurrent);
  }

  async operation(requestId: string): Promise<RemoteConnectionOperation> {
    if (!validId(requestId)) throw new Error('Invalid connection operation');
    const assertCurrent = this.deps.guard();
    const supported = await this.deps.ensure(); assertCurrent();
    if (!supported) throw new Error('Device connection management requires a server upgrade');
    const result: RemoteConnectionOperation = await this.deps.request(`/device-connection-operations/${encodeURIComponent(requestId)}`);
    assertCurrent();
    if (result.requestId !== requestId) throw new Error('Connection operation identity mismatch');
    this.observeOperation(result);
    return result;
  }

  private async mutate(action: typeof RemoteConnectionAction[keyof typeof RemoteConnectionAction], deviceId: string,
    input: RemoteConnectionResumeRequest, assertCurrent = this.deps.guard()): Promise<RemoteConnectionOperation> {
    if (!validId(input?.requestId) || !validVersion(input?.expectedConnectionVersion)) throw new Error('Invalid connection operation');
    const supported = await this.deps.ensure(); assertCurrent();
    if (!supported) throw new Error('Device connection management requires a server upgrade');
    const result: RemoteConnectionOperation = await this.deps.request(`/devices/${encodeURIComponent(deviceId)}/connection/${action}`, 'POST',
      { requestId: input.requestId, expectedConnectionVersion: input.expectedConnectionVersion });
    assertCurrent();
    if (result.requestId !== input.requestId || result.deviceId !== deviceId) throw new Error('Connection operation identity mismatch');
    this.observeOperation(result);
    return result;
  }

  private observeOperation(result: RemoteConnectionOperation): void {
    if (!validVersion(result.connectionVersion)) throw new Error('Invalid connection version');
    if (result.deviceId === this.deps.deviceId()) this.deps.observe(result);
    // A pending release is not a free slot. Repeated receipt polls must not bypass quota backoff.
    if (result.releaseState === RemoteConnectionReleaseState.Released && !this.completedOperations.has(result.requestId)) {
      if (this.completedOperations.size >= 32) this.completedOperations.delete(this.completedOperations.values().next().value!);
      this.completedOperations.add(result.requestId);
      this.deps.retry();
    }
  }
}
