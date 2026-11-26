import { describe, expect, test } from 'vitest';

import { DSH_SESSION_ID_PREFIX } from '../dshEngine/hostConstants';
import { isChatPresetSession } from './constants';

describe('isChatPresetSession', () => {
  test.each([
    ['fresh chat session', { claudeSessionId: null, scheduledTaskId: null, imPlatform: null }],
    ['DSH native session', { claudeSessionId: `${DSH_SESSION_ID_PREFIX}session-abc`, scheduledTaskId: null, imPlatform: null }],
    ['bare DSH session ID', { claudeSessionId: 'session-abc', scheduledTaskId: null, imPlatform: null }],
    ['legacy lobsterai session', { claudeSessionId: 'lobsterai:session-1', scheduledTaskId: null, imPlatform: null }],
    ['legacy agent lobsterai session', { claudeSessionId: 'agent:main:lobsterai:session-1', scheduledTaskId: null, imPlatform: null }],
    ['scheduled task session', { claudeSessionId: `${DSH_SESSION_ID_PREFIX}session-cron`, scheduledTaskId: 'task-1', imPlatform: null }],
  ])('returns true for %s', (_label, session) => {
    expect(isChatPresetSession(session)).toBe(true);
  });

  test.each([
    ['DSH IM session', { claudeSessionId: `${DSH_SESSION_ID_PREFIX}session-im`, scheduledTaskId: null, imPlatform: 'feishu' }],
    ['unstarted IM session', { claudeSessionId: null, scheduledTaskId: null, imPlatform: 'wecom' }],
    ['legacy OpenClaw IM session', { claudeSessionId: 'agent:main:feishu:dm:ou_123', scheduledTaskId: null }],
  ])('returns false for %s', (_label, session) => {
    expect(isChatPresetSession(session)).toBe(false);
  });
});
