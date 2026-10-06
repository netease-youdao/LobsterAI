import { expect, test } from 'vitest';

import {
  isOpenClawCronSessionKey,
  parseOpenClawCronSessionKey,
} from './openclawCronSessionKey';

test('parseOpenClawCronSessionKey normalizes supported scheduled task session keys', () => {
  expect(parseOpenClawCronSessionKey('cron:daily-monitor')).toEqual({
    agentId: null,
    scheduledTaskId: 'daily-monitor',
    cacheKey: 'cron:daily-monitor',
  });
  expect(parseOpenClawCronSessionKey('agent:ops:cron:daily-monitor')).toEqual({
    agentId: 'ops',
    scheduledTaskId: 'daily-monitor',
    cacheKey: 'agent:ops:cron:daily-monitor',
  });
  expect(parseOpenClawCronSessionKey('agent:ops:cron:daily-monitor:run:run-1')).toEqual({
    agentId: 'ops',
    scheduledTaskId: 'daily-monitor',
    cacheKey: 'agent:ops:cron:daily-monitor',
  });
});

test('parseOpenClawCronSessionKey rejects non-cron and malformed keys', () => {
  const invalidKeys = [
    '',
    'cron:',
    'agent:ops:cron:',
    'agent:ops:slack:cron:daily-monitor:run:run-1',
    'agent:ops:lobsterai:session-1',
  ];

  invalidKeys.forEach((sessionKey) => {
    expect(parseOpenClawCronSessionKey(sessionKey)).toBeNull();
    expect(isOpenClawCronSessionKey(sessionKey)).toBe(false);
  });
});
