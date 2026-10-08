import path from 'path';

import { AppIpcChannel } from '../../shared/app/constants';

/** macOS sends one open-file event per item; this groups a multi-selection. */
const NOTIFY_DELAY_MS = 100;

export interface OpenWithPathQueueTarget {
  isDestroyed(): boolean;
  send(channel: string): void;
}

interface OpenWithPathQueueOptions {
  getTarget: () => OpenWithPathQueueTarget | null;
}

interface OpenWithArgvOptions {
  /** Leading entries owned by the launcher: the executable, plus the app path under `electron .`. */
  launcherArgCount: number;
  /** Directory that relative arguments resolve against. */
  cwd: string;
  isExistingPath: (filePath: string) => boolean;
}

export interface OpenWithArgvEntry {
  /** The argument exactly as it appeared on the command line. */
  arg: string;
  path: string;
}

/**
 * Windows: Explorer "Open with" starts `LobsterAI.exe "<path>"`, and a running
 * instance receives that command line through `second-instance`. Flags and
 * deep links are skipped; only arguments naming an existing item count.
 */
export function collectOpenWithArgv(argv: string[], options: OpenWithArgvOptions): OpenWithArgvEntry[] {
  return argv
    .slice(options.launcherArgCount)
    .filter(arg => arg.length > 0 && !arg.startsWith('-') && !arg.includes('://'))
    .map(arg => ({ arg, path: path.win32.resolve(options.cwd, arg) }))
    .filter(entry => options.isExistingPath(entry.path));
}

/**
 * Holds the files and folders macOS asked LobsterAI to open (Finder "Open
 * With", drops on the Dock icon) until the renderer takes them.
 *
 * The renderer pulls the queue rather than receiving the paths in the
 * notification, so a renderer that is still starting or reloading misses
 * nothing: it takes whatever is queued once it is ready.
 */
export class OpenWithPathQueue {
  private pendingPaths: string[] = [];
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: OpenWithPathQueueOptions) {}

  /** Returns true for the first path of a burst, so callers act once per selection. */
  enqueue(filePath: string): boolean {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
    const startsBurst = this.notifyTimer === null;
    if (!this.pendingPaths.includes(filePath)) {
      this.pendingPaths.push(filePath);
    }
    this.scheduleNotify();
    return startsBurst;
  }

  consume(): string[] {
    const paths = this.pendingPaths;
    this.pendingPaths = [];
    return paths;
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (this.pendingPaths.length === 0) return;
      const target = this.options.getTarget();
      if (target && !target.isDestroyed()) {
        target.send(AppIpcChannel.OpenWithPathsAvailable);
      }
    }, NOTIFY_DELAY_MS);
  }
}
