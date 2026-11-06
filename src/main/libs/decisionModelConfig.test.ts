import { describe, expect, test } from 'vitest';

import { DecisionModelProvider } from '../../shared/decisionModel/constants';
import {
  applyDecisionModelConfigUpdate,
  DEFAULT_DECISION_MODEL_CONFIG,
  isDecisionModelActive,
  isValidDecisionEndpoint,
  normalizeDecisionModelConfig,
  toDecisionModelConfigView,
} from './decisionModelConfig';

const RELAY_ENDPOINT = 'https://relay.example.com/typesafe/v1/systemone';

describe('decision model config', () => {
  test('falls back to disabled defaults for missing or malformed stored values', () => {
    expect(normalizeDecisionModelConfig(undefined)).toEqual(DEFAULT_DECISION_MODEL_CONFIG);
    expect(normalizeDecisionModelConfig({
      enabled: 'yes',
      provider: 'unknown',
      endpoint: 3,
      apiKey: null,
    })).toEqual(DEFAULT_DECISION_MODEL_CONFIG);
  });

  test('keeps the saved key when an update omits it and clears it on an empty string', () => {
    const current = normalizeDecisionModelConfig({ enabled: true, apiKey: 'sk-or-saved-1234' });

    expect(applyDecisionModelConfigUpdate(current, { provider: DecisionModelProvider.TypeSafe }).apiKey)
      .toBe('sk-or-saved-1234');
    expect(applyDecisionModelConfigUpdate(current, { apiKey: '' }).apiKey).toBe('');
    expect(applyDecisionModelConfigUpdate(current, { apiKey: '  sk-new  ' }).apiKey).toBe('sk-new');
  });

  test('moves a key saved by older builds to the provider it was saved with', () => {
    expect(normalizeDecisionModelConfig({
      enabled: true,
      provider: DecisionModelProvider.OpenRouter,
      endpoint: '',
      apiKey: '  sk-or-legacy  ',
    })).toEqual({
      enabled: true,
      provider: DecisionModelProvider.OpenRouter,
      endpoint: '',
      apiKey: 'sk-or-legacy',
      apiKeys: { [DecisionModelProvider.OpenRouter]: 'sk-or-legacy' },
    });
  });

  test('keeps each provider key when switching providers', () => {
    const legacy = normalizeDecisionModelConfig({
      enabled: true,
      provider: DecisionModelProvider.OpenRouter,
      apiKey: 'sk-or-1',
    });

    const typeSafe = applyDecisionModelConfigUpdate(legacy, {
      provider: DecisionModelProvider.TypeSafe,
      apiKey: 'ts-1',
    });
    expect(typeSafe.apiKey).toBe('ts-1');
    expect(typeSafe.apiKeys).toEqual({
      [DecisionModelProvider.OpenRouter]: 'sk-or-1',
      [DecisionModelProvider.TypeSafe]: 'ts-1',
    });

    // A saved config round-trips through the store, then switches back.
    const reloaded = normalizeDecisionModelConfig(JSON.parse(JSON.stringify(typeSafe)));
    expect(applyDecisionModelConfigUpdate(reloaded, { provider: DecisionModelProvider.OpenRouter }).apiKey)
      .toBe('sk-or-1');
    expect(applyDecisionModelConfigUpdate(reloaded, { provider: DecisionModelProvider.Compatible }).apiKey)
      .toBe('');
  });

  test('sets and clears per-provider keys, ignoring unknown or malformed entries', () => {
    const current = normalizeDecisionModelConfig({
      provider: DecisionModelProvider.TypeSafe,
      apiKeys: {
        [DecisionModelProvider.TypeSafe]: 'ts-1',
        [DecisionModelProvider.OpenRouter]: 'sk-or-1',
      },
    });

    const next = applyDecisionModelConfigUpdate(current, {
      apiKeys: {
        [DecisionModelProvider.TypeSafe]: '  ts-2  ',
        [DecisionModelProvider.OpenRouter]: '',
        [DecisionModelProvider.Compatible]: 42,
        bogus: 'x',
      },
    });
    expect(next.apiKeys).toEqual({ [DecisionModelProvider.TypeSafe]: 'ts-2' });
    expect(next.apiKey).toBe('ts-2');
  });

  test('prefers stored per-provider keys over the mirrored single key', () => {
    const config = normalizeDecisionModelConfig({
      provider: DecisionModelProvider.TypeSafe,
      apiKey: 'stale',
      apiKeys: { [DecisionModelProvider.OpenRouter]: 'sk-or-1' },
    });

    expect(config.apiKey).toBe('');
    expect(config.apiKeys).toEqual({ [DecisionModelProvider.OpenRouter]: 'sk-or-1' });
  });

  test('ignores malformed update fields instead of resetting them', () => {
    const current = {
      ...DEFAULT_DECISION_MODEL_CONFIG,
      enabled: true,
      provider: DecisionModelProvider.TypeSafe,
    };

    expect(applyDecisionModelConfigUpdate(current, { provider: 'bogus', enabled: 'no' })).toEqual(current);
    expect(applyDecisionModelConfigUpdate(current, null)).toEqual(current);
  });

  test('is active only when enabled with a key, plus a valid endpoint for compatible providers', () => {
    const enabledWithKey = { ...DEFAULT_DECISION_MODEL_CONFIG, enabled: true, apiKey: 'key' };

    expect(isDecisionModelActive({ ...DEFAULT_DECISION_MODEL_CONFIG, enabled: true })).toBe(false);
    expect(isDecisionModelActive({ ...enabledWithKey, enabled: false })).toBe(false);
    expect(isDecisionModelActive(enabledWithKey)).toBe(true);
    expect(isDecisionModelActive({
      ...enabledWithKey,
      provider: DecisionModelProvider.Compatible,
      endpoint: 'not a url',
    })).toBe(false);
    expect(isDecisionModelActive({
      ...enabledWithKey,
      provider: DecisionModelProvider.Compatible,
      endpoint: RELAY_ENDPOINT,
    })).toBe(true);
  });

  test('accepts only credential-free http(s) endpoints', () => {
    expect(isValidDecisionEndpoint(RELAY_ENDPOINT)).toBe(true);
    expect(isValidDecisionEndpoint('http://127.0.0.1:3000/v1/systemone')).toBe(true);
    expect(isValidDecisionEndpoint('ftp://relay.example.com/v1/systemone')).toBe(false);
    expect(isValidDecisionEndpoint('https://user:pass@relay.example.com/v1/systemone')).toBe(false);
    expect(isValidDecisionEndpoint('')).toBe(false);
  });

  test('defaults to the official TypeSafe provider', () => {
    expect(DEFAULT_DECISION_MODEL_CONFIG.provider).toBe(DecisionModelProvider.TypeSafe);
  });

  test('returns the saved keys for the settings field, like provider settings', () => {
    expect(toDecisionModelConfigView(normalizeDecisionModelConfig({
      enabled: true,
      apiKeys: {
        [DecisionModelProvider.TypeSafe]: 'ts-abcdef123456',
        [DecisionModelProvider.OpenRouter]: 'sk-or-abcdef',
      },
    }))).toEqual({
      enabled: true,
      provider: DecisionModelProvider.TypeSafe,
      endpoint: '',
      apiKey: 'ts-abcdef123456',
      apiKeys: {
        [DecisionModelProvider.TypeSafe]: 'ts-abcdef123456',
        [DecisionModelProvider.OpenRouter]: 'sk-or-abcdef',
      },
      active: true,
    });
  });
});
