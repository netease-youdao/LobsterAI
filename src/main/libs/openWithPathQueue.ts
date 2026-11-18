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
  /** Directory that relative arguments resolve against. */
  cwd: string;
  /**
   * Under `electron .` the app directory is an argument too. It is matched by
   * path, not position: Chromium moves the switches ahead of it in the command
   * line a running instance receives through `second-instance`.
   */
  appPath?: string;
  isExistingPath: (filePath: string) => boolean;
}

export interface OpenWithArgvEntry {
  /** The argument exactly as it appeared on the command line. */
  arg: string;
  path: string;
}

interface BundledPathArgOptions {
  /** Directory that relative arguments resolve against. */
  cwd: string;
  /** Directories LobsterAI ships: its resources and the bundled OpenClaw runtime. */
  bundledRoots: string[];
  /** Path flavor of the command line; defaults to the running platform's. */
  pathApi?: path.PlatformPath;
}

/** Arguments after the executable that are neither switches nor deep links. */
function positionalArgs(argv: string[]): string[] {
  return argv
    .slice(1) // the executable
    .filter(arg => arg.length > 0 && !arg.startsWith('-') && !arg.includes('://'));
}

/**
 * Returns the first argument naming an item inside LobsterAI's own bundle.
 * A bundled script that a child process starts through the app binary without
 * ELECTRON_RUN_AS_NODE boots a GUI instance instead of Node, and its command
 * line arrives through `second-instance`. Nobody opens LobsterAI's own files
 * with LobsterAI, so such a launch is a stray child, not a request.
 */
export function findBundledPathArg(argv: string[], options: BundledPathArgOptions): string | null {
  const pathApi = options.pathApi ?? path;
  const isInside = (root: string, target: string): boolean => {
    const relative = pathApi.relative(root, target);
    return relative !== ''
      && relative !== '..'
      && !relative.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relative);
  };
  return positionalArgs(argv).find((arg) => {
    const target = pathApi.resolve(options.cwd, arg);
    return options.bundledRoots.some(root => isInside(root, target));
  }) ?? null;
}

/**
 * Windows: Explorer "Open with" starts `LobsterAI.exe "<path>"`, and a running
 * instance receives that command line through `second-instance`. Flags and
 * deep links are skipped; only arguments naming an existing item count.
 */
export function collectOpenWithArgv(argv: string[], options: OpenWithArgvOptions): OpenWithArgvEntry[] {
  const { appPath } = options;
  return positionalArgs(argv)
    .map(arg => ({ arg, path: path.win32.resolve(options.cwd, arg) }))
    // path.win32.relative compares case-insensitively, as Windows paths are.
    .filter(entry => !appPath || path.win32.relative(appPath, entry.path) !== '')
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
