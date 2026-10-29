import { createHash } from 'crypto';

import { CoworkSystemMessageKind, isInternalCompactionSystemText } from '../../common/coworkSystemMessages';
import { formatCoworkErrorDetailText, parseCoworkErrorDetail } from '../../shared/cowork/errorDetail';
import { RemoteReply, type RemoteReplyBlock,RemoteReplyBlockType } from '../../shared/remote/reply';
import { stableJson } from './canonical';
import { buildRemoteAnnotationText } from './remoteAnnotationText';

/** Match the renderer's hidden runtime notices rather than exposing internal compaction input. */
export function isPublicReplyMessage(row: { type: string; content: string; metadata?: string | null }): boolean {
  if (!['user', 'assistant', 'tool_use', 'tool_result', 'system'].includes(row.type)) return false;
  let metadata: Record<string, any> = {};
  try { metadata = JSON.parse(row.metadata || '{}'); } catch { /* Malformed legacy metadata cannot add display fields. */ }
  if (row.type === 'assistant' && /^[`*_~"'""''()[\]{}<>.,!?;:，。！？；：\s-]{0,8}NO_REPLY[`*_~"'""''()[\]{}<>.,!?;:，。！？；：\s-]{0,8}$/i.test((row.content || '').trim())) return false;
  if (row.type === 'system') {
    if (metadata.kind === CoworkSystemMessageKind.ForkCompactionSummary || (!metadata.kind && isInternalCompactionSystemText(row.content || ''))) return false;
    if (!row.content?.trim() && !metadata.error && metadata.kind !== CoworkSystemMessageKind.ContextCompaction) return false;
  }
  return true;
}
const secretField = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|proxy[_-]?authorization|password|passwd|secret|client[_-]?secret|cookie|set-cookie)$/i;
/** Only recognizable credential fields are masked. Ordinary file paths remain visible text. */
export function redactReplyText(text: string): string {
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]').replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)["']?)\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]');
}
export function redactReplyValue(value: unknown): unknown {
  if (typeof value === 'string') return redactReplyText(value);
  if (Array.isArray(value)) return value.map(redactReplyValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretField.test(key) ? '[redacted]' : redactReplyValue(item)]));
  return value;
}
export const replyBlockId = (messageId: string, part: string): string => createHash('sha256').update(`${messageId}:${part}`).digest('hex').slice(0, 32);
const displayFields = ['kind', 'status', 'mediaType', 'taskId', 'upstreamTaskId', 'pollCount', 'progress', 'isMediaStatusPolling', 'mode', 'startedAt', 'completedAt'] as const;
export function replyDisplay(metadata: Record<string, any>): RemoteReplyBlock['display'] | undefined {
  const source = { ...metadata, ...metadata.mediaStatusDetails, ...metadata.toolResultDetails };
  if (source.kind && !['media', 'context_compaction', 'subagent', 'error', 'diff', 'todo'].includes(source.kind)) delete source.kind;
  const display: NonNullable<RemoteReplyBlock['display']> = {};
  for (const key of displayFields) {
    const value = source[key];
    if (['kind', 'status', 'mediaType', 'taskId', 'upstreamTaskId', 'mode'].includes(key) && typeof value === 'string') display[key] = redactReplyText(value).slice(0, 256);
    else if (key === 'isMediaStatusPolling' && typeof value === 'boolean') display[key] = value;
    else if (['pollCount', 'progress', 'startedAt', 'completedAt'].includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && (key !== 'progress' || value <= 100)) display[key] = value;
  }
  return Object.keys(display).length ? display : undefined;
}
export function replyUserText(content: string, metadata: Record<string, unknown>, annotationText = buildRemoteAnnotationText(metadata)): string {
  const text = redactReplyText(content || '');
  const annotations = redactReplyText(annotationText);
  return annotations && !text.includes(annotations) ? [text, annotations].filter(Boolean).join('\n\n') : text;
}
export function replyBlocks(row: { id: string; type: string; content: string }, metadata: Record<string, any>, toolName?: string, annotationText?: string): RemoteReplyBlock[] {
  const id = (part: string): string => replyBlockId(row.id, part);
  const text = redactReplyText(row.content || '');
  const toolCallId = String(metadata.toolUseId || metadata.toolCallId || row.id);
  const display = replyDisplay(metadata);
  if (row.type === 'tool_use') return [{ blockId: id('input'), type: RemoteReplyBlockType.ToolInput, toolCallId,
    ...(toolName ? { toolName } : {}), text: metadata.toolInput == null ? text : JSON.stringify(redactReplyValue(metadata.toolInput), null, 2), ...(display ? { display } : {}) }];
  if (row.type === 'tool_result') {
    const output = text || (typeof metadata.toolResult === 'string' ? redactReplyText(metadata.toolResult) : typeof metadata.error === 'string' ? redactReplyText(metadata.error) : '');
    const blocks: RemoteReplyBlock[] = [{ blockId: id('output'), type: RemoteReplyBlockType.ToolOutput, toolCallId,
      ...(toolName ? { toolName } : {}), text: output, ...(display ? { display } : {}) }];
    if (typeof metadata.error === 'string' && metadata.error && metadata.error !== output) blocks.push({ blockId: id('error'), type: RemoteReplyBlockType.Error, text: redactReplyText(metadata.error) });
    return blocks;
  }
  if (row.type === 'system') {
    const detail = parseCoworkErrorDetail(metadata.errorDetail);
    const detailText = detail ? formatCoworkErrorDetailText(detail) : '';
    return [{ blockId: id('notice'), type: metadata.isError || metadata.error ? RemoteReplyBlockType.Error : RemoteReplyBlockType.Notice,
      text: [text, typeof metadata.error === 'string' && metadata.error !== text ? redactReplyText(metadata.error) : '', redactReplyText(detailText)].filter(Boolean).join('\n\n'), ...(display ? { display } : {}) }];
  }
  if (metadata.isThinking === true) return [{ blockId: id('thinking:0'), type: RemoteReplyBlockType.Thinking, text }];
  if (row.type === 'user') return [{ blockId: id('text:0'), type: RemoteReplyBlockType.Text, text: replyUserText(text, metadata, annotationText) }];
  const blocks: RemoteReplyBlock[] = [];
  const expression = /<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/gi;
  const fenced: Array<{ start: number; end: number }> = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/gm;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fence.exec(text))) {
    const close = new RegExp(`^ {0,3}${fenceMatch[1][0]}{${fenceMatch[1].length},}[^\\S\\r\\n]*$`, 'gm');
    close.lastIndex = fence.lastIndex;
    const end = close.exec(text);
    const range = { start: fenceMatch.index, end: end ? close.lastIndex : text.length };
    fenced.push(range); fence.lastIndex = range.end;
  }
  let offset = 0; let thinking = 0; let markdown = 0; let match: RegExpExecArray | null;
  while ((match = expression.exec(text))) {
    if (fenced.some(range => match!.index >= range.start && match!.index < range.end)) continue;
    if (match.index > offset) blocks.push({ blockId: id(`markdown:${markdown++}`), type: RemoteReplyBlockType.Markdown, text: text.slice(offset, match.index) });
    blocks.push({ blockId: id(`thinking:${thinking++}`), type: RemoteReplyBlockType.Thinking, text: match[1] });
    offset = expression.lastIndex;
  }
  if (offset < text.length || !blocks.length) blocks.push({ blockId: id(`markdown:${markdown}`), type: RemoteReplyBlockType.Markdown, text: text.slice(offset) });
  return blocks;
}
export function replyToolState(type: string, metadata: Record<string, any>): string {
  if (metadata.isCancelled === true || metadata.status === 'cancelled') return 'cancelled';
  if (metadata.status === 'waiting_user' || metadata.status === 'waiting_approval') return 'waiting_user';
  if (type !== 'tool_result' || metadata.isStreaming === true || metadata.isFinal === false) return 'running';
  return metadata.isError === true || Boolean(metadata.error) ? 'failed' : 'succeeded';
}
/** Chunk on Unicode scalar boundaries; byte offsets always use UTF-8, never JS string length. */
export function replyChunks(text: string): Array<{ sha256: string; sizeBytes: string; text: string }> {
  const result: Array<{ sha256: string; sizeBytes: string; text: string }> = [];
  const bytes = Buffer.from(text);
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + RemoteReply.ChunkBytes, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const chunk = bytes.subarray(start, end);
    result.push({ sha256: createHash('sha256').update(chunk).digest('hex'), sizeBytes: String(chunk.length), text: chunk.toString('utf8') });
    start = end;
  }
  return result;
}
/** Append events are only an encoding optimization; the stored projection remains a full message. */
export function replyAppendDelta(previous: Record<string, any> | undefined, next: Record<string, any>): Record<string, any> | null {
  if (!previous || previous.projectionVersion !== RemoteReply.ProjectionVersion || next.projectionVersion !== RemoteReply.ProjectionVersion) return null;
  if (!Array.isArray(previous.blocks) || previous.blocks.length !== next.blocks.length) return null;
  const before = JSON.parse(stableJson(previous)); const after = JSON.parse(stableJson(next));
  for (const field of ['revision', 'preview', 'status', 'displayOrdinal', 'originalContentBytes']) { delete before[field]; delete after[field]; }
  let delta: Record<string, any> | null = null;
  for (let index = 0; index < before.blocks.length; index++) {
    const oldBlock = before.blocks[index]; const newBlock = after.blocks[index];
    if (oldBlock.text === newBlock.text) continue;
    if (delta || typeof oldBlock.text !== 'string' || typeof newBlock.text !== 'string' || !newBlock.text.startsWith(oldBlock.text)) return null;
    const text = newBlock.text.slice(oldBlock.text.length);
    if (!text || Buffer.byteLength(text) > RemoteReply.ChunkBytes) return null;
    delta = { messageId: next.messageId, blockId: newBlock.blockId, baseRevision: previous.revision, revision: next.revision,
      operation: 'append', offsetBytes: String(Buffer.byteLength(oldBlock.text)), text, preview: next.preview, status: next.status,
      displayOrdinal: next.displayOrdinal, originalContentBytes: next.originalContentBytes };
    newBlock.text = oldBlock.text;
  }
  return delta && stableJson(before) === stableJson(after) && Buffer.byteLength(stableJson(delta)) <= RemoteReply.ChunkBytes ? delta : null;
}
