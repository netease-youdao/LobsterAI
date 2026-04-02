import { describe, expect, test } from 'vitest';
import {
  normalizePositiveInteger,
  normalizeProviderModels,
} from './config';

describe('normalizePositiveInteger', () => {
  test('returns undefined for non-positive or invalid values', () => {
    expect(normalizePositiveInteger(undefined)).toBeUndefined();
    expect(normalizePositiveInteger(null)).toBeUndefined();
    expect(normalizePositiveInteger('1024')).toBeUndefined();
    expect(normalizePositiveInteger(0)).toBeUndefined();
    expect(normalizePositiveInteger(-1)).toBeUndefined();
    expect(normalizePositiveInteger(Number.NaN)).toBeUndefined();
    expect(normalizePositiveInteger(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test('keeps finite positive integers and floors decimals', () => {
    expect(normalizePositiveInteger(1)).toBe(1);
    expect(normalizePositiveInteger(8192)).toBe(8192);
    expect(normalizePositiveInteger(1024.9)).toBe(1024);
  });
});

describe('normalizeProviderModels', () => {
  test('normalizes supportsImage and token metadata', () => {
    expect(normalizeProviderModels([
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        contextWindow: 65536.9,
        maxTokens: 8192.2,
      },
      {
        id: 'broken-model',
        name: 'Broken Model',
        supportsImage: true,
        contextWindow: -1,
        maxTokens: Number.NaN,
      },
    ])).toEqual([
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        supportsImage: false,
        contextWindow: 65536,
        maxTokens: 8192,
      },
      {
        id: 'broken-model',
        name: 'Broken Model',
        supportsImage: true,
      },
    ]);
  });

  test('returns undefined when models are missing', () => {
    expect(normalizeProviderModels()).toBeUndefined();
  });
});
