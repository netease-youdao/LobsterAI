import { systemPreferences } from 'electron';
import { EventEmitter } from 'events';

import { CompanionCapability } from '../../shared/desktopCompanion/constants';
import { loadWindowsNative } from './windowsNative';

const MAC_ACTIVATE_NOTIFICATION = 'NSWorkspaceDidActivateApplicationNotification';
const WINDOWS_POLL_MS = 1_000;

/**
 * Electron passes NSRunningApplication through as its description, e.g.
 * `<NSRunningApplication: 0x6000 (com.apple.finder - 629) LSASN:{hi=0x0;lo=0xf00f}>`.
 */
export function parseRunningApplication(userInfo: unknown): string | null {
  const value = (userInfo as Record<string, unknown> | null)?.NSWorkspaceApplicationKey;
  if (typeof value !== 'string') return null;
  const match = /\(([^\s()]+) - \d+\)/.exec(value);
  return match ? match[1] : null;
}

export interface ForegroundAppMonitor extends EventEmitter {
  readonly capability: CompanionCapability;
  readonly currentAppId: string | null;
  start(): void;
  stop(): void;
  /** Whether the user is presenting or in a fullscreen/quiet mode the OS reports. */
  isUserBusy(): boolean;
}

/** Emits `change` with the frontmost application's bundle id (macOS) or executable name (Windows). */
export class CompanionForegroundMonitor extends EventEmitter implements ForegroundAppMonitor {
  readonly capability: CompanionCapability;
  private subscription: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private current: string | null = null;

  constructor() {
    super();
    if (process.platform === 'darwin') this.capability = CompanionCapability.Ready;
    else if (process.platform === 'win32') this.capability = loadWindowsNative() ? CompanionCapability.Ready : CompanionCapability.Unsupported;
    else this.capability = CompanionCapability.Unsupported;
  }

  get currentAppId(): string | null {
    return this.current;
  }

  start(): void {
    if (this.capability !== CompanionCapability.Ready || this.subscription !== null || this.pollTimer) return;
    if (process.platform === 'darwin') {
      this.subscription = systemPreferences.subscribeWorkspaceNotification(MAC_ACTIVATE_NOTIFICATION, (_event, userInfo) => {
        this.update(parseRunningApplication(userInfo));
      });
      return;
    }
    const native = loadWindowsNative();
    if (!native) return;
    const poll = () => {
      try {
        this.update(native.foregroundProcessName());
      } catch (error) {
        console.warn('[DesktopCompanion] Foreground app poll failed:', error);
      }
    };
    poll();
    this.pollTimer = setInterval(poll, WINDOWS_POLL_MS);
  }

  stop(): void {
    if (this.subscription !== null) {
      systemPreferences.unsubscribeWorkspaceNotification(this.subscription);
      this.subscription = null;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  isUserBusy(): boolean {
    if (process.platform !== 'win32') return false;
    try {
      return loadWindowsNative()?.isUserBusy() ?? false;
    } catch {
      return false;
    }
  }

  private update(appId: string | null): void {
    if (!appId || appId === this.current) return;
    this.current = appId;
    this.emit('change', appId);
  }
}
