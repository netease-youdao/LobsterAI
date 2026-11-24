import { describe, expect, it } from 'vitest';

import { RemoteReply } from '../../shared/remote/reply';
import { isPublicReplyMessage, redactReplyText, redactReplyValue, replyAppendDelta, replyBlockId, replyBlocks, replyChunks, replyToolState } from './remoteReplyProjection';

const row = { id: 'message', type: 'assistant', content: '正文' };
describe('public reply projection', () => {
  it('omits renderer-hidden runtime notices and preserves public system errors', () => {
    expect(isPublicReplyMessage({ type: 'assistant', content: 'NO_REPLY' })).toBe(false);
    expect(isPublicReplyMessage({ type: 'system', content: 'compaction' })).toBe(false);
    expect(isPublicReplyMessage({ type: 'system', content: 'internal history', metadata: JSON.stringify({ kind: 'fork_compaction_summary' }) })).toBe(false);
    expect(isPublicReplyMessage({ type: 'system', content: 'Task failed', metadata: JSON.stringify({ error: 'Task failed' }) })).toBe(true);
  });
  it('retains exposed thinking and splits inline thinking in display order', () => {
    expect(replyBlocks(row, { isThinking: true })).toEqual([{ blockId: replyBlockId('message', 'thinking:0'), type: 'thinking', text: '正文' }]);
    expect(replyBlocks({ ...row, content: 'before<think>reason</think>after' }, {}).map(block => [block.type, block.text])).toEqual([
      ['markdown', 'before'], ['thinking', 'reason'], ['markdown', 'after'],
    ]);
    const code = '```html\n<thinking>literal</thinking>\n```\nvisible';
    expect(replyBlocks({ ...row, content: code }, {})).toEqual([{ blockId: replyBlockId('message', 'markdown:0'), type: 'markdown', text: code }]);
  });
  it('only emits valid stable identifiers and typed public display fields', () => {
    const block = replyBlocks({ ...row, id: 'UUID:legacy' }, { isThinking: true })[0];
    expect(block.blockId).toMatch(/^[a-f0-9]{32}$/);
    const output = replyBlocks({ ...row, type: 'system' }, { status: 25, progress: 'wrong', isMediaStatusPolling: 'true', kind: 'internal' })[0];
    expect(output.display).toBeUndefined();
  });
  it('keeps valid tool IDs and maps invalid IDs stably without truncation collisions', () => {
    const block = (value: string, type = 'tool_use') => replyBlocks({ ...row, type }, { toolUseId: value })[0];
    for (const value of ['call_valid-1', 'x'.repeat(64)]) expect(block(value).toolCallId).toBe(value);
    const invalid = ['call:1', 'call/1', 'x'.repeat(65), 'x'.repeat(64) + 'y'];
    const ids = invalid.map(value => block(value).toolCallId);
    expect(new Set(ids).size).toBe(invalid.length);
    for (const [index, value] of invalid.entries()) {
      expect(ids[index]).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(block(value, 'tool_result').toolCallId).toBe(ids[index]);
    }
  });
  it('masks credential fields while retaining ordinary paths, tool input and result text', () => {
    const blocks = replyBlocks({ ...row, type: 'tool_use', content: 'Using tool' }, { toolUseId: 'call', toolInput: { file_path: '/Users/name/report.md', headers: { Authorization: 'Bearer private' }, apiKey: 'secret' } }, 'Edit');
    expect(blocks[0]).toMatchObject({ type: 'tool_input', toolCallId: 'call', toolName: 'Edit' });
    expect(blocks[0].text).toContain('/Users/name/report.md'); expect(blocks[0].text).not.toContain('private'); expect(blocks[0].text).not.toContain('secret');
    expect(redactReplyText('Authorization: Bearer token123')).not.toContain('token123');
    expect(redactReplyValue({ path: 'file:///tmp/report.md', password: 'pwd' })).toEqual({ path: 'file:///tmp/report.md', password: '[redacted]' });
    expect(replyBlocks({ ...row, type: 'tool_result', content: 'new output' }, { toolResult: 'stale output' })[0].text).toBe('new output');
  });
  it('keeps partial tools running and preserves visible media and system status only', () => {
    expect(replyToolState('tool_result', { isStreaming: true })).toBe('running');
    expect(replyToolState('tool_result', { isFinal: false })).toBe('running');
    expect(replyToolState('tool_result', { isFinal: true })).toBe('succeeded');
    expect(replyToolState('tool_result', { error: 'failed' })).toBe('failed');
    const result = replyBlocks({ ...row, type: 'tool_result' }, { toolResultDetails: { status: 'running', mediaType: 'image', progress: 20, apiKey: 'hidden' } });
    expect(result[0].display).toEqual({ status: 'running', mediaType: 'image', progress: 20 });
    expect(replyBlocks({ ...row, type: 'system', content: 'Compacting' }, { kind: 'context_compaction', mode: 'auto', status: 'running' })[0]).toMatchObject({ type: 'notice', display: { kind: 'context_compaction', mode: 'auto', status: 'running' } });
  });
  it('chunks mixed UTF-8 scalars without corruption or exceeding the byte limit', () => {
    const text = 'a'.repeat(RemoteReply.ChunkBytes - 1) + '😀中文'.repeat(9000);
    const chunks = replyChunks(text);
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text);
    expect(chunks.every(chunk => Number(chunk.sizeBytes) <= RemoteReply.ChunkBytes && !chunk.text.includes('�'))).toBe(true);
  });
  it('emits append only for a compatible single block and bounds escaped payload bytes', () => {
    const previous = { messageId: 'message', projectionVersion: 4, revision: '1', preview: '中', status: 'streaming', displayOrdinal: '1', originalContentBytes: '10', blocks: [{ blockId: 'b', type: 'markdown', text: '中' }] };
    const next = { ...previous, revision: '2', preview: '中😀', originalContentBytes: '14', blocks: [{ ...previous.blocks[0], text: '中😀' }] };
    expect(replyAppendDelta(previous, next)).toMatchObject({ baseRevision: '1', revision: '2', offsetBytes: '3', text: '😀' });
    expect(replyAppendDelta(previous, { ...next, blocks: [{ ...next.blocks[0], text: 'rewritten' }] })).toBeNull();
    expect(replyAppendDelta(previous, { ...next, blocks: [{ ...next.blocks[0], text: '中' + '\u0001'.repeat(7000) }] })).toBeNull();
  });
});
