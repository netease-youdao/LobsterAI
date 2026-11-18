import { type FSWatcher, watch, type WatchEventType } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * Watches the files that artifact previews show, so a preview follows edits on disk.
 *
 * fs.watch reports many real edits as 'rename' rather than 'change'. On macOS it does so for every
 * write that neither grows the file nor changes its attributes, such as the agent's same-length
 * in-place `edit`. On every platform it does so for an atomic replacement (a temporary file
 * renamed over the target), after which the watcher still follows the replaced file and misses
 * all later writes. So each burst of events is confirmed with a stat once the file settles: a file
 * that is still there is reported, and the watcher moves to it when it may have been replaced; a
 * file that is gone is not reported, but looked for again until it comes back.
 *
 * Several views may watch one file. Each owner (a renderer) counts its own subscriptions, so one
 * view letting go does not silence another, and an owner that reloads can drop all of its own.
 */

/** Events closer together than this are one change; writers often touch a file several times. */
export const CHANGE_SETTLE_MS = 300;
/** How often a watched file that is gone is looked for again. */
export const MISSING_FILE_POLL_MS = 1000;

export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export interface ArtifactFileWatcherOptions<TOwner> {
  /** A watched file changed on disk and still exists. */
  onChange: (filePath: string, owners: TOwner[]) => void;
  settleMs?: number;
  missingPollMs?: number;
  /** File system access, replaced in tests. */
  watchFile?: (filePath: string, listener: (eventType: WatchEventType) => void) => FSWatcher;
  identify?: (filePath: string) => Promise<FileIdentity>;
}

interface WatchedFile<TOwner> {
  filePath: string;
  /** Subscriptions per owner. */
  owners: Map<TOwner, number>;
  watcher?: FSWatcher;
  /** The file the watcher follows. */
  identity?: FileIdentity;
  /** A 'rename' arrived since the watcher started: the file it follows may be gone. */
  renamed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Checks run one at a time. */
  checks: Promise<void>;
  closed: boolean;
}

const watchWithNode = (filePath: string, listener: (eventType: WatchEventType) => void): FSWatcher =>
  watch(filePath, { persistent: false }, listener);

const identifyWithNode = async (filePath: string): Promise<FileIdentity> => {
  const { dev, ino } = await stat(filePath, { bigint: true });
  return { dev, ino };
};

const isSameFile = (a: FileIdentity, b: FileIdentity | undefined): boolean =>
  b !== undefined && a.dev === b.dev && a.ino === b.ino;

const isMissingFileError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export class ArtifactFileWatcher<TOwner> {
  private readonly files = new Map<string, WatchedFile<TOwner>>();
  private readonly settleMs: number;
  private readonly missingPollMs: number;
  private readonly watchFile: NonNullable<ArtifactFileWatcherOptions<TOwner>['watchFile']>;
  private readonly identify: NonNullable<ArtifactFileWatcherOptions<TOwner>['identify']>;

  constructor(private readonly options: ArtifactFileWatcherOptions<TOwner>) {
    this.settleMs = options.settleMs ?? CHANGE_SETTLE_MS;
    this.missingPollMs = options.missingPollMs ?? MISSING_FILE_POLL_MS;
    this.watchFile = options.watchFile ?? watchWithNode;
    this.identify = options.identify ?? identifyWithNode;
  }

  watch(filePath: string, owner: TOwner): void {
    let file = this.files.get(filePath);
    if (!file) {
      file = { filePath, owners: new Map(), renamed: false, checks: Promise.resolve(), closed: false };
      this.files.set(filePath, file);
      // The subscriber shows the current content already; only later changes are news.
      this.check(file, false);
    }
    file.owners.set(owner, (file.owners.get(owner) ?? 0) + 1);
  }

  unwatch(filePath: string, owner: TOwner): void {
    const file = this.files.get(filePath);
    const count = file?.owners.get(owner);
    if (!file || !count) return;
    if (count > 1) file.owners.set(owner, count - 1);
    else this.drop(file, owner);
  }

  /** Drops every subscription of an owner, e.g. a renderer that reloaded without unsubscribing. */
  releaseOwner(owner: TOwner): void {
    for (const file of [...this.files.values()]) {
      if (file.owners.has(owner)) this.drop(file, owner);
    }
  }

  private drop(file: WatchedFile<TOwner>, owner: TOwner): void {
    file.owners.delete(owner);
    if (file.owners.size) return;
    file.closed = true;
    clearTimeout(file.timer);
    this.disarm(file);
    this.files.delete(file.filePath);
  }

  private schedule(file: WatchedFile<TOwner>, delayMs: number): void {
    clearTimeout(file.timer);
    file.timer = setTimeout(() => {
      file.timer = undefined;
      this.check(file, true);
    }, delayMs);
  }

  private check(file: WatchedFile<TOwner>, report: boolean): void {
    file.checks = file.checks
      .then(() => this.runCheck(file, report))
      .catch(error => { console.warn('[ArtifactWatch] Could not check a watched file:', error); });
  }

  private async runCheck(file: WatchedFile<TOwner>, report: boolean): Promise<void> {
    if (file.closed) return;
    const identity = await this.identify(file.filePath).catch((): undefined => undefined);
    if (file.closed) return;
    if (!identity) {
      // Deleted or moved away: there is nothing new to show, and the watcher follows a file
      // that is gone. Look for it again until it comes back.
      this.disarm(file);
      this.schedule(file, this.missingPollMs);
      return;
    }
    // A 'rename' re-arms even on the same inode number: ext4 reuses a deleted file's number at once.
    if ((!file.watcher || file.renamed || !isSameFile(identity, file.identity)) && !this.arm(file, identity)) return;
    if (report) this.options.onChange(file.filePath, [...file.owners.keys()]);
  }

  private arm(file: WatchedFile<TOwner>, identity: FileIdentity): boolean {
    this.disarm(file);
    let watcher: FSWatcher;
    try {
      watcher = this.watchFile(file.filePath, eventType => {
        if (file.watcher !== watcher) return;
        if (eventType === 'rename') file.renamed = true;
        this.schedule(file, this.settleMs);
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        this.schedule(file, this.missingPollMs);
      } else {
        console.warn('[ArtifactWatch] Could not watch a previewed file:', error);
      }
      return false;
    }
    watcher.on('error', error => {
      if (file.watcher !== watcher) return;
      console.warn('[ArtifactWatch] A previewed file watcher failed:', error);
      this.disarm(file);
    });
    file.watcher = watcher;
    file.identity = identity;
    file.renamed = false;
    return true;
  }

  private disarm(file: WatchedFile<TOwner>): void {
    file.watcher?.close();
    file.watcher = undefined;
    file.identity = undefined;
    file.renamed = false;
  }
}
