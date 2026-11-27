import { describe, expect, test } from 'vitest';

import { RetainedImPlatform } from '../../../shared/dshEngine/hostConstants';
import type { IMGatewayConfig } from '../../types/im';
import {
  areIMConfigsEqual,
  buildIMTestConfigWithDraft,
  hasFeishuCredentials,
  isIMAutoBindCredentialOverride,
  resolveIMConnectivityOverride,
} from './imInstanceDraft';

describe('imInstanceDraft', () => {
  test('requires a nonblank Feishu App ID and App Secret, including for auto-binding', () => {
    expect(hasFeishuCredentials('cli_1', 'secret')).toBe(true);
    for (const [appId, appSecret] of [['', 'secret'], ['cli_1', '   '], [undefined, 'secret']]) {
      expect(hasFeishuCredentials(appId, appSecret)).toBe(false);
      expect(isIMAutoBindCredentialOverride(RetainedImPlatform.Feishu, { appId, appSecret, enabled: true })).toBe(false);
    }
  });

  test('probes the selected Feishu draft when another saved bot is enabled', () => {
    const other = { instanceId: 'other', enabled: true, appId: 'cli_other' };
    const selected = { instanceId: 'selected', enabled: false, appId: 'cli_saved' };
    const config = { feishu: { instances: [other, selected] } } as unknown as IMGatewayConfig;
    const draft = { ...selected, appId: 'cli_draft' };

    const override = resolveIMConnectivityOverride(RetainedImPlatform.Feishu, config, selected.instanceId, draft);
    expect(override.feishu?.instances).toEqual([draft]);
    expect(config.feishu.instances).toEqual([other, selected]);
  });

  test('areIMConfigsEqual compares nested objects regardless of key order', () => {
    expect(
      areIMConfigsEqual(
        { appId: 'id-1', appSecret: 'sec-1', nested: { b: 2, a: 1 } },
        { nested: { a: 1, b: 2 }, appSecret: 'sec-1', appId: 'id-1' },
      ),
    ).toBe(true);

    expect(
      areIMConfigsEqual(
        { appId: 'id-1', appSecret: 'sec-1' },
        { appId: 'id-1', appSecret: 'sec-2' },
      ),
    ).toBe(false);
  });

  test('isIMAutoBindCredentialOverride matches complete auto-bind credential payloads only', () => {
    expect(isIMAutoBindCredentialOverride('dingtalk', { clientId: 'c', clientSecret: 's', enabled: true })).toBe(true);
    expect(isIMAutoBindCredentialOverride('dingtalk', { clientId: 'c', enabled: true })).toBe(false);
    expect(isIMAutoBindCredentialOverride('feishu', { appId: 'a', appSecret: 's', enabled: true })).toBe(true);
    expect(isIMAutoBindCredentialOverride('popo', { appKey: 'k', appSecret: 's', aesKey: 'e', enabled: true })).toBe(true);
    expect(isIMAutoBindCredentialOverride('nim', { nimToken: 'tok', enabled: true })).toBe(true);
    expect(isIMAutoBindCredentialOverride('telegram', { botToken: 't', enabled: true })).toBe(false);
    expect(isIMAutoBindCredentialOverride('feishu', { dmPolicy: 'pairing' })).toBe(false);
  });

  test('buildIMTestConfigWithDraft replaces only the matching instance', () => {
    const instances = [
      { instanceId: 'i1', appId: 'old-1' },
      { instanceId: 'i2', appId: 'old-2' },
    ];
    const merged = buildIMTestConfigWithDraft(instances, { instanceId: 'i2', appId: 'draft-2' });
    expect(merged).toEqual([
      { instanceId: 'i1', appId: 'old-1' },
      { instanceId: 'i2', appId: 'draft-2' },
    ]);
  });

  test('resolveIMConnectivityOverride injects draft values for multi-instance and netease-bee', () => {
    const baseConfig = {
      dingtalk: {
        instances: [
          { instanceId: 'dt-1', instanceName: 'DT 1', enabled: false, clientId: 'old', clientSecret: 'old-sec' },
        ],
      },
      'netease-bee': {
        enabled: false,
        clientId: 'old-bee',
        secret: 'old-bee-sec',
      },
    } as unknown as IMGatewayConfig;

    const dtOverride = resolveIMConnectivityOverride('dingtalk', baseConfig, 'dt-1', {
      instanceId: 'dt-1',
      instanceName: 'DT 1',
      enabled: false,
      clientId: 'draft-id',
      clientSecret: 'draft-sec',
    });
    expect(dtOverride.dingtalk?.instances?.[0].clientId).toBe('draft-id');

    const beeOverride = resolveIMConnectivityOverride('netease-bee', baseConfig, null, {
      enabled: false,
      clientId: 'draft-bee',
      secret: 'draft-bee-sec',
    });
    expect(beeOverride['netease-bee']?.clientId).toBe('draft-bee');
  });
});
