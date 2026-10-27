import { parseCoworkErrorDetail } from '../../shared/cowork/errorDetail';
import type { RemoteReplyBlock } from '../../shared/remote/reply';
import { stableJson } from './canonical';
import { isPublicReplyMessage, redactReplyText, replyBlocks, replyDisplay } from './remoteReplyProjection';

/** Local encoder policy only; this does not change the public projection protocol. */
export const RemoteLiveEncoderVersion = 2;
export const RemoteLiveEncodingLimits = {
  RawMetadataBytes: 256 * 1024, MetadataBytes: 32 * 1024, InlineBytes: 48 * 1024,
  ContentBytes: 128 * 1024, MetadataDepth: 32, MetadataNodes: 8192,
} as const;
export const RemoteLiveEncodingError = {
  RawMetadataBudget: 'REMOTE_LIVE_METADATA_RAW_BUDGET',
  MetadataBudget: 'REMOTE_LIVE_METADATA_BUDGET',
  MetadataInvalid: 'REMOTE_LIVE_METADATA_INVALID',
  MetadataStructureBudget: 'REMOTE_LIVE_METADATA_STRUCTURE_BUDGET',
  IdentityInvalid: 'REMOTE_LIVE_METADATA_IDENTITY_INVALID',
  ContentSizeUnknown: 'REMOTE_LIVE_CONTENT_SIZE_UNKNOWN',
  ToolIdentityMissing: 'REMOTE_LIVE_TOOL_IDENTITY_MISSING',
  OwnerChanged: 'REMOTE_LIVE_OWNER_CHANGED',
} as const;
export const RemoteLiveMetadataMode = { Message: 'message', Tool: 'tool' } as const;
type Message = { id: string; type: string; content: string };
export interface NormalizedLiveMetadata {
  metadata: Record<string, any>;
  normalizedBytes: number;
  publicFieldsOmitted: boolean;
  isPublic(row: Message): boolean;
  blocks(row: Message): RemoteReplyBlock[];
}
const identities = ['remoteRunId', 'remoteCommandId', 'toolUseId', 'toolCallId'] as const;
const booleans = ['isStreaming', 'isFinal', 'isError', 'isCancelled', 'isThinking'] as const;
const labels = ['kind', 'status', 'model', 'resolvedModelId', 'modelPresetId', 'toolName'] as const;
const displayKeys = ['kind', 'status', 'mediaType', 'taskId', 'upstreamTaskId', 'pollCount', 'progress', 'isMediaStatusPolling', 'mode', 'startedAt', 'completedAt'] as const;
const fail = (code: typeof RemoteLiveEncodingError[keyof typeof RemoteLiveEncodingError]): never => { throw new Error(code); };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function liveMetadataToolId(metadata: Record<string, unknown>, messageId: string): string {
  const value = metadata.toolUseId || metadata.toolCallId || messageId;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) return fail(RemoteLiveEncodingError.IdentityInvalid);
  return value;
}
function checkStructure(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > RemoteLiveEncodingLimits.MetadataNodes || item.depth > RemoteLiveEncodingLimits.MetadataDepth)
      fail(RemoteLiveEncodingError.MetadataStructureBudget);
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) fail(RemoteLiveEncodingError.MetadataInvalid);
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}
function displaySource(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (record(value)) for (const key of displayKeys) if (Object.hasOwn(value, key)) {
    const item = value[key];
    result[key] = typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) ? item : null;
  }
  return result;
}
/** Raw JSON is read only by the isolated worker; methods retain at most one bounded source object until encoding finishes. */
export function normalizeLiveMetadata(raw: string | null, rawBytes: number | null,
  mode: typeof RemoteLiveMetadataMode[keyof typeof RemoteLiveMetadataMode] = RemoteLiveMetadataMode.Message,
  message?: Pick<Message, 'type' | 'content'>): NormalizedLiveMetadata {
  const bytes = rawBytes ?? 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > RemoteLiveEncodingLimits.RawMetadataBytes)
    fail(RemoteLiveEncodingError.RawMetadataBudget);
  if (typeof raw !== 'string' && bytes !== 0 || typeof raw === 'string' && Buffer.byteLength(raw) !== bytes)
    fail(RemoteLiveEncodingError.MetadataInvalid);
  let source: unknown;
  try { source = JSON.parse(raw || '{}'); } catch { return fail(RemoteLiveEncodingError.MetadataInvalid); }
  if (!record(source)) return fail(RemoteLiveEncodingError.MetadataInvalid);
  const metadata: Record<string, any> = {};
  for (const key of identities) {
    const value = source[key];
    if (value != null && value !== '' && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)))
      fail(RemoteLiveEncodingError.IdentityInvalid);
    if (Object.hasOwn(source, key)) metadata[key] = value;
  }
  for (const key of booleans) {
    if (!Object.hasOwn(source, key)) continue;
    if (typeof source[key] !== 'boolean') fail(RemoteLiveEncodingError.MetadataInvalid);
    metadata[key] = source[key];
  }
  for (const key of labels) {
    const value = source[key];
    if (value == null) continue;
    if (typeof value !== 'string') return fail(RemoteLiveEncodingError.MetadataInvalid);
    if (key === 'toolName') {
      // This is a display label, not an identifier; retain the existing 128-character wire policy.
      metadata[key] = redactReplyText(value).slice(0, 128).replace(/[\uD800-\uDBFF]$/u, '');
    } else {
      if (Buffer.byteLength(value) > 4096) fail(RemoteLiveEncodingError.MetadataBudget);
      metadata[key] = value;
    }
  }
  // Preserve error truthiness for tool state and system visibility without copying an arbitrary error object.
  metadata.error = Boolean(source.error);
  if (mode === RemoteLiveMetadataMode.Tool) {
    return { metadata, normalizedBytes: Buffer.byteLength(stableJson(metadata)), publicFieldsOmitted: false,
      isPublic: () => false, blocks: () => [] };
  }
  const projection: Record<string, any> = { ...displaySource(source), ...metadata,
    mediaStatusDetails: displaySource(source.mediaStatusDetails), toolResultDetails: displaySource(source.toolResultDetails) };
  if ((!message || message.type === 'tool_use') && Object.hasOwn(source, 'toolInput')) projection.toolInput = source.toolInput;
  if ((!message || message.type === 'tool_result' && !message.content) && typeof source.toolResult === 'string') projection.toolResult = source.toolResult;
  if ((!message || message.type === 'tool_result' || message.type === 'system') && typeof source.error === 'string') projection.error = source.error;
  const errorDetail = !message || message.type === 'system' ? parseCoworkErrorDetail(source.errorDetail) : null;
  if (errorDetail) projection.errorDetail = errorDetail;
  checkStructure(projection);
  // Count only normalized public fields. Large private tool diff/patch payloads never enter this budget.
  const normalized: Record<string, any> = { ...metadata, display: replyDisplay(projection) ?? null };
  for (const key of ['toolInput', 'toolResult', 'error', 'errorDetail']) if (Object.hasOwn(projection, key)) normalized[key] = projection[key];
  const publicFieldsOmitted = Buffer.byteLength(stableJson(normalized)) > RemoteLiveEncodingLimits.MetadataBytes;
  const bounded = publicFieldsOmitted ? metadata : normalized;
  const normalizedBytes = Buffer.byteLength(stableJson(bounded));
  if (normalizedBytes > RemoteLiveEncodingLimits.MetadataBytes) fail(RemoteLiveEncodingError.MetadataBudget);
  // Keep the bounded original public fields for exact canonical block sizing even when the inline projection must be omitted.
  return { metadata: bounded, normalizedBytes, publicFieldsOmitted,
    isPublic: row => isPublicReplyMessage({ ...row, metadata: JSON.stringify({ kind: metadata.kind ?? null, error: metadata.error }) }),
    blocks: row => replyBlocks(row, projection) };
}
