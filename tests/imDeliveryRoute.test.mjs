import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildDingTalkSessionKeyCandidates,
  buildDingTalkSendParamsFromRoute,
  extractOpenClawDeliveryRoute,
  resolveOpenClawDeliveryRouteForSessionKeys,
  resolveManagedSessionDeliveryRoute,
} = require('../dist-electron/main/im/imDeliveryRoute.js');

test('managed session delivery route prefers deliveryContext over legacy last route fields', () => {
  const resolved = resolveManagedSessionDeliveryRoute('session-1', [
    {
      key: 'agent:main:lobsterai:session-1',
      lastChannel: 'dingtalk-connector',
      lastTo: 'user:legacy-user',
      lastAccountId: 'legacy-account',
      deliveryContext: {
        channel: 'dingtalk-connector',
        to: 'group:cid-123',
        accountId: '__default__',
      },
    },
  ]);

  assert.deepEqual(resolved, {
    sessionKey: 'agent:main:lobsterai:session-1',
    route: {
      channel: 'dingtalk-connector',
      to: 'group:cid-123',
      accountId: '__default__',
    },
  });
  assert.deepEqual(buildDingTalkSendParamsFromRoute(resolved.route), {
    target: 'group:cid-123',
    accountId: '__default__',
  });
});

test('managed session delivery route falls back to last route fields', () => {
  const resolved = resolveManagedSessionDeliveryRoute('session-2', [
    {
      key: 'agent:main:lobsterai:session-2',
      lastChannel: 'dingtalk-connector',
      lastTo: 'user:staff-42',
      lastAccountId: 'acct-1',
    },
  ]);

  assert.deepEqual(resolved, {
    sessionKey: 'agent:main:lobsterai:session-2',
    route: {
      channel: 'dingtalk-connector',
      to: 'user:staff-42',
      accountId: 'acct-1',
    },
  });
});

test('route lookup can match DingTalk channel session keys discovered outside the managed session namespace', () => {
  const candidateSessionKeys = [
    ...buildDingTalkSessionKeyCandidates('__default__:2459325231940374'),
    'agent:main:lobsterai:session-3',
  ];

  const resolved = resolveOpenClawDeliveryRouteForSessionKeys(candidateSessionKeys, [
    {
      key: 'agent:main:openai-user:dingtalk-connector:__default__:2459325231940374',
      deliveryContext: {
        channel: 'dingtalk-connector',
        to: 'group:cid-42',
        accountId: '__default__',
      },
    },
  ]);

  assert.deepEqual(resolved, {
    sessionKey: 'agent:main:openai-user:dingtalk-connector:__default__:2459325231940374',
    route: {
      channel: 'dingtalk-connector',
      to: 'group:cid-42',
      accountId: '__default__',
    },
  });
});

test('delivery route extraction ignores incomplete session rows and non-dingtalk channels', () => {
  assert.equal(extractOpenClawDeliveryRoute({ key: 'agent:main:lobsterai:session-3' }), null);
  assert.equal(buildDingTalkSendParamsFromRoute({
    channel: 'telegram',
    to: 'chat:123',
    accountId: 'default',
  }), null);
});
