import { describe, expect, test } from 'vitest';

import {
  buildGoalSettingMessageMetadata,
  hasGoalSettingMessageMetadata,
  parseGoalSettingCommandForDisplay,
} from './goalCommandDisplay';

describe('goal command display helpers', () => {
  test('extracts goal-setting commands for message presentation', () => {
    expect(parseGoalSettingCommandForDisplay('/goal start ship the app')).toEqual({
      action: 'start',
      objective: 'ship the app',
    });
    expect(parseGoalSettingCommandForDisplay('/goal set revise docs')).toEqual({
      action: 'set',
      objective: 'revise docs',
    });
  });

  test('ignores non-setting goal commands', () => {
    expect(parseGoalSettingCommandForDisplay('/goal pause')).toBeNull();
    expect(parseGoalSettingCommandForDisplay('/goal clear')).toBeNull();
    expect(parseGoalSettingCommandForDisplay('plain prompt')).toBeNull();
  });

  test('builds stable metadata only for goal-setting messages', () => {
    const metadata = buildGoalSettingMessageMetadata('/goal create write tests');

    expect(metadata).toEqual({
      goalSetting: {
        action: 'create',
        objective: 'write tests',
      },
    });
    expect(hasGoalSettingMessageMetadata(metadata)).toBe(true);
    expect(buildGoalSettingMessageMetadata('/goal status')).toBeUndefined();
  });
});
