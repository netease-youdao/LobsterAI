import { catalogAnalyticsId, isUsageId, readUsageContext, UsageAnalytics, type UsageContext } from '../../shared/analytics/usage';
import { MediaProtocol } from '../../shared/media/constants';
import { MediaSelectionSource, MediaType } from '../../shared/media/defaultPolicy';

const STORE_KEY = 'media.usage.v2';
const RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface MediaUsageRecord {
  id: string;
  scope: string;
  aliases: string[];
  context?: UsageContext;
  mediaType: string;
  selectionSource?: string;
  policyVersion?: string;
  modelId?: string;
  protocolVersion?: number;
  startedAt: number;
  accepted: boolean;
  terminal: boolean;
  saved: boolean;
  generatedSuccessfully?: boolean;
  outputCount?: number;
  attemptCount: number;
  submissionUnknown?: boolean;
}

/** Local correlation/deduplication only, never an event delivery queue. */
export class MediaUsageStore {
  constructor(private readonly kv: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void },
    private readonly now: () => number = Date.now) {}

  find(scope: string, alias: string): MediaUsageRecord | undefined {
    return this.records().find(record => record.scope === scope && record.aliases.includes(alias));
  }

  save(record: MediaUsageRecord): void {
    const snapshot = this.normalize(record);
    if (!snapshot) return;
    const records = this.records().filter(item => item.id !== snapshot.id || item.scope !== snapshot.scope);
    this.kv.set(STORE_KEY, [...records, snapshot].slice(-UsageAnalytics.MaxTrackedItems));
  }

  clear(): void {
    if (this.kv.get<unknown[]>(STORE_KEY)?.length) this.kv.set(STORE_KEY, []);
  }

  private records(): MediaUsageRecord[] {
    const value = this.kv.get<unknown>(STORE_KEY);
    return Array.isArray(value) ? value.map(item => this.normalize(item)).filter((item): item is MediaUsageRecord => !!item) : [];
  }

  private normalize(value: unknown): MediaUsageRecord | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const item = value as MediaUsageRecord;
    if (!isUsageId(item.id) || typeof item.scope !== 'string' || !Array.isArray(item.aliases)
      || ![MediaType.Image, MediaType.Video].some(type => type === item.mediaType)
      || item.protocolVersion !== MediaProtocol.Durable || !Number.isFinite(item.startedAt)
      || item.startedAt > this.now() || this.now() - item.startedAt > RETENTION_MS) return undefined;
    // Build explicitly: neither runtime owner keys nor business payloads belong in snapshots.
    return {
      id: item.id, scope: item.scope,
      aliases: [...new Set(item.aliases.filter(alias => typeof alias === 'string' && alias.length > 0 && alias.length <= 512))].slice(0, 8),
      context: readUsageContext(item.context), mediaType: item.mediaType,
      selectionSource: Object.values(MediaSelectionSource).includes(item.selectionSource as MediaSelectionSource) ? item.selectionSource : undefined,
      policyVersion: catalogAnalyticsId(item.policyVersion), modelId: catalogAnalyticsId(item.modelId),
      protocolVersion: item.protocolVersion, startedAt: item.startedAt,
      accepted: item.accepted === true, terminal: item.terminal === true, saved: item.saved === true,
      generatedSuccessfully: item.generatedSuccessfully === true,
      outputCount: Number.isSafeInteger(item.outputCount) && item.outputCount! >= 0 ? item.outputCount : undefined,
      attemptCount: Number.isSafeInteger(item.attemptCount) && item.attemptCount >= 0 ? item.attemptCount : 0,
      submissionUnknown: item.submissionUnknown === true,
    };
  }
}
