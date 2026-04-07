import { test, expect } from 'vitest';
import {
  RendererKvStoreKey,
  isAllowedRendererKvStoreKey,
} from './rendererKvStoreKeys';

test('isAllowedRendererKvStoreKey accepts renderer keys only', () => {
  expect(isAllowedRendererKvStoreKey(RendererKvStoreKey.AppConfig)).toBe(true);
  expect(isAllowedRendererKvStoreKey(RendererKvStoreKey.ProvidersExportKey)).toBe(
    true,
  );
  expect(isAllowedRendererKvStoreKey(RendererKvStoreKey.PrivacyAgreed)).toBe(true);
});

test('isAllowedRendererKvStoreKey rejects sensitive and unknown keys', () => {
  expect(isAllowedRendererKvStoreKey('auth_tokens')).toBe(false);
  expect(isAllowedRendererKvStoreKey('enterprise_config')).toBe(false);
  expect(isAllowedRendererKvStoreKey('skills_state')).toBe(false);
  expect(isAllowedRendererKvStoreKey('')).toBe(false);
  expect(isAllowedRendererKvStoreKey(null)).toBe(false);
});
