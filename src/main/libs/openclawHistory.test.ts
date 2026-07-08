import { describe, expect, test } from 'vitest';

import { isInternalCompactionSystemText } from '../../common/coworkSystemMessages';
import {
  buildScheduledReminderSystemMessage,
  extractGatewayHistoryEntries,
  extractGatewayHistoryEntry,
  extractGatewayMessageText,
  extractGatewayMessageThinking,
  isHeartbeatAckText,
  isHeartbeatPromptText,
  isPreCompactionMemoryFlushPromptText,
  isSilentReplyPrefixText,
  isSilentReplyText,
  stripTrailingSilentReplyTail,
  stripTrailingSilentReplyToken,
} from './openclawHistory';

describe('openclawHistory', () => {
  test('extracts plain text content blocks', () => {
    expect(
      extractGatewayMessageText({
        content: [{ type: 'text', text: 'hello world' }],
      })
    ).toBe('hello world');
  });

  test('extracts output_text style content blocks', () => {
    expect(
      extractGatewayMessageText({
        content: [{ type: 'output_text', text: 'gemini output' }],
      })
    ).toBe('gemini output');
  });

  test('extracts nested parts content blocks', () => {
    expect(
      extractGatewayMessageText({
        content: {
          parts: [
            { text: 'first line' },
            { type: 'toolCall', name: 'message', arguments: { action: 'send' } },
            { text: 'second line' },
          ],
        },
      })
    ).toBe('first line\nsecond line');
  });

  test('extracts top-level OpenAI-compatible reasoning fields as thinking', () => {
    expect(
      extractGatewayMessageThinking({
        role: 'assistant',
        reasoning_content: 'inspect the request payload',
        content: [{ type: 'text', text: 'done' }],
      })
    ).toBe('inspect the request payload');
  });

  test('builds history entry from assistant message with non-anthropic text shape', () => {
    expect(
      extractGatewayHistoryEntry({
        role: 'assistant',
        content: [{ type: 'output_text', text: 'final answer' }],
      })
    ).toEqual({
      role: 'assistant',
      text: 'final answer',
    });
  });

  test('keeps gateway message timestamps when present', () => {
    expect(
      extractGatewayHistoryEntry({
        role: 'user',
        content: 'hello',
        createdAt: '2026-05-09T10:20:30.000Z',
      })
    ).toEqual({
      role: 'user',
      text: 'hello',
      timestamp: Date.parse('2026-05-09T10:20:30.000Z'),
    });
  });

  test('extracts OpenClaw 6.1 media path metadata from user messages', () => {
    expect(
      extractGatewayHistoryEntry({
        role: 'user',
        content: '[Image]\nDescription:\nA sticker.',
        MediaPath: String.raw`C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\state\media\inbound\a.jpg`,
        MediaPaths: [
          String.raw`C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\state\media\inbound\a.jpg`,
          String.raw`C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\state\media\inbound\b.png`,
        ],
        MediaType: 'image/jpeg',
        MediaTypes: ['image/jpeg', 'image/png'],
      })
    ).toEqual({
      role: 'user',
      text: '[Image]\nDescription:\nA sticker.',
      mediaAttachments: [
        {
          localPath: String.raw`C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\state\media\inbound\a.jpg`,
          mimeType: 'image/jpeg',
        },
        {
          localPath: String.raw`C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\state\media\inbound\b.png`,
          mimeType: 'image/png',
        },
      ],
    });
  });

  test('joins text content blocks separated by toolCall blocks', () => {
    const text = extractGatewayMessageText({
      content: [
        { type: 'text', text: 'First line' },
        { type: 'toolCall', name: 'cron', arguments: { action: 'add' } },
        { type: 'text', text: 'Second line' },
      ],
    });
    expect(text).toBe('First line\nSecond line');
  });

  test('keeps system messages', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'system',
      content: [{ type: 'text', text: 'Reminder fired' }],
    });
    expect(entry).toEqual({ role: 'system', text: 'Reminder fired' });
  });

  test('filters internal compaction system labels', () => {
    expect(isInternalCompactionSystemText('Compaction')).toBe(true);
    expect(isInternalCompactionSystemText('--- COMPACTION ---')).toBe(true);
    expect(
      extractGatewayHistoryEntry({
        role: 'system',
        content: [{ type: 'text', text: 'Compaction' }],
      })
    ).toBeNull();
    expect(
      extractGatewayHistoryEntry({
        role: 'system',
        content: [{ type: 'text', text: '--- COMPACTION ---' }],
      })
    ).toBeNull();
  });

  test('keeps user-visible system messages that mention compaction', () => {
    expect(isInternalCompactionSystemText('Context compaction completed')).toBe(false);
    expect(
      extractGatewayHistoryEntry({
        role: 'system',
        content: [{ type: 'text', text: 'Context compaction completed' }],
      })
    ).toEqual({ role: 'system', text: 'Context compaction completed' });
  });

  test('filters pure heartbeat ack assistant messages', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'assistant',
      content: [{ type: 'text', text: 'HEARTBEAT_OK' }],
    });
    expect(entry).toBeNull();
  });

  test('filters pure silent token assistant messages', () => {
    expect(
      extractGatewayHistoryEntry({
        role: 'assistant',
        content: [{ type: 'text', text: 'NO_REPLY' }],
      })
    ).toBeNull();
    expect(
      extractGatewayHistoryEntry({
        role: 'assistant',
        content: [{ type: 'text', text: '`no_reply`' }],
      })
    ).toBeNull();
  });

  test('filters pre-compaction memory flush user messages', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'user',
      content: `Pre-compaction memory flush. Store durable memories only in memory/2026-05-09.md (create memory/ if needed). Treat workspace bootstrap/reference files such as MEMORY.md as read-only during this flush. If nothing to store, reply with NO_REPLY.
Current time: Saturday, May 9th, 2026 - 11:57 (Asia/Shanghai) / 2026-05-09 03:57 UTC`,
    });
    expect(entry).toBeNull();
  });

  test('filters pure heartbeat ack system messages with punctuation wrappers', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'system',
      content: [{ type: 'text', text: '("HEARTBEAT_OK")' }],
    });
    expect(entry).toBeNull();
  });

  test('filters heartbeat prompt user messages', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'user',
      content: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.
When reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md.
Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`,
    });
    expect(entry).toBeNull();
  });

  test('filters unsupported roles and empty messages', () => {
    const entries = extractGatewayHistoryEntries([
      { role: 'user', content: 'Set a reminder' },
      { role: 'system', content: [{ type: 'text', text: 'Reminder fired' }] },
      { role: 'tool', content: 'ignored' },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'cron', arguments: {} }] },
      { role: 'assistant', content: 'Done' },
    ]);
    expect(entries).toEqual([
      { role: 'user', text: 'Set a reminder' },
      { role: 'system', text: 'Reminder fired' },
      { role: 'assistant', text: 'Done' },
    ]);
  });

  test('remaps scheduled reminder prompts to system messages', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'user',
      content: `A scheduled reminder has been triggered. The reminder content is:

⏰ 提醒：该去买菜了！

Handle this reminder internally. Do not relay it to the user unless explicitly requested.
Current time: Sunday, March 15th, 2026 — 11:27 (Asia/Shanghai)`,
    });
    expect(entry).toEqual({ role: 'system', text: '⏰ 提醒：该去买菜了！' });
  });

  test('remaps plain scheduled reminder text to a system message', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'user',
      content: '⏰ 提醒：该去钉钉打卡啦！别忘了打卡哦～',
    });
    expect(entry).toEqual({ role: 'system', text: '⏰ 提醒：该去钉钉打卡啦！别忘了打卡哦～' });
  });

  test('buildScheduledReminderSystemMessage returns null for regular user text', () => {
    expect(buildScheduledReminderSystemMessage('普通聊天消息')).toBeNull();
  });

  test('isHeartbeatAckText matches token with lightweight wrappers only', () => {
    expect(isHeartbeatAckText('HEARTBEAT_OK')).toBe(true);
    expect(isHeartbeatAckText('`HEARTBEAT_OK`')).toBe(true);
    expect(isHeartbeatAckText('HEARTBEAT_OK: all clear')).toBe(false);
  });

  test('isHeartbeatPromptText matches canonical heartbeat instructions only', () => {
    expect(
      isHeartbeatPromptText(`Read HEARTBEAT.md if it exists.
When reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md.
Do not infer or repeat old tasks from prior chats.
If nothing needs attention, reply HEARTBEAT_OK.`)
    ).toBe(true);
    expect(isHeartbeatPromptText('Please read README.md and reply OK.')).toBe(false);
  });

  test('silent and memory flush detectors are narrow', () => {
    expect(isSilentReplyText('NO_REPLY')).toBe(true);
    expect(isSilentReplyPrefixText('NO_REP')).toBe(true);
    expect(isSilentReplyPrefixText('NO_REPLY')).toBe(false);
    expect(isSilentReplyPrefixText('NO_REPLY after saving memory')).toBe(false);
    expect(isSilentReplyText('NO_REPLY after saving memory')).toBe(false);
    expect(isPreCompactionMemoryFlushPromptText(`Pre-compaction memory flush.
Store durable memories only in memory/2026-05-09.md.
If nothing to store, reply with NO_REPLY.`)).toBe(true);
    expect(isPreCompactionMemoryFlushPromptText('Please write a memory summary.')).toBe(false);
  });

  test('isSilentReplyText matches exact NO_REPLY token only', () => {
    expect(isSilentReplyText('NO_REPLY')).toBe(true);
    expect(isSilentReplyText('  NO_REPLY  ')).toBe(true);
    expect(isSilentReplyText('no_reply')).toBe(true);
    expect(isSilentReplyText('This is a message ending with NO_REPLY')).toBe(false);
    expect(isSilentReplyText('NO_REPLY: explanation')).toBe(false);
    expect(isSilentReplyText('NO')).toBe(false);
    expect(isSilentReplyText('')).toBe(false);
  });

  test('shouldSuppressHeartbeatText suppresses NO_REPLY for assistant and system', () => {
    // Imported at module level, test via extractGatewayHistoryEntry
    const entry = extractGatewayHistoryEntry({
      role: 'assistant',
      content: [{ type: 'text', text: 'NO_REPLY' }],
    });
    expect(entry).toBeNull();
  });

  test('shouldSuppressHeartbeatText does not suppress user NO_REPLY', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'user',
      content: 'NO_REPLY',
    });
    expect(entry).toEqual({ role: 'user', text: 'NO_REPLY' });
  });

  test('isSilentReplyPrefixText matches streaming prefix fragments', () => {
    expect(isSilentReplyPrefixText('NO')).toBe(true);
    expect(isSilentReplyPrefixText('NO_')).toBe(true);
    expect(isSilentReplyPrefixText('NO_R')).toBe(true);
    expect(isSilentReplyPrefixText('NO_RE')).toBe(true);
    expect(isSilentReplyPrefixText('NO_REP')).toBe(true);
    expect(isSilentReplyPrefixText('NO_REPL')).toBe(true);
  });

  test('isSilentReplyPrefixText rejects non-prefix text', () => {
    expect(isSilentReplyPrefixText('')).toBe(false);
    expect(isSilentReplyPrefixText('N')).toBe(false);
    expect(isSilentReplyPrefixText('No')).toBe(false);
    expect(isSilentReplyPrefixText('NO,')).toBe(false);
    expect(isSilentReplyPrefixText('NOT')).toBe(false);
    expect(isSilentReplyPrefixText('hello')).toBe(false);
  });

  describe('stripTrailingSilentReplyToken', () => {
    test('strips trailing NO_REPLY after newline', () => {
      expect(stripTrailingSilentReplyToken('Content here.\n\nNO_REPLY')).toBe('Content here.');
    });

    test('strips trailing NO_REPLY with extra whitespace', () => {
      expect(stripTrailingSilentReplyToken('Content here.\n  NO_REPLY  ')).toBe('Content here.');
    });

    test('strips case-insensitively', () => {
      expect(stripTrailingSilentReplyToken('Content\n\nno_reply')).toBe('Content');
    });

    test('does not strip NO_REPLY in the middle of text', () => {
      const input = 'The token NO_REPLY is used.\nMore text.';
      expect(stripTrailingSilentReplyToken(input)).toBe(input);
    });

    test('does not strip when NO_REPLY is the entire message', () => {
      expect(stripTrailingSilentReplyToken('NO_REPLY')).toBe('NO_REPLY');
    });

    test('returns empty string when stripping leaves nothing', () => {
      expect(stripTrailingSilentReplyToken('\nNO_REPLY')).toBe('');
    });

    test('does not modify normal text', () => {
      const input = 'Normal response without the token.';
      expect(stripTrailingSilentReplyToken(input)).toBe(input);
    });
  });

  describe('stripTrailingSilentReplyTail', () => {
    test('strips complete trailing NO_REPLY', () => {
      expect(stripTrailingSilentReplyTail('Content\n\nNO_REPLY')).toBe('Content');
    });

    test('strips partial prefix NO', () => {
      expect(stripTrailingSilentReplyTail('Content\nNO')).toBe('Content');
    });

    test('strips partial prefix NO_', () => {
      expect(stripTrailingSilentReplyTail('Content\nNO_')).toBe('Content');
    });

    test('strips partial prefix NO_R', () => {
      expect(stripTrailingSilentReplyTail('Content\nNO_R')).toBe('Content');
    });

    test('strips partial prefix NO_RE', () => {
      expect(stripTrailingSilentReplyTail('Content\nNO_RE')).toBe('Content');
    });

    test('strips partial prefix NO_REP', () => {
      expect(stripTrailingSilentReplyTail('Content\nNO_REP')).toBe('Content');
    });

    test('strips partial prefix NO_REPL', () => {
      expect(stripTrailingSilentReplyTail('Content\nNO_REPL')).toBe('Content');
    });

    test('does not strip NO without preceding newline', () => {
      expect(stripTrailingSilentReplyTail('say NO')).toBe('say NO');
    });

    test('does not strip non-matching tail', () => {
      expect(stripTrailingSilentReplyTail('Content\nNOT')).toBe('Content\nNOT');
      expect(stripTrailingSilentReplyTail('Content\nNORMAL')).toBe('Content\nNORMAL');
    });

    test('does not modify normal text', () => {
      const input = 'Normal response.';
      expect(stripTrailingSilentReplyTail(input)).toBe(input);
    });
  });

  test('extractGatewayHistoryEntry strips trailing NO_REPLY from assistant', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'assistant',
      content: [{ type: 'text', text: 'Background notifications handled.\n\nNO_REPLY' }],
    });
    expect(entry).toEqual({
      role: 'assistant',
      text: 'Background notifications handled.',
    });
  });

  test('extractGatewayHistoryEntry does not strip trailing NO_REPLY from user', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'user',
      content: 'Some user text\n\nNO_REPLY',
    });
    expect(entry).toEqual({
      role: 'user',
      text: 'Some user text\n\nNO_REPLY',
    });
  });

  test('extractGatewayHistoryEntry returns null when stripping leaves empty text', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'assistant',
      content: [{ type: 'text', text: '\nNO_REPLY' }],
    });
    expect(entry).toBeNull();
  });
});
