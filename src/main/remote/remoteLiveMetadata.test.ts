import { describe, expect, it } from 'vitest';

import { CoworkSystemMessageKind } from '../../common/coworkSystemMessages';
import { stableJson } from './canonical';
import { liveMetadataToolId, normalizeLiveMetadata, RemoteLiveEncodingError as ErrorCode, RemoteLiveEncodingLimits as Limits, RemoteLiveMetadataMode } from './remoteLiveMetadata';
import { replyToolState } from './remoteReplyProjection';

const row = { id: 'message', type: 'tool_result', content: 'File saved.' };
const normalize = (value: unknown, message = row) => {
  const raw = JSON.stringify(value);
  return normalizeLiveMetadata(raw, Buffer.byteLength(raw), RemoteLiveMetadataMode.Message, message);
};

describe('bounded live metadata', () => {
  it('drops large private diff/patch fields while preserving the public output and exact tool identity', () => {
    const value = { toolUseId: 'call', remoteRunId: 'run', isFinal: true, isError: false,
      toolResultDetails: { diff: '中'.repeat(11000), patch: '文'.repeat(11000), changed: true }, secret: 'private-secret' };
    const result = normalize(value);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(Limits.MetadataBytes);
    expect(result.normalizedBytes).toBeLessThan(Limits.MetadataBytes);
    expect(result.publicFieldsOmitted).toBe(false);
    expect(result.metadata).toMatchObject({ toolUseId: 'call', remoteRunId: 'run', isFinal: true, isError: false });
    expect(result.blocks(row)).toMatchObject([{ type: 'tool_output', toolCallId: 'call', text: 'File saved.' }]);
    expect(JSON.stringify(result.metadata)).not.toMatch(/diff|patch|private-secret/);
  });

  it('keeps error, thinking, display precedence and redaction semantics', () => {
    const message = { id: 'm', type: 'tool_result', content: 'Authorization: Bearer private-token' };
    const result = normalize({ toolCallId: 'call', status: 'running', error: 'password=hidden',
      mediaStatusDetails: { status: 'processing', progress: 30 }, toolResultDetails: { status: 'done', progress: 100, diff: 'private' } }, message);
    expect(result.blocks(message)[0]).toMatchObject({ display: { status: 'done', progress: 100 } });
    expect(stableJson(result.blocks(message))).not.toMatch(/private-token|password=hidden/);
    const thinking = { id: 'think', type: 'assistant', content: 'Thinking' };
    expect(normalize({ isThinking: true }, thinking).blocks(thinking)[0].type).toBe('thinking');
  });

  it('retains hidden runtime notices and NO_REPLY filters despite large irrelevant fields', () => {
    const hidden = { id: 'system', type: 'system', content: 'Internal summary' };
    const metadata = { kind: CoworkSystemMessageKind.ForkCompactionSummary, toolResultDetails: { diff: 'x'.repeat(40000) } };
    expect(normalize(metadata, hidden).isPublic(hidden)).toBe(false);
    const silent = { id: 'silent', type: 'assistant', content: 'NO_REPLY' };
    expect(normalize({}, silent).isPublic(silent)).toBe(false);
    const empty = { id: 'empty', type: 'system', content: '' };
    expect(normalize({}, empty).isPublic(empty)).toBe(false);
    expect(normalize({ error: 'visible error' }, empty).isPublic(empty)).toBe(true);
  });

  it('bounds normalized public metadata without losing the original blocks needed for exact sizing', () => {
    const input = { id: 'input', type: 'tool_use', content: 'Edit' };
    const result = normalize({ toolUseId: 'call', toolInput: { patch: '中'.repeat(12000) }, remoteRunId: 'run' }, input);
    expect(result.publicFieldsOmitted).toBe(true);
    expect(result.normalizedBytes).toBeLessThanOrEqual(Limits.MetadataBytes);
    expect(result.metadata).not.toHaveProperty('toolInput');
    expect(result.blocks(input)[0].text).toContain('中'.repeat(12000));
    expect(result.metadata.remoteRunId).toBe('run');
  });

  it.each([0, 1])('enforces the normalized metadata UTF-8 budget at the exact boundary plus %i byte', extra => {
    const input = { id: 'input', type: 'tool_use', content: 'Edit' };
    const prefix = '中😀"\\\n';
    const baseline = normalize({ toolUseId: 'call', toolInput: { patch: prefix } }, input);
    const padding = Limits.MetadataBytes - baseline.normalizedBytes;
    const patch = prefix + 'x'.repeat(padding + extra);
    const original = { ...baseline.metadata, toolInput: { patch } };
    expect(Buffer.byteLength(stableJson(original))).toBe(Limits.MetadataBytes + extra);
    const result = normalize({ toolUseId: 'call', toolInput: { patch } }, input);
    expect(result.publicFieldsOmitted).toBe(extra === 1);
    expect(result.normalizedBytes).toBeLessThanOrEqual(Limits.MetadataBytes);
    if (!extra) expect(result.normalizedBytes).toBe(Limits.MetadataBytes);
    expect(result.blocks(input)[0].text).toBe(JSON.stringify({ patch }, null, 2));
  });

  it('does not downgrade a complete short output for an unused oversized toolResult fallback', () => {
    const result = normalize({ toolUseId: 'call', toolResult: 'x'.repeat(40000) });
    expect(result.publicFieldsOmitted).toBe(false);
    expect(result.blocks(row)[0].text).toBe(row.content);
  });

  it.each(['remoteRunId', 'remoteCommandId', 'toolUseId', 'toolCallId'])('rejects invalid %s without truncating or inventing an identity', key => {
    for (const value of ['x'.repeat(65), 'id/private', 42, { id: 'run' }])
      expect(() => normalize({ [key]: value })).toThrow(ErrorCode.IdentityInvalid);
    expect(normalize({ [key]: 'x'.repeat(64) }).metadata[key]).toBe('x'.repeat(64));
    expect(liveMetadataToolId({ toolUseId: null, toolCallId: 'fallback' }, 'message')).toBe('fallback');
    expect(() => liveMetadataToolId({}, 'bad/id')).toThrow(ErrorCode.IdentityInvalid);
  });

  it('rejects oversized, malformed, mismatched and non-object raw metadata with fixed safe codes', () => {
    expect(() => normalizeLiveMetadata(null, Limits.RawMetadataBytes + 1)).toThrow(ErrorCode.RawMetadataBudget);
    expect(() => normalizeLiveMetadata('{}', 1)).toThrow(ErrorCode.MetadataInvalid);
    for (const raw of ['{"secret":', '[]', 'null', '42'])
      expect(() => normalizeLiveMetadata(raw, Buffer.byteLength(raw))).toThrow(ErrorCode.MetadataInvalid);
    expect(normalizeLiveMetadata(null, null).normalizedBytes).toBeLessThan(Limits.MetadataBytes);
  });

  it('limits selected public nesting and rejects non-finite values, while ignoring private nested data', () => {
    let deep: unknown = 'x';
    for (let index = 0; index <= Limits.MetadataDepth; index++) deep = { nested: deep };
    const input = { id: 'input', type: 'tool_use', content: '' };
    expect(() => normalize({ toolInput: deep }, input)).toThrow(ErrorCode.MetadataStructureBudget);
    expect(() => normalize({ unused: deep }, input)).not.toThrow();
    const raw = '{"toolInput":{"amount":1e999}}';
    expect(() => normalizeLiveMetadata(raw, Buffer.byteLength(raw), RemoteLiveMetadataMode.Message, input)).toThrow(ErrorCode.MetadataInvalid);
  });

  it.each([
    [{ isFinal: true, isError: false }, 'succeeded'],
    [{ isFinal: true, error: 'x'.repeat(40000) }, 'failed'],
    [{ isCancelled: true }, 'cancelled'],
    [{ status: 'waiting_approval' }, 'waiting_user'],
    [{ isStreaming: true }, 'running'],
  ])('preserves tool state without copying public content into its distinct schema', (state, expected) => {
    const raw = JSON.stringify({ ...state, toolUseId: 'call', toolName: 'Edit', toolInput: 'x'.repeat(40000) });
    const result = normalizeLiveMetadata(raw, Buffer.byteLength(raw), RemoteLiveMetadataMode.Tool);
    expect(replyToolState('tool_result', result.metadata)).toBe(expected);
    expect(result.normalizedBytes).toBeLessThan(Limits.MetadataBytes);
    expect(result.metadata).not.toHaveProperty('toolInput');
  });
});
