import type { RemoteSettingsState } from '../../shared/remote/constants';

export const PREVENT_SLEEP_STORE_KEY = 'prevent_sleep_enabled';

interface SettingsDependencies {
  getRemoteState(): RemoteSettingsState;
  getAccountEpoch?(): string;
  getKeepAwakePreference(): boolean | undefined;
  saveKeepAwakePreference(enabled: boolean): void;
  applyKeepAwake(enabled: boolean): void;
  isKeepAwakeActive(): boolean;
  publish(state: RemoteSettingsState): void;
}

/** Combines connection and power state into one ordered renderer snapshot. */
export class RemoteSettingsController {
  private revision = 0;
  private powerError: string | undefined;
  private screenLocked: boolean | undefined;

  constructor(private readonly deps: SettingsDependencies) {}

  state(): RemoteSettingsState {
    const remote = this.deps.getRemoteState();
    let active = false;
    try { active = this.deps.isKeepAwakeActive(); } catch { /* OS power API may be unavailable. */ }
    return {
      ...remote,
      ...(this.deps.getAccountEpoch ? { accountEpoch: this.deps.getAccountEpoch() } : {}),
      stateRevision: this.revision,
      keepAwakeEnabled: Boolean(remote.owner) && (this.deps.getKeepAwakePreference() ?? true),
      keepAwakeActive: active,
      keepAwakeError: this.powerError,
      screenLocked: this.screenLocked,
    };
  }

  notify(): void {
    this.revision += 1;
    this.deps.publish(this.state());
  }

  restoreKeepAwake(): void {
    if (!this.deps.getRemoteState().owner) {
      // Logout releases the OS assertion without replacing the saved user preference.
      this.applyKeepAwake(false);
      return;
    }
    const saved = this.deps.getKeepAwakePreference();
    if (saved == null) {
      try { this.deps.saveKeepAwakePreference(true); }
      catch {
        this.powerError = 'KEEP_AWAKE_UNAVAILABLE';
        this.notify();
        return;
      }
    }
    this.applyKeepAwake(saved ?? true);
  }

  setKeepAwake(enabled: boolean): RemoteSettingsState {
    if (typeof enabled !== 'boolean') throw new Error('Invalid keep-awake preference');
    if (!this.deps.getRemoteState().owner) throw new Error('Login required');
    // Persist intent even if the OS cannot currently honor it.
    this.deps.saveKeepAwakePreference(enabled);
    this.applyKeepAwake(enabled);
    return this.state();
  }

  setScreenLocked(locked: boolean): void {
    this.screenLocked = locked;
    this.notify();
  }

  private applyKeepAwake(enabled: boolean): void {
    this.powerError = undefined;
    try {
      this.deps.applyKeepAwake(enabled);
      if (this.deps.isKeepAwakeActive() !== enabled) this.powerError = 'KEEP_AWAKE_UNAVAILABLE';
    } catch {
      this.powerError = 'KEEP_AWAKE_UNAVAILABLE';
    }
    this.notify();
  }

  dispose(): void {
    try { this.deps.applyKeepAwake(false); } catch { /* Process exit also releases the assertion. */ }
  }
}
