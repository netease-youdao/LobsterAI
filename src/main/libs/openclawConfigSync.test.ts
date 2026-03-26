/**
 * Unit tests for the plugin-channel guard in openclawConfigSync.ts.
 *
 * The core invariant: a channel backed by an OpenClaw plugin must only be
 * written to openclaw.json when the plugin is actually installed in the
 * bundle.  If it is written while absent, the OpenClaw gateway exits with
 * code=1 ("unknown channel id") and the whole app fails to start.
 *
 * `applyPluginChannel` is the pure, exported function that encapsulates this
 * guard.  All channel-specific sync paths call it, so testing this function
 * covers the protection for every plugin-backed channel (feishu, dingtalk,
 * qqbot, wecom, moltbot-popo, nim, weixin, etc.).
 */
import { test, expect } from 'vitest';
import { applyPluginChannel } from './openclawConfigSync';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const available = (_id: string): boolean => true;
const unavailable = (_id: string): boolean => false;
const selectiveAvailable = (available: string[]) => (id: string): boolean => available.includes(id);

const dummyConfig: Record<string, unknown> = { enabled: true, appKey: 'key-123' };

// ---------------------------------------------------------------------------
// Core guard: plugin absent → channel must not be written
// ---------------------------------------------------------------------------

test('guard: channel is skipped when plugin is not available', () => {
  const result = applyPluginChannel(unavailable, {}, 'moltbot-popo', 'moltbot-popo', dummyConfig);
  expect(result).not.toHaveProperty('moltbot-popo');
});

test('guard: channel is written when plugin is available', () => {
  const result = applyPluginChannel(available, {}, 'moltbot-popo', 'moltbot-popo', dummyConfig);
  expect(result).toHaveProperty('moltbot-popo', dummyConfig);
});

// ---------------------------------------------------------------------------
// Plugin ID / channel key independence
// ---------------------------------------------------------------------------

test('guard: plugin id is what is checked, not the channel key', () => {
  // openclaw-weixin plugin exposes the 'weixin' channel key — different strings
  const isAvailable = selectiveAvailable(['openclaw-weixin']);
  const result = applyPluginChannel(isAvailable, {}, 'openclaw-weixin', 'weixin', dummyConfig);
  expect(result).toHaveProperty('weixin', dummyConfig);
});

test('guard: absent plugin id blocks write even when channel key differs', () => {
  const isAvailable = selectiveAvailable([]);
  const result = applyPluginChannel(isAvailable, {}, 'openclaw-weixin', 'weixin', dummyConfig);
  expect(result).not.toHaveProperty('weixin');
});

// ---------------------------------------------------------------------------
// Existing channels are preserved regardless of outcome
// ---------------------------------------------------------------------------

test('channels: existing entries are preserved when plugin is absent', () => {
  const existing = { telegram: { enabled: true } };
  const result = applyPluginChannel(unavailable, existing, 'moltbot-popo', 'moltbot-popo', dummyConfig);
  expect(result).toHaveProperty('telegram');
  expect(result).not.toHaveProperty('moltbot-popo');
});

test('channels: existing entries are preserved when plugin is available', () => {
  const existing = { telegram: { enabled: true } };
  const result = applyPluginChannel(available, existing, 'moltbot-popo', 'moltbot-popo', dummyConfig);
  expect(result).toHaveProperty('telegram');
  expect(result).toHaveProperty('moltbot-popo', dummyConfig);
});

test('channels: original map is not mutated', () => {
  const existing: Record<string, unknown> = { telegram: { enabled: true } };
  const before = { ...existing };
  applyPluginChannel(available, existing, 'moltbot-popo', 'moltbot-popo', dummyConfig);
  expect(existing).toEqual(before);
});

// ---------------------------------------------------------------------------
// Accumulating multiple plugin channels
// ---------------------------------------------------------------------------

test('accumulate: multiple available plugins all appear in result', () => {
  const isAvailable = selectiveAvailable(['feishu-openclaw-plugin', 'dingtalk-connector', 'qqbot']);
  const feishuCfg = { enabled: true, appId: 'f1' };
  const dingtalkCfg = { enabled: true, clientId: 'd1' };
  const qqCfg = { enabled: true, appId: 'q1' };

  let channels: Record<string, unknown> = {};
  channels = applyPluginChannel(isAvailable, channels, 'feishu-openclaw-plugin', 'feishu', feishuCfg);
  channels = applyPluginChannel(isAvailable, channels, 'dingtalk-connector', 'dingtalk-connector', dingtalkCfg);
  channels = applyPluginChannel(isAvailable, channels, 'qqbot', 'qqbot', qqCfg);

  expect(channels).toHaveProperty('feishu', feishuCfg);
  expect(channels).toHaveProperty('dingtalk-connector', dingtalkCfg);
  expect(channels).toHaveProperty('qqbot', qqCfg);
});

test('accumulate: only available plugins are written when some are absent', () => {
  // dingtalk available, qqbot absent
  const isAvailable = selectiveAvailable(['dingtalk-connector']);
  const dingtalkCfg = { enabled: true, clientId: 'd1' };
  const qqCfg = { enabled: true, appId: 'q1' };

  let channels: Record<string, unknown> = {};
  channels = applyPluginChannel(isAvailable, channels, 'dingtalk-connector', 'dingtalk-connector', dingtalkCfg);
  channels = applyPluginChannel(isAvailable, channels, 'qqbot', 'qqbot', qqCfg);

  expect(channels).toHaveProperty('dingtalk-connector', dingtalkCfg);
  expect(channels).not.toHaveProperty('qqbot');
});

// ---------------------------------------------------------------------------
// All known plugin-backed channels: absent plugin → no channel written
// ---------------------------------------------------------------------------

const pluginChannelPairs: [string, string][] = [
  ['feishu-openclaw-plugin', 'feishu'],
  ['dingtalk-connector', 'dingtalk-connector'],
  ['qqbot', 'qqbot'],
  ['wecom-openclaw-plugin', 'wecom'],
  ['moltbot-popo', 'moltbot-popo'],
  ['nim', 'nim'],
  ['openclaw-weixin', 'weixin'],
];

for (const [pluginId, channelKey] of pluginChannelPairs) {
  test(`guard: absent '${pluginId}' plugin does not write '${channelKey}' channel`, () => {
    const result = applyPluginChannel(unavailable, {}, pluginId, channelKey, dummyConfig);
    expect(result).not.toHaveProperty(channelKey);
  });

  test(`guard: present '${pluginId}' plugin writes '${channelKey}' channel`, () => {
    const result = applyPluginChannel(available, {}, pluginId, channelKey, dummyConfig);
    expect(result).toHaveProperty(channelKey, dummyConfig);
  });
}
