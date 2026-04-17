import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  net: {
    fetch: vi.fn(),
  },
}));

import { __openClawTokenProxyTestUtils } from './openclawTokenProxy';

describe('OpenClaw token proxy cowork session body handling', () => {
  test('injects session_id from a hidden text marker and removes the marker', () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const body = Buffer.from(JSON.stringify({
      model: 'deepseek-v3.2',
      messages: [
        {
          role: 'user',
          content: `<!-- lobsterai:cowork-session-id:${sessionId} -->\n\nhello`,
        },
      ],
    }));

    const rewritten = __openClawTokenProxyTestUtils.rewriteCoworkSessionBody(body);
    const parsed = JSON.parse(rewritten.toString('utf8')) as {
      session_id?: string;
      messages?: Array<{ content?: string }>;
    };

    expect(parsed.session_id).toBe(sessionId);
    expect(parsed.messages?.[0]?.content).toBe('hello');
  });

  test('injects session_id from an OpenAI text content part and removes the marker', () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const body = Buffer.from(JSON.stringify({
      model: 'deepseek-v3.2',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `<!-- lobsterai:cowork-session-id:${sessionId} -->\n\nhello`,
            },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc' },
            },
          ],
        },
      ],
    }));

    const rewritten = __openClawTokenProxyTestUtils.rewriteCoworkSessionBody(body);
    const parsed = JSON.parse(rewritten.toString('utf8')) as {
      session_id?: string;
      messages?: Array<{ content?: Array<{ text?: string }> }>;
    };

    expect(parsed.session_id).toBe(sessionId);
    expect(parsed.messages?.[0]?.content?.[0]?.text).toBe('hello');
    expect(parsed.messages?.[0]?.content?.[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc' },
    });
  });
});
