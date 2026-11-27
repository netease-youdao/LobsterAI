import { describe, expect, test } from 'vitest';

import { CoworkSideChatStatus } from '../../../shared/cowork/sideChat';
import {
  formatSideChatApprovalPreview,
  getOpenSideChatTabTitle,
  getSideChatDisplayTitle,
  getSideChatPromoteEligibility,
  isDefaultSideChatTitle,
} from './sideChatHelpers';

describe('sideChatHelpers', () => {
  test('isDefaultSideChatTitle recognizes default generated titles and empty values', () => {
    expect(isDefaultSideChatTitle('')).toBe(true);
    expect(isDefaultSideChatTitle('   ')).toBe(true);
    expect(isDefaultSideChatTitle('Side chat')).toBe(true);
    expect(isDefaultSideChatTitle('Side chat 1')).toBe(true);
    expect(isDefaultSideChatTitle('侧边聊天 2')).toBe(true);
    expect(isDefaultSideChatTitle('排查登录超时的思路')).toBe(false);
    expect(isDefaultSideChatTitle('Side chat notes')).toBe(false);
  });

  test('getOpenSideChatTabTitle omits ordinal for a single open tab and numbers multiple open tabs sequentially', () => {
    expect(getOpenSideChatTabTitle(0, 1, '侧边聊天')).toBe('侧边聊天');
    expect(getOpenSideChatTabTitle(0, 1, 'Side chat')).toBe('Side chat');
    expect(getOpenSideChatTabTitle(0, 2, '侧边聊天')).toBe('侧边聊天 1');
    expect(getOpenSideChatTabTitle(1, 2, '侧边聊天')).toBe('侧边聊天 2');
    expect(getOpenSideChatTabTitle(2, 3, '侧边聊天')).toBe('侧边聊天 3');
  });

  test('getSideChatDisplayTitle prefers custom renamed titles and falls back to localized ordinals', () => {
    const summaries = [
      { id: 'sc-2', createdAt: 2000, title: '接口报错排查' },
      { id: 'sc-1', createdAt: 1000, title: 'Side chat 1' },
      { id: 'sc-3', createdAt: 3000, title: 'Side chat 3' },
    ];
    expect(getSideChatDisplayTitle('sc-1', summaries, '侧边聊天')).toBe('侧边聊天 1');
    expect(getSideChatDisplayTitle('sc-2', summaries, '侧边聊天')).toBe('接口报错排查');
    expect(getSideChatDisplayTitle('sc-3', summaries, '侧边聊天')).toBe('侧边聊天 3');
    expect(getSideChatDisplayTitle('sc-1', [{ id: 'sc-1', createdAt: 1000 }], 'Side chat')).toBe('Side chat 1');
  });

  test('getSideChatPromoteEligibility enforces idle and non-empty requirements', () => {
    expect(getSideChatPromoteEligibility(null)).toEqual({
      allowed: false,
      reasonKey: 'coworkSideChatPromoteEmptyHint',
    });
    expect(getSideChatPromoteEligibility({
      status: CoworkSideChatStatus.Running,
      messageCount: 2,
    })).toEqual({
      allowed: false,
      reasonKey: 'coworkSideChatPromoteRunningHint',
    });
    expect(getSideChatPromoteEligibility({
      status: CoworkSideChatStatus.Idle,
      messageCount: 0,
    })).toEqual({
      allowed: false,
      reasonKey: 'coworkSideChatPromoteEmptyHint',
    });
    expect(getSideChatPromoteEligibility({
      status: CoworkSideChatStatus.Idle,
      messageCount: 2,
    })).toEqual({ allowed: true });
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
