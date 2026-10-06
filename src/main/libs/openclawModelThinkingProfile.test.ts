import { describe, expect, test } from 'vitest';

import { parseThinkingProfileMap } from '../../../openclaw-extensions/lobsterai-model-compat/thinkingProfileMapping';

describe('parseThinkingProfileMap', () => {
  test('keeps valid model profiles and drops malformed entries', () => {
    expect(parseThinkingProfileMap({
      'lobsterai-server/deepseek-v4-flash': {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
        requestOptionsVersion: 1,
      },
      'missing-separator': {
        options: [{ level: 'high', openclawLevel: 'high' }],
        defaultLevel: 'high',
      },
      'lobsterai-server/invalid': {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'future', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'future',
      },
    })).toEqual({
      'lobsterai-server/deepseek-v4-flash': {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
        requestOptionsVersion: 1,
      },
    });
  });
});
