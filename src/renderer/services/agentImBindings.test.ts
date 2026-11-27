import { AgentId } from '@shared/agent';
import { RetainedImPlatform } from '@shared/dshEngine/hostConstants';
import { describe, expect, test } from 'vitest';

import { DEFAULT_FEISHU_OPENCLAW_CONFIG, DEFAULT_IM_CONFIG, DEFAULT_TELEGRAM_OPENCLAW_CONFIG } from '../types/im';
import { applyImBindingChanges, getAgentImPlatforms, getBoundImKeys } from './agentImBindings';

const first = '12345678-1111';
const second = '87654321-2222';
const expert = 'reviewer';
const feishu = RetainedImPlatform.Feishu;
const firstKey = `${feishu}:${first}`;
const secondKey = `${feishu}:${second}`;

function configured(bindings: Record<string, string> = {}) {
  return {
    ...DEFAULT_IM_CONFIG,
    settings: { platformAgentBindings: bindings },
    weixin: { ...DEFAULT_IM_CONFIG.weixin, enabled: true },
    feishu: { instances: [first, second, 'disabled'].map(instanceId => ({
      ...DEFAULT_FEISHU_OPENCLAW_CONFIG, instanceId, instanceName: instanceId, enabled: instanceId !== 'disabled',
    })) },
    telegram: { instances: [{ ...DEFAULT_TELEGRAM_OPENCLAW_CONFIG, instanceId: 't', instanceName: 't', enabled: true }] },
  };
}

describe('agent editor IM bindings', () => {
  test('counts enabled visible switches for each agent, including implicit main routes', () => {
    const config = configured({ [secondKey]: expert, 'feishu:disabled': AgentId.Main, 'feishu:removed': AgentId.Main, nim: AgentId.Main });
    const platforms = getAgentImPlatforms(config, 'zh');
    expect(getBoundImKeys(platforms, AgentId.Main)).toEqual(new Set([RetainedImPlatform.Weixin, firstKey]));
    expect(getBoundImKeys(platforms, expert)).toEqual(new Set([secondKey]));
    expect(getBoundImKeys(getAgentImPlatforms(config, 'en'), AgentId.Main)).toContain('telegram:t');
    expect(getBoundImKeys(getAgentImPlatforms(null, 'en'), AgentId.Main)).toEqual(new Set());
  });

  test('resolves full instance, short account, platform and default owners in order', () => {
    const short = `${feishu}:${first.slice(0, 8)}`;
    const config = configured({ [feishu]: expert, [short]: 'other', [firstKey]: AgentId.Main, 'weixin:default': expert });
    expect(getBoundImKeys(getAgentImPlatforms(config, 'zh'), AgentId.Main)).toEqual(new Set([firstKey]));
    delete config.settings.platformAgentBindings[firstKey];
    const platforms = getAgentImPlatforms(config, 'zh');
    expect(getBoundImKeys(platforms, 'other')).toEqual(new Set([firstKey]));
    expect(getBoundImKeys(platforms, expert)).toEqual(new Set([secondKey, RetainedImPlatform.Weixin]));
  });

  test('reclaiming a bot removes only its override and leaves implicit and hidden bindings alone', () => {
    const bindings = { [secondKey]: expert, 'telegram:t': AgentId.Main, 'feishu:disabled': expert };
    const initial = new Set([firstKey]);
    expect(applyImBindingChanges(bindings, AgentId.Main, initial, initial)).toEqual(bindings);
    expect(applyImBindingChanges(bindings, AgentId.Main, initial, new Set([firstKey, secondKey])))
      .toEqual({ 'telegram:t': AgentId.Main, 'feishu:disabled': expert });
  });

  test('a per-instance main override survives a platform-wide expert binding and can be returned', () => {
    const bindings = { [feishu]: expert };
    const one = new Set([firstKey]);
    const claimed = { [feishu]: expert, [firstKey]: AgentId.Main };
    expect(applyImBindingChanges(bindings, AgentId.Main, new Set(), one)).toEqual(claimed);
    expect(applyImBindingChanges(bindings, expert, new Set([firstKey, secondKey]), new Set([secondKey]))).toEqual(claimed);
    expect(applyImBindingChanges(claimed, expert, new Set([secondKey]), new Set([firstKey, secondKey]))).toEqual(bindings);
  });

  test('releasing an old Weixin binding restores main and a concurrent reassignment is preserved', () => {
    const one = new Set([RetainedImPlatform.Weixin]);
    expect(applyImBindingChanges({ 'weixin:default': expert }, expert, one, new Set())).toEqual({});
    expect(applyImBindingChanges({ [firstKey]: 'other' }, expert, new Set([firstKey]), new Set()))
      .toEqual({ [firstKey]: 'other' });
  });
});
