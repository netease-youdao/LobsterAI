import { afterEach, describe, expect, test, vi } from 'vitest';

import { confirmOpenClawConfigApplied, isOpenClawConfigApplied } from './openclawConfigApplication';

const config = { agents: { defaults: { model: { primary: 'fixture/current' } } } };
const raw = JSON.stringify(config);
const applied = { valid: true, parsed: config, configRevisionHash: 'current', appliedConfigHash: 'current' };

afterEach(() => vi.useRealTimers());

describe('config application evidence', () => {
  test('requires the current target as well as matching applied revision tokens', () => {
    expect(isOpenClawConfigApplied(applied, raw)).toBe(true);
    expect(isOpenClawConfigApplied({ ...applied, parsed: {} }, raw)).toBe(false);
    expect(isOpenClawConfigApplied({ ...applied, appliedConfigHash: 'old' }, raw)).toBe(false);
    expect(isOpenClawConfigApplied({ ...applied, valid: false }, raw)).toBe(false);
    expect(isOpenClawConfigApplied({ ...applied, configRevisionHash: '' }, raw)).toBe(false);
    expect(isOpenClawConfigApplied({ hash: 'raw-only' }, raw)).toBe(false);
  });

  test('ignores write provenance but retains migration semantics', () => {
    const snapshot = { ...applied, parsed: { ...config, meta: { lastTouchedVersion: '2026.8.1' } } };
    expect(isOpenClawConfigApplied(snapshot, raw)).toBe(true);
    expect(isOpenClawConfigApplied(snapshot, JSON.stringify({
      ...config, meta: { migrations: { modelPolicyAllowlist: true } },
    }))).toBe(false);
  });

  test('does not use a redacted secret as evidence for an unconfirmed secret change', () => {
    expect(isOpenClawConfigApplied({ ...applied, parsed: { apiKey: '__OPENCLAW_REDACTED__' } },
      JSON.stringify({ apiKey: 'new-secret' }))).toBe(false);
    expect(isOpenClawConfigApplied(applied, 'malformed')).toBe(false);
  });

  test('uses authored raw identity when parsed environment references have been resolved and redacted', () => {
    const target = JSON.stringify({ gateway: { auth: { token: '${OPENCLAW_GATEWAY_TOKEN}' } } });
    const snapshot = {
      ...applied,
      raw: target,
      parsed: { gateway: { auth: { token: '__OPENCLAW_REDACTED__' } } },
    };
    expect(isOpenClawConfigApplied(snapshot, target)).toBe(true);
    expect(isOpenClawConfigApplied(snapshot, target.replace('OPENCLAW_GATEWAY_TOKEN', 'OTHER_TOKEN'))).toBe(false);
    expect(isOpenClawConfigApplied({ ...snapshot, appliedConfigHash: 'old' }, target)).toBe(false);
    expect(isOpenClawConfigApplied({ ...applied, raw: 'malformed' }, raw)).toBe(false);
    expect(isOpenClawConfigApplied({ ...applied, raw: '{}' }, raw)).toBe(false);
    expect(isOpenClawConfigApplied({ ...snapshot, raw: JSON.stringify(snapshot.parsed) }, target)).toBe(false);
  });

  test('accepts a late application without writing the config again', async () => {
    vi.useFakeTimers();
    const readSnapshot = vi.fn()
      .mockResolvedValueOnce({ ...applied, appliedConfigHash: 'old' })
      .mockResolvedValue(applied);
    const result = confirmOpenClawConfigApplied({ readConfigFile: () => raw, readSnapshot });
    await vi.runAllTimersAsync();
    expect(await result).toBe(true);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  test('a persisted receipt proves redacted content only while its submitted target is still current', async () => {
    vi.useFakeTimers();
    const receipt = {
      ...applied, hash: 'persisted', raw: '{"apiKey":"__OPENCLAW_REDACTED__"}',
    };
    const submitted = '{"apiKey":"synthetic-first"}';
    expect(await confirmOpenClawConfigApplied({
      readConfigFile: () => submitted, readSnapshot: async () => receipt,
      persistedHash: 'persisted', persistedRaw: submitted,
    })).toBe(true);
    const changed = confirmOpenClawConfigApplied({
      readConfigFile: () => '{"apiKey":"synthetic-second"}', readSnapshot: async () => receipt,
      persistedHash: 'persisted', persistedRaw: submitted,
    });
    await vi.runAllTimersAsync();
    expect(await changed).toBe(false);
    expect(isOpenClawConfigApplied({ ...receipt, appliedConfigHash: 'old' }, submitted, 'persisted')).toBe(false);
  });

  test('rejects evidence if the target changes while the probe is in flight', async () => {
    vi.useFakeTimers();
    let content = raw;
    const result = confirmOpenClawConfigApplied({
      readConfigFile: () => content,
      readSnapshot: async () => { content = '{}'; return applied; },
    });
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
  });

  test('bounds retries when application evidence remains unavailable', async () => {
    vi.useFakeTimers();
    const readSnapshot = vi.fn().mockRejectedValue(new Error('unavailable'));
    const result = confirmOpenClawConfigApplied({ readConfigFile: () => raw, readSnapshot });
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(readSnapshot).toHaveBeenCalledTimes(3);
  });
});
