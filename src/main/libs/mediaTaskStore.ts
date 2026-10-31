import crypto from 'node:crypto';

import type { ImageEditRequest } from '../../shared/imageEditing/types';
import {
  MEDIA_INTENT_BODY_KEY_PREFIX,
  MEDIA_INTENT_STORE_KEY,
  MEDIA_TASK_STORE_KEY,
  MediaProtocol,
} from '../../shared/media/constants';
import type { PersistedGeneratedImageAsset } from './mediaAssetPersistence';

/** Unacknowledged intents older than this are no longer resubmitted. */
export const MEDIA_INTENT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Settled intents stay indexed this long so a replayed tool call keeps its idempotency key. */
export const MEDIA_INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface MediaTaskTracker {
  imageEdit?: ImageEditRequest;
  taskId: string;
  sessionId: string;
  mediaType: 'image' | 'video';
  model: string;
  ownerAccountKey: string;
  accountGeneration: number;
  startedAt: number;
  pollCount: number;
  timeoutMs: number;
  lastPollAt?: number;
  protocolVersion?: number;
  serverBaseUrl?: string;
  toolCallId?: string;
  delivered?: boolean;
  savedAssets?: PersistedGeneratedImageAsset[];
  deliveryRetryAt?: number;
}

export interface MediaGenerationIntent {
  imageEdit?: ImageEditRequest;
  key: string;
  callKey: string;
  ownerAccountKey: string;
  serverBaseUrl: string;
  sessionId: string;
  mediaType: 'image' | 'video';
  model: string;
  toolCallId: string;
  requestBodySha256: string;
  /** The request body is stored under its own key while the intent can still be resubmitted. */
  hasRequestBody?: boolean;
  createdAt: number;
  taskId?: string;
  rejected?: boolean;
  lastAttemptAt?: number;
}

export type MediaGenerationIntentInput = Omit<
  MediaGenerationIntent,
  'key' | 'createdAt' | 'requestBodySha256' | 'hasRequestBody'
> & { requestBody: string };

/** Older builds kept the request body inline, which grew the index by every inline image. */
type StoredMediaGenerationIntent = Omit<MediaGenerationIntent, 'requestBodySha256'> & {
  requestBodySha256?: string;
  requestBody?: string;
};

interface MediaKvStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

const hashRequestBody = (requestBody: string): string => crypto.createHash('sha256').update(requestBody).digest('hex');
const intentBodyKey = (intentKey: string): string => `${MEDIA_INTENT_BODY_KEY_PREFIX}${intentKey}`;

/**
 * Account and server are part of every record; no task can resume under a different login.
 * The intent index is read on every recovery tick, so request bodies (which may carry inline
 * images) live under their own keys and are dropped once the intent is settled or expired.
 */
export class MediaTaskStore {
  constructor(
    private readonly kv: MediaKvStore,
    private readonly now: () => number = Date.now,
  ) {}

  tasks(): MediaTaskTracker[] { return this.kv.get<MediaTaskTracker[]>(MEDIA_TASK_STORE_KEY) ?? []; }

  intents(): MediaGenerationIntent[] {
    const records = this.kv.get<StoredMediaGenerationIntent[]>(MEDIA_INTENT_STORE_KEY) ?? [];
    return records.some(record => this.needsCompaction(record))
      ? this.writeIntents(records)
      : records as MediaGenerationIntent[];
  }

  findUnacknowledgedIntent(callKey: string, ownerAccountKey: string, serverBaseUrl: string): MediaGenerationIntent | undefined {
    return this.intents().find(intent => intent.callKey === callKey && intent.ownerAccountKey === ownerAccountKey
      && intent.serverBaseUrl === serverBaseUrl && !intent.rejected && !intent.taskId);
  }

  findOwnedTask(taskId: string, ownerAccountKey: string, serverBaseUrl: string): MediaTaskTracker | undefined {
    return this.tasks().find(task => task.taskId === taskId && task.ownerAccountKey === ownerAccountKey
      && task.serverBaseUrl === serverBaseUrl);
  }

  save(tracker: MediaTaskTracker): void {
    if (tracker.protocolVersion !== MediaProtocol.Durable) return;
    const records = this.tasks();
    const index = records.findIndex(item => this.sameTask(item, tracker));
    if (index < 0) records.push({ ...tracker }); else records[index] = { ...tracker };
    this.kv.set(MEDIA_TASK_STORE_KEY, records);
  }

  delivered(tracker: MediaTaskTracker): boolean {
    return this.tasks().some(item => this.sameTask(item, tracker) && item.delivered);
  }

  beginIntent(input: MediaGenerationIntentInput): MediaGenerationIntent {
    const { requestBody, ...fields } = input;
    const requestBodySha256 = hashRequestBody(requestBody);
    const records = this.intents();
    const found = records.find(item => item.callKey === fields.callKey
      && item.ownerAccountKey === fields.ownerAccountKey && item.serverBaseUrl === fields.serverBaseUrl);
    if (found) {
      if (found.requestBodySha256 !== requestBodySha256) throw new Error('A media intent cannot be reused for different input.');
      return found;
    }
    const intent: MediaGenerationIntent = {
      ...fields, key: crypto.randomUUID(), createdAt: this.now(), requestBodySha256, hasRequestBody: true,
    };
    this.kv.set(intentBodyKey(intent.key), requestBody);
    this.writeIntents([...records, intent]);
    return intent;
  }

  /** Body to resubmit, or undefined once the intent no longer keeps one. */
  intentRequestBody(intent: MediaGenerationIntent): string | undefined {
    return intent.hasRequestBody ? this.kv.get<string>(intentBodyKey(intent.key)) : undefined;
  }

  saveIntent(intent: MediaGenerationIntent): void {
    // Body ownership is tracked by the store, not by the copy the caller holds.
    this.writeIntents(this.intents().map(item => item.key === intent.key
      ? { ...intent, hasRequestBody: item.hasRequestBody }
      : item));
  }

  private isResubmittable(intent: StoredMediaGenerationIntent): boolean {
    return !intent.taskId && !intent.rejected && this.now() - intent.createdAt <= MEDIA_INTENT_RETRY_WINDOW_MS;
  }

  private isRetained(intent: StoredMediaGenerationIntent): boolean {
    return this.now() - intent.createdAt <= MEDIA_INTENT_RETENTION_MS;
  }

  private needsCompaction(record: StoredMediaGenerationIntent): boolean {
    return record.requestBody !== undefined
      || !this.isRetained(record)
      || (record.hasRequestBody === true && !this.isResubmittable(record));
  }

  private writeIntents(records: StoredMediaGenerationIntent[]): MediaGenerationIntent[] {
    const kept: MediaGenerationIntent[] = [];
    let inlineBodies = 0;
    for (const { requestBody, ...record } of records) {
      if (requestBody !== undefined) inlineBodies += 1;
      const keepBody = this.isRetained(record) && this.isResubmittable(record);
      if (record.hasRequestBody && !keepBody) this.kv.delete(intentBodyKey(record.key));
      if (!this.isRetained(record)) continue;
      const intent: MediaGenerationIntent = {
        ...record,
        requestBodySha256: record.requestBodySha256 ?? hashRequestBody(requestBody ?? ''),
      };
      if (keepBody && requestBody !== undefined) {
        this.kv.set(intentBodyKey(intent.key), requestBody);
        intent.hasRequestBody = true;
      } else if (!keepBody) {
        delete intent.hasRequestBody;
      }
      kept.push(intent);
    }
    this.kv.set(MEDIA_INTENT_STORE_KEY, kept);
    if (inlineBodies > 0) {
      console.log(`[MediaGeneration] compacted media intent index: removed ${inlineBodies} inline request bodies, kept ${kept.length}/${records.length} intents.`);
    }
    return kept;
  }

  private sameTask(left: MediaTaskTracker, right: MediaTaskTracker): boolean {
    return left.taskId === right.taskId && left.ownerAccountKey === right.ownerAccountKey
      && left.serverBaseUrl === right.serverBaseUrl;
  }
}
