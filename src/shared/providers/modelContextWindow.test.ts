import { describe, expect, test } from 'vitest';

import { DSH_SESSION_ID_PREFIX } from '../dshEngine/hostConstants';
import { ModelPresetId } from '../modelPresets/constants';
import {
  isManualContextWindowSession,
  parseContextWindowOptions,
  selectableContextWindows,
  userContextWindowSelection,
} from './modelContextWindow';

describe('selectable context windows', () => {
  test('never infers choices from an ordinary default, including historical 1M', () => {
    expect(selectableContextWindows({ contextWindow: 1_000_000 })).toEqual([]);
    expect(parseContextWindowOptions([399_999, 1_000_001, '1000000', 400_000.5])).toBeUndefined();
    expect(parseContextWindowOptions([1_000_000, 400_000, 400_000])).toEqual([400_000, 1_000_000]);
  });

  test('mode choices require both mode policy and the bound model', () => {
    const model = { contextWindowOptions: [400_000, 1_000_000],
      presetContextWindowOptions: { [ModelPresetId.Balanced]: [400_000] } };
    expect(selectableContextWindows(model)).toEqual([400_000, 1_000_000]);
    expect(selectableContextWindows(model, ModelPresetId.Balanced)).toEqual([400_000]);
    expect(selectableContextWindows(model, ModelPresetId.Ultimate)).toEqual([]);
    expect(userContextWindowSelection(1_000_000, ModelPresetId.Balanced)).toBe('user-context:yd-fast:1000000');
  });
});

describe('isManualContextWindowSession', () => {
  test.each([
    ['fresh chat session', { claudeSessionId: null, scheduledTaskId: null, imPlatform: null }],
    ['DSH native session', { claudeSessionId: `${DSH_SESSION_ID_PREFIX}session-abc`, scheduledTaskId: null, imPlatform: null }],
    ['bare DSH session ID', { claudeSessionId: 'session-abc', scheduledTaskId: null, imPlatform: null }],
    ['legacy lobsterai session', { claudeSessionId: 'lobsterai:session-1', scheduledTaskId: null, imPlatform: null }],
    ['legacy agent lobsterai session', { claudeSessionId: 'agent:main:lobsterai:session-1', scheduledTaskId: null, imPlatform: null }],
    ['scheduled task session', { claudeSessionId: `${DSH_SESSION_ID_PREFIX}session-cron`, scheduledTaskId: 'task-1', imPlatform: null }],
    ['legacy OpenClaw cron session', { claudeSessionId: 'agent:main:cron:job-1', scheduledTaskId: 'task-1', imPlatform: null }],
  ])('returns true for %s', (_label, session) => {
    expect(isManualContextWindowSession(session)).toBe(true);
  });

  test.each([
    ['DSH IM session', { claudeSessionId: `${DSH_SESSION_ID_PREFIX}session-im`, scheduledTaskId: null, imPlatform: 'feishu' }],
    ['DSH IM session with saved preset', {
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}session-im`,
      scheduledTaskId: null,
      modelPresetId: ModelPresetId.Balanced,
      imPlatform: 'feishu',
    }],
    ['unstarted IM session', { claudeSessionId: null, scheduledTaskId: null, imPlatform: 'wecom' }],
    ['legacy OpenClaw IM session', { claudeSessionId: 'agent:main:feishu:dm:ou_123', scheduledTaskId: null }],
    ['legacy OpenClaw IM session with saved preset', {
      claudeSessionId: 'agent:main:feishu:dm:ou_123',
      scheduledTaskId: null,
      modelPresetId: ModelPresetId.Balanced,
    }],
  ])('returns false for %s', (_label, session) => {
    expect(isManualContextWindowSession(session)).toBe(false);
  });
});
