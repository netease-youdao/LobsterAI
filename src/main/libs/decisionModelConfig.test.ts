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
    const current = { ...DEFAULT_DECISION_MODEL_CONFIG, enabled: true, apiKey: 'sk-or-saved-1234' };

    expect(applyDecisionModelConfigUpdate(current, { provider: DecisionModelProvider.TypeSafe }).apiKey)
      .toBe('sk-or-saved-1234');
    expect(applyDecisionModelConfigUpdate(current, { apiKey: '' }).apiKey).toBe('');
    expect(applyDecisionModelConfigUpdate(current, { apiKey: '  sk-new  ' }).apiKey).toBe('sk-new');
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

  test('returns the saved key for the settings field, like provider settings', () => {
    expect(toDecisionModelConfigView({
      ...DEFAULT_DECISION_MODEL_CONFIG,
      enabled: true,
      apiKey: 'ts-abcdef123456',
    })).toEqual({
      enabled: true,
      provider: DecisionModelProvider.TypeSafe,
      endpoint: '',
      apiKey: 'ts-abcdef123456',
      active: true,
    });
  });
});
