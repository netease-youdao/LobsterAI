import { describe, expect, test } from 'vitest';

import {
  formatSideChatApprovalPreview,
  getSideChatDisplayTitle,
} from './sideChatHelpers';

describe('sideChatHelpers', () => {
  test('getSideChatDisplayTitle numbers side chats sequentially by creation order', () => {
    const summaries = [
      { id: 'sc-2', createdAt: 2000 },
      { id: 'sc-1', createdAt: 1000 },
      { id: 'sc-3', createdAt: 3000 },
    ];
    expect(getSideChatDisplayTitle('sc-1', summaries, '侧边聊天')).toBe('侧边聊天 1');
    expect(getSideChatDisplayTitle('sc-2', summaries, '侧边聊天')).toBe('侧边聊天 2');
    expect(getSideChatDisplayTitle('sc-3', summaries, '侧边聊天')).toBe('侧边聊天 3');
    expect(getSideChatDisplayTitle('sc-1', [{ id: 'sc-1', createdAt: 1000 }], 'Side chat')).toBe('Side chat 1');
  });

  test('formatSideChatApprovalPreview prioritizes command/path fields and truncates long values', () => {
    expect(formatSideChatApprovalPreview({ command: 'git status', callId: 'c1' })).toBe('git status');
    expect(formatSideChatApprovalPreview({ file_path: '/tmp/a.ts' })).toBe('/tmp/a.ts');
    const longCommand = 'x'.repeat(500);
    const preview = formatSideChatApprovalPreview({ command: longCommand });
    expect(preview.length).toBeLessThanOrEqual(420);
    expect(preview.endsWith('…')).toBe(true);
    expect(formatSideChatApprovalPreview({ callId: 'c1', toolName: 'bash' })).toBe('');
  });
});
