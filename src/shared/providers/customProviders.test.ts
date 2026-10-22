import { describe, expect, test } from 'vitest';

import { ApiFormat, ProviderName } from './constants';
import {
  isCustomProviderKey,
  normalizeGeminiApiBaseUrl,
  supportsGeminiApiFormatSelection,
  usesCustomGeminiApiFormat,
} from './customProviders';

describe('custom provider helpers', () => {
  test('recognizes custom provider keys', () => {
    expect(isCustomProviderKey('custom_0')).toBe(true);
    expect(isCustomProviderKey('custom_29')).toBe(true);
    expect(isCustomProviderKey(ProviderName.Custom)).toBe(false);
    expect(isCustomProviderKey('custom_x')).toBe(false);
  });

  test('offers the Gemini API format only on custom providers', () => {
    expect(supportsGeminiApiFormatSelection('custom_0')).toBe(true);
    expect(supportsGeminiApiFormatSelection(ProviderName.Gemini)).toBe(false);
    expect(usesCustomGeminiApiFormat('custom_0', ApiFormat.Gemini)).toBe(true);
    expect(usesCustomGeminiApiFormat('custom_0', ApiFormat.OpenAI)).toBe(false);
    expect(usesCustomGeminiApiFormat(ProviderName.DeepSeek, ApiFormat.Gemini)).toBe(false);
  });

  test.each([
    ['https://relay.example.com', 'https://relay.example.com/v1beta'],
    ['https://relay.example.com/', 'https://relay.example.com/v1beta'],
    ['https://relay.example.com/gemini', 'https://relay.example.com/gemini/v1beta'],
    ['https://relay.example.com/gemini/v1beta', 'https://relay.example.com/gemini/v1beta'],
    ['https://relay.example.com/v1', 'https://relay.example.com/v1'],
    ['https://relay.example.com/v1alpha', 'https://relay.example.com/v1alpha'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta'],
    ['https://relay.example.com/v1beta/models/gemini-3-pro:generateContent', 'https://relay.example.com/v1beta'],
    ['', ''],
  ])('normalizes Gemini base URL %s', (input, expected) => {
    expect(normalizeGeminiApiBaseUrl(input)).toBe(expected);
  });
});
