import { expect, test } from 'vitest';

import { readUsageContext, UsageEntry, usageFailureCode } from './usage';

test('persisted analytics context is allowlisted; raw identity and content cannot pass through', () => {
  const context = readUsageContext({
    taskId: '00000000-0000-4000-8000-000000000001',
    turnId: '00000000-0000-4000-8000-000000000002',
    entry: 'private/path',
    ownerKey: 'private owner',
    prompt: 'private prompt',
    presetId: '/private/path',
    catalogVersion: 'v1',
  });
  expect(context).toMatchObject({
    entry: UsageEntry.Runtime,
    presetId: undefined,
    catalogVersion: 'v1',
  });
  expect(JSON.stringify(context)).not.toContain('private');
  expect(
    readUsageContext({ taskId: 'private-session', turnId: 'private-message' }),
  ).toBeUndefined();
});

test.each([
  ['ENGINE_NOT_READY', 'engine_not_ready'],
  ['40204: private data', 'quota'],
  ['Timed out reading /private/file', 'timeout'],
  ['ECONNRESET private-host', 'network'],
  ['unknown private response body', 'unknown'],
])('normalizes %s to a bounded failure category', (input, expected) => {
  expect(usageFailureCode(input)).toBe(expected);
});
