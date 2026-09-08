import { describe, expect, test } from 'vitest';

import { DEFAULT_QQ_CONFIG, type QQInstanceConfig } from '../im/types';
import { buildQQAccountConfig, OpenClawQQPolicy, QQ_APPROVALS_DISABLED } from './openclawQQConfig';

const instance: QQInstanceConfig = {
  ...DEFAULT_QQ_CONFIG,
  enabled: true,
  instanceId: 'fixture-account',
  instanceName: 'Fixture',
  appId: '123',
  appSecret: 'secret-must-not-be-written',
};

describe('Tencent QQBot config', () => {
  test('keeps open DM access separate from native approval authorization', () => {
    const config = buildQQAccountConfig({ ...instance, allowFrom: ['*'] }, 'QQ_TEST_SECRET');
    expect(config).toMatchObject({
      dmPolicy: OpenClawQQPolicy.Open,
      allowFrom: [QQ_APPROVALS_DISABLED],
      clientSecret: '${QQ_TEST_SECRET}',
    });
    expect(JSON.stringify(config)).not.toContain(instance.appSecret);
  });

  test('normalizes explicit OpenIDs without widening restrictive access', () => {
    const config = buildQQAccountConfig({
      ...instance,
      dmPolicy: OpenClawQQPolicy.Allowlist,
      allowFrom: [' qqbot:user123 ', 'USER123', 'user456', ''],
      groupPolicy: OpenClawQQPolicy.Allowlist,
      groupAllowFrom: [' group123 '],
    }, 'QQ_TEST_SECRET');
    expect(config).toMatchObject({
      dmPolicy: OpenClawQQPolicy.Allowlist,
      allowFrom: ['USER123', 'USER456'],
      groupPolicy: OpenClawQQPolicy.Allowlist,
      groupAllowFrom: ['GROUP123'],
    });
  });

  test('empty allowlists do not become open in Tencent middleware', () => {
    const config = buildQQAccountConfig({
      ...instance,
      dmPolicy: OpenClawQQPolicy.Allowlist,
      allowFrom: [],
      groupPolicy: OpenClawQQPolicy.Allowlist,
      groupAllowFrom: [],
    }, 'QQ_TEST_SECRET');
    expect(config).toMatchObject({
      dmPolicy: OpenClawQQPolicy.Allowlist,
      allowFrom: [QQ_APPROVALS_DISABLED],
      groupPolicy: OpenClawQQPolicy.Allowlist,
      groupAllowFrom: [QQ_APPROVALS_DISABLED],
    });
  });

  test('keeps legacy wildcard DM behavior with approvals restricted to concrete IDs', () => {
    expect(buildQQAccountConfig({
      ...instance, dmPolicy: OpenClawQQPolicy.Allowlist, allowFrom: ['*', 'qqbot:admin'],
    }, 'QQ_TEST_SECRET')).toMatchObject({
      dmPolicy: OpenClawQQPolicy.Open, allowFrom: ['ADMIN'],
    });
  });

  test('preserves pairing mode and disabled groups', () => {
    expect(buildQQAccountConfig({
      ...instance, dmPolicy: OpenClawQQPolicy.Pairing, groupPolicy: OpenClawQQPolicy.Disabled,
    }, 'QQ_TEST_SECRET')).toMatchObject({
      dmPolicy: OpenClawQQPolicy.Pairing, groupPolicy: OpenClawQQPolicy.Disabled,
    });
  });

  test('preserves legacy wildcard group access without an empty allowlist', () => {
    expect(buildQQAccountConfig({
      ...instance, groupPolicy: OpenClawQQPolicy.Allowlist, groupAllowFrom: ['*'],
    }, 'QQ_TEST_SECRET')).toMatchObject({
      groupPolicy: OpenClawQQPolicy.Open, groupAllowFrom: [QQ_APPROVALS_DISABLED],
    });
  });
});
