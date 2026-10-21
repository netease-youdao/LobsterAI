import crypto from 'node:crypto';

import type { ImageEditRequest } from '../../shared/imageEditing/types';
import { MEDIA_INTENT_STORE_KEY, MEDIA_TASK_STORE_KEY, MediaProtocol } from '../../shared/media/constants';
import type { PersistedGeneratedImageAsset } from './mediaAssetPersistence';

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
  requestBody: string;
  createdAt: number;
  taskId?: string;
  rejected?: boolean;
  lastAttemptAt?: number;
}

interface MediaKvStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

/** Account and server are part of every record; no task can resume under a different login. */
export class MediaTaskStore {
  constructor(private readonly kv: MediaKvStore) {}

  tasks(): MediaTaskTracker[] { return this.kv.get<MediaTaskTracker[]>(MEDIA_TASK_STORE_KEY) ?? []; }
  intents(): MediaGenerationIntent[] { return this.kv.get<MediaGenerationIntent[]>(MEDIA_INTENT_STORE_KEY) ?? []; }

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

  beginIntent(input: Omit<MediaGenerationIntent, 'key' | 'createdAt'>): MediaGenerationIntent {
    const records = this.intents();
    const found = records.find(item => item.callKey === input.callKey
      && item.ownerAccountKey === input.ownerAccountKey && item.serverBaseUrl === input.serverBaseUrl);
    if (found) {
      if (found.requestBody !== input.requestBody) throw new Error('A media intent cannot be reused for different input.');
      return found;
    }
    const intent = { ...input, key: crypto.randomUUID(), createdAt: Date.now() };
    records.push(intent);
    this.kv.set(MEDIA_INTENT_STORE_KEY, records);
    return intent;
  }

  saveIntent(intent: MediaGenerationIntent): void {
    this.kv.set(MEDIA_INTENT_STORE_KEY, this.intents().map(item => item.key === intent.key ? intent : item));
  }

  private sameTask(left: MediaTaskTracker, right: MediaTaskTracker): boolean {
    return left.taskId === right.taskId && left.ownerAccountKey === right.ownerAccountKey
      && left.serverBaseUrl === right.serverBaseUrl;
  }
}
