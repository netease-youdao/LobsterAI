import { describe, expect, test } from 'vitest';

import {
  getModelThinkingLevels,
  ModelThinkingLevel,
  OpenClawThinkingLevel,
  parseModelThinkingConfig,
  resolveOpenClawThinkingLevel,
  resolveProductThinkingLevel,
} from './modelThinking';

describe('parseModelThinkingConfig', () => {
  test('accepts canonical levels in server order', () => {
    expect(parseModelThinkingConfig({
      options: [
        { level: 'off', openclawLevel: 'off' },
        { level: 'high', openclawLevel: 'high' },
        { level: 'max', openclawLevel: 'xhigh' },
      ],
      defaultLevel: 'high',
    })).toEqual({
      options: [
        { level: ModelThinkingLevel.Off, openclawLevel: OpenClawThinkingLevel.Off },
        { level: ModelThinkingLevel.High, openclawLevel: OpenClawThinkingLevel.High },
        { level: ModelThinkingLevel.Max, openclawLevel: OpenClawThinkingLevel.XHigh },
      ],
      defaultLevel: ModelThinkingLevel.High,
    });
  });

  test.each([
    null,
    { options: [], defaultLevel: 'high' },
    { options: [{ level: 'off', openclawLevel: 'off' }], defaultLevel: 'off' },
    {
      options: [
        { level: 'high', openclawLevel: 'high' },
        { level: 'high', openclawLevel: 'xhigh' },
      ],
      defaultLevel: 'high',
    },
    {
      options: [
        { level: 'high', openclawLevel: 'high' },
        { level: 'max', openclawLevel: 'high' },
      ],
      defaultLevel: 'high',
    },
    { options: [{ level: 'high', openclawLevel: 'max' }], defaultLevel: 'high' },
    { options: [{ level: 'off', openclawLevel: 'high' }], defaultLevel: 'off' },
    { options: [{ level: 'high', openclawLevel: 'high' }], defaultLevel: 'max' },
    { options: [{ level: 'future', openclawLevel: 'high' }], defaultLevel: 'future' },
  ])('rejects malformed config %#', (value) => {
    expect(parseModelThinkingConfig(value)).toBeUndefined();
  });

  test('maps product and OpenClaw levels in both directions', () => {
    const config = parseModelThinkingConfig({
      options: [
        { level: 'off', openclawLevel: 'off' },
        { level: 'high', openclawLevel: 'high' },
        { level: 'max', openclawLevel: 'xhigh' },
      ],
      defaultLevel: 'high',
    });
    expect(config).toBeDefined();
    if (!config) return;

    expect(getModelThinkingLevels(config)).toEqual(['off', 'high', 'max']);
    expect(resolveOpenClawThinkingLevel(config, ModelThinkingLevel.Max)).toBe('xhigh');
    expect(resolveProductThinkingLevel(config, OpenClawThinkingLevel.XHigh)).toBe('max');
  });
});
