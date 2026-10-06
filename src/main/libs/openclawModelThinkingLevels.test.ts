import { afterEach, describe, expect, test } from 'vitest';

import {
  clearServerModelMetadata,
  updateServerModelMetadata,
} from './claudeSettings';
import { resolveOpenClawThinkingLevelForModel } from './openclawModelThinkingLevels';

describe('resolveOpenClawThinkingLevelForModel', () => {
  afterEach(() => {
    clearServerModelMetadata();
  });

  test('maps a server product level to its configured OpenClaw carrier', () => {
    updateServerModelMetadata([{
      modelId: 'deepseek-v4-flash',
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
    }]);

    expect(resolveOpenClawThinkingLevelForModel(
      'lobsterai-server/deepseek-v4-flash',
      'max',
    )).toBe('xhigh');
  });

  test('does not rewrite other providers or unconfigured levels', () => {
    expect(resolveOpenClawThinkingLevelForModel('openai/gpt-5', 'max')).toBe('max');
    expect(resolveOpenClawThinkingLevelForModel(
      'lobsterai-server/deepseek-v4-flash',
      'high',
    )).toBe('high');
  });

  test('falls back to the latest server default when a persisted level is removed', () => {
    updateServerModelMetadata([{
      modelId: 'deepseek-v4-flash',
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
        ],
        defaultLevel: 'high',
      },
    }]);

    expect(resolveOpenClawThinkingLevelForModel(
      'lobsterai-server/deepseek-v4-flash',
      'max',
    )).toBe('high');
  });
});
