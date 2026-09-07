import {
  LibraryThumbnailFailureCode,
  type LibraryThumbnailGenerateResponse,
  LibraryThumbnailRequestPriority,
  type LibraryThumbnailRequestPriorityType,
} from '../../../shared/library/thumbnail';

export const LibraryThumbnailLoadStatus = {
  Queued: 'queued',
  Rendering: 'rendering',
  RetryWait: 'retry-wait',
  Ready: 'ready',
  Failed: 'failed',
  Unsupported: 'unsupported',
} as const;

export type LibraryThumbnailLoadStatusType = typeof LibraryThumbnailLoadStatus[
  keyof typeof LibraryThumbnailLoadStatus
];

export interface LibraryThumbnailLoadState {
  status: LibraryThumbnailLoadStatusType;
  dataUrl?: string;
  response?: LibraryThumbnailGenerateResponse;
  attempt: number;
}

interface SchedulerListener {
  priority: LibraryThumbnailRequestPriorityType;
  onStateChange: (state: LibraryThumbnailLoadState) => void;
}

interface SchedulerEntry {
  key: string;
  sequence: number;
  attempt: number;
  state: LibraryThumbnailLoadState;
  requestId?: string;
  listeners: Map<number, SchedulerListener>;
  load: (
    requestId: string,
    priority: LibraryThumbnailRequestPriorityType,
  ) => Promise<LibraryThumbnailGenerateResponse>;
  cancel?: (requestId: string) => void;
  retryTimer?: ReturnType<typeof setTimeout>;
  running: boolean;
}

export interface LibraryThumbnailSubscription {
  updatePriority: (priority: LibraryThumbnailRequestPriorityType) => void;
  retry: () => void;
  unsubscribe: () => void;
}

interface LibraryThumbnailScheduleOptions {
  key: string;
  priority: LibraryThumbnailRequestPriorityType;
  load: SchedulerEntry['load'];
  cancel?: SchedulerEntry['cancel'];
  onStateChange: SchedulerListener['onStateChange'];
}

const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_RETRY_DELAYS_MS = [500, 2_000] as const;
const MAX_SETTLED_FAILURES = 128;

export class LibraryThumbnailScheduler {
  private readonly maxConcurrency: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly entries = new Map<string, SchedulerEntry>();
  private activeCount = 0;
  private nextSequence = 0;
  private nextListenerId = 0;
  private nextRequestId = 0;

  constructor(options?: {
    maxConcurrency?: number;
    retryDelaysMs?: readonly number[];
  }) {
    this.maxConcurrency = Math.max(1, Math.floor(
      options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    ));
    this.retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  subscribe(options: LibraryThumbnailScheduleOptions): LibraryThumbnailSubscription {
    let entry = this.entries.get(options.key);
    if (!entry) {
      entry = {
        key: options.key,
        sequence: this.nextSequence++,
        attempt: 0,
        state: {
          status: LibraryThumbnailLoadStatus.Queued,
          attempt: 0,
        },
        listeners: new Map(),
        load: options.load,
        cancel: options.cancel,
        running: false,
      };
      this.entries.set(options.key, entry);
    }

    const listenerId = this.nextListenerId++;
    entry.sequence = this.nextSequence++;
    entry.listeners.set(listenerId, {
      priority: options.priority,
      onStateChange: options.onStateChange,
    });
    options.onStateChange(entry.state);
    this.pump();

    let active = true;
    return {
      updatePriority: priority => {
        if (!active) return;
        const currentEntry = this.entries.get(options.key);
        const listener = currentEntry?.listeners.get(listenerId);
        if (!listener || listener.priority === priority) return;
        listener.priority = priority;
        this.pump();
      },
      retry: () => {
        if (!active) return;
        const currentEntry = this.entries.get(options.key);
        if (!currentEntry || currentEntry.running) return;
        if (currentEntry.retryTimer) clearTimeout(currentEntry.retryTimer);
        currentEntry.retryTimer = undefined;
        currentEntry.attempt = 0;
        currentEntry.sequence = this.nextSequence++;
        this.publish(currentEntry, {
          status: LibraryThumbnailLoadStatus.Queued,
          attempt: 0,
        });
        this.pump();
      },
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.unsubscribe(options.key, listenerId);
      },
    };
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      if (entry.requestId) entry.cancel?.(entry.requestId);
    }
    this.entries.clear();
  }

  private unsubscribe(key: string, listenerId: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.listeners.delete(listenerId);
    if (entry.listeners.size > 0) return;

    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    if (entry.requestId) entry.cancel?.(entry.requestId);
    if (!entry.running) {
      const settledFailure = entry.state.status === LibraryThumbnailLoadStatus.Failed
        || entry.state.status === LibraryThumbnailLoadStatus.Unsupported;
      if (settledFailure) this.pruneSettledFailures();
      else this.entries.delete(key);
    }
  }

  private getPriority(entry: SchedulerEntry): LibraryThumbnailRequestPriorityType {
    let priority: LibraryThumbnailRequestPriorityType = LibraryThumbnailRequestPriority.Background;
    for (const listener of entry.listeners.values()) {
      if (listener.priority < priority) priority = listener.priority;
    }
    return priority;
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrency) {
      const nextEntry = [...this.entries.values()]
        .filter(entry => (
          !entry.running
          && !entry.retryTimer
          && entry.listeners.size > 0
          && entry.state.status === LibraryThumbnailLoadStatus.Queued
        ))
        .sort((left, right) => (
          this.getPriority(left) - this.getPriority(right)
          || left.sequence - right.sequence
        ))[0];
      if (!nextEntry) return;
      this.start(nextEntry);
    }
  }

  private start(entry: SchedulerEntry): void {
    entry.running = true;
    entry.attempt += 1;
    entry.requestId = `library-thumbnail-${Date.now()}-${this.nextRequestId++}`;
    const requestId = entry.requestId;
    const priority = this.getPriority(entry);
    this.activeCount += 1;
    this.publish(entry, {
      status: LibraryThumbnailLoadStatus.Rendering,
      attempt: entry.attempt,
    });

    void entry.load(requestId, priority).then(response => {
      if (response.success && response.dataUrl) {
        this.publish(entry, {
          status: LibraryThumbnailLoadStatus.Ready,
          dataUrl: response.dataUrl,
          response,
          attempt: entry.attempt,
        });
        return;
      }

      this.handleFailure(entry, response);
    }).catch(error => {
      this.handleFailure(entry, {
        success: false,
        error: error instanceof Error ? error.message : 'Thumbnail request failed',
        failureCode: LibraryThumbnailFailureCode.RendererFailed,
        retryable: true,
      });
    }).finally(() => {
      entry.running = false;
      entry.requestId = undefined;
      this.activeCount -= 1;
      if (entry.listeners.size === 0 || entry.state.status === LibraryThumbnailLoadStatus.Ready) {
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        this.entries.delete(entry.key);
      }
      this.pump();
    });
  }

  private publish(entry: SchedulerEntry, state: LibraryThumbnailLoadState): void {
    entry.state = state;
    for (const listener of entry.listeners.values()) listener.onStateChange(state);
  }

  private pruneSettledFailures(): void {
    const settledEntries = [...this.entries.values()]
      .filter(entry => (
        !entry.running
        && entry.listeners.size === 0
        && (
          entry.state.status === LibraryThumbnailLoadStatus.Failed
          || entry.state.status === LibraryThumbnailLoadStatus.Unsupported
        )
      ))
      .sort((left, right) => left.sequence - right.sequence);
    const removeCount = settledEntries.length - MAX_SETTLED_FAILURES;
    for (const entry of settledEntries.slice(0, Math.max(0, removeCount))) {
      this.entries.delete(entry.key);
    }
  }

  private handleFailure(
    entry: SchedulerEntry,
    response: LibraryThumbnailGenerateResponse,
  ): void {
    const unsupported = response.failureCode === LibraryThumbnailFailureCode.UnsupportedFormat;
    const retryIndex = entry.attempt - 1;
    const retryDelay = this.retryDelaysMs[retryIndex];
    if (response.retryable && retryDelay !== undefined && entry.listeners.size > 0) {
      this.publish(entry, {
        status: LibraryThumbnailLoadStatus.RetryWait,
        response,
        attempt: entry.attempt,
      });
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined;
        if (entry.listeners.size === 0) {
          this.entries.delete(entry.key);
          return;
        }
        entry.sequence = this.nextSequence++;
        this.publish(entry, {
          status: LibraryThumbnailLoadStatus.Queued,
          response,
          attempt: entry.attempt,
        });
        this.pump();
      }, retryDelay);
      return;
    }

    this.publish(entry, {
      status: unsupported
        ? LibraryThumbnailLoadStatus.Unsupported
        : LibraryThumbnailLoadStatus.Failed,
      response,
      attempt: entry.attempt,
    });
  }
}

export const libraryThumbnailScheduler = new LibraryThumbnailScheduler();
