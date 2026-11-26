import { expect, it } from 'vitest';

import { assertImInstanceAccess, canManageImPlatform, mergeVisibleImConfig, newImInstances, visibleImConfig, visibleImStatus } from './imConfigOwnership';
import { DEFAULT_IM_CONFIG, DEFAULT_IM_STATUS, type IMGatewayConfig } from './types';

const owned = { instanceId: 'current-1000000', instanceName: 'Current', token: 'mine' };
const foreign = { instanceId: 'foreign-1000000', instanceName: 'Private', token: 'secret' };
const legacy = { instanceId: 'old-1000000', instanceName: 'Legacy' };
const allowed = (platform: string, id?: string) => platform !== 'weixin' && id !== foreign.instanceId;
const current = {
  ...DEFAULT_IM_CONFIG,
  nim: { instances: [owned, foreign, legacy] }, email: { instances: [foreign, owned] },
  weixin: { ...DEFAULT_IM_CONFIG.weixin, enabled: true, botToken: 'singleton secret' },
  settings: { platformAgentBindings: { 'nim:current': 'my-agent', 'nim:foreign': 'other-agent', 'nim:old': 'legacy-agent' } },
} as unknown as IMGatewayConfig;

it('hides foreign credentials, abbreviated Agent bindings and multi-instance statuses', () => {
  const view = visibleImConfig(current, allowed);
  expect(view.nim.instances).toEqual([owned, legacy]);
  expect(view.weixin).toEqual(DEFAULT_IM_CONFIG.weixin);
  expect(view.settings.platformAgentBindings).toEqual({ 'nim:current': 'my-agent', 'nim:old': 'legacy-agent' });
  const status = { ...DEFAULT_IM_STATUS, email: { instances: [{ ...foreign, connected: true }] } };
  expect(visibleImStatus(status as never, allowed).email.instances).toEqual([]);
  expect(current.weixin.botToken).toBe('singleton secret');
});

it('keeps hidden records through a complete save and rejects forged IDs in partial writes', () => {
  const changes = visibleImConfig(current, allowed);
  changes.email.instances = [];
  const save = mergeVisibleImConfig(current, changes, allowed);
  expect(save.nim!.instances).toEqual([owned, legacy, foreign]);
  expect(save.email!.instances).toEqual([foreign]);
  expect(save.weixin).toBeUndefined();
  expect(save.settings).toEqual(current.settings);
  expect(() => mergeVisibleImConfig(current, { email: current.email }, allowed)).toThrow();
  expect(() => mergeVisibleImConfig(current, { settings: { platformAgentBindings: { 'nim:foreign': 'my-agent' } } }, allowed)).toThrow();
  expect(() => assertImInstanceAccess(allowed, 'nim', owned.instanceId, { instanceId: foreign.instanceId })).toThrow();
  expect(canManageImPlatform(current, 'nim', allowed)).toBe(false);
  expect(canManageImPlatform(current, 'nim:' + owned.instanceId, allowed)).toBe(true);
  expect(canManageImPlatform(current, 'nim:' + foreign.instanceId, allowed)).toBe(false);
  expect(canManageImPlatform(current, 'nim_foreign-1000000', allowed)).toBe(false);
});

it('binds only genuinely new IM instances and keeps the ownership of legacy credentials on edit', () => {
  const changes = { nim: { instances: [legacy, { ...legacy, instanceId: 'new' }] },
    weixin: { ...DEFAULT_IM_CONFIG.weixin, accountId: 'wx-id', botToken: 'new token' } } as unknown as Partial<IMGatewayConfig>;
  expect(newImInstances(current, changes)).toEqual([['nim', 'new']]);
  expect(newImInstances(DEFAULT_IM_CONFIG, { weixin: changes.weixin })).toEqual([['weixin']]);
});
