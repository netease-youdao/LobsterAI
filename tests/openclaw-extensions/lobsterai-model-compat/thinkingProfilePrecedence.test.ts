import { describe, expect, test } from 'vitest';

import {
  LobsterAIThinkingLevel,
  resolveOpenClawThinkingProfile,
} from '../../../openclaw-extensions/lobsterai-model-compat/thinkingProfileMapping';

describe('lobsterai model compatibility thinking profile precedence', () => {
  test('prefers a server thinking profile when a Kimi K3 runtime profile also exists', () => {
    expect(resolveOpenClawThinkingProfile({
      options: [
        { level: LobsterAIThinkingLevel.Off, openclawLevel: 'off' },
        { level: LobsterAIThinkingLevel.High, openclawLevel: 'high' },
        { level: LobsterAIThinkingLevel.Max, openclawLevel: 'xhigh' },
      ],
      defaultLevel: LobsterAIThinkingLevel.High,
    }, true)).toEqual({
      levels: [
        { id: 'off', label: 'off' },
        { id: 'high', label: 'high' },
        { id: 'xhigh', label: 'max' },
      ],
      defaultLevel: 'high',
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  test('uses the max-only Kimi K3 fallback when no server thinking profile exists', () => {
    expect(resolveOpenClawThinkingProfile(undefined, true)).toEqual({
      levels: [{ id: 'max', label: 'max' }],
      defaultLevel: 'max',
      preserveWhenCatalogReasoningFalse: true,
    });
  });
});
