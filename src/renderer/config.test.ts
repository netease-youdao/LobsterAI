import { test, expect } from 'vitest';
import {
  CUSTOM_PROVIDER_KEYS,
  CUSTOM_PROVIDER_MAX_COUNT,
  isCustomProvider,
  getCustomProviderDefaultName,
  getProviderDisplayName,
} from './config';

test('CUSTOM_PROVIDER_KEYS exposes 20 sparse custom provider slots', () => {
  expect(CUSTOM_PROVIDER_MAX_COUNT).toBe(20);
  expect(CUSTOM_PROVIDER_KEYS).toHaveLength(20);
  expect(CUSTOM_PROVIDER_KEYS[0]).toBe('custom_0');
  expect(CUSTOM_PROVIDER_KEYS[19]).toBe('custom_19');
});

test('isCustomProvider: custom_0 is custom', () => {
  expect(isCustomProvider('custom_0')).toBe(true);
});

test('isCustomProvider: custom_1 is custom', () => {
  expect(isCustomProvider('custom_1')).toBe(true);
});

test('isCustomProvider: custom_99 is custom', () => {
  expect(isCustomProvider('custom_99')).toBe(true);
});

test('isCustomProvider: openai is not custom', () => {
  expect(isCustomProvider('openai')).toBe(false);
});

test('isCustomProvider: deepseek is not custom', () => {
  expect(isCustomProvider('deepseek')).toBe(false);
});

test('isCustomProvider: empty string is not custom', () => {
  expect(isCustomProvider('')).toBe(false);
});

test('isCustomProvider: "custom" without underscore is not custom', () => {
  expect(isCustomProvider('custom')).toBe(false);
});

test('getCustomProviderDefaultName: custom_0 -> Custom0', () => {
  expect(getCustomProviderDefaultName('custom_0')).toBe('Custom0');
});

test('getCustomProviderDefaultName: custom_1 -> Custom1', () => {
  expect(getCustomProviderDefaultName('custom_1')).toBe('Custom1');
});

test('getCustomProviderDefaultName: custom_42 -> Custom42', () => {
  expect(getCustomProviderDefaultName('custom_42')).toBe('Custom42');
});

test('getCustomProviderDefaultName: custom_19 -> Custom19', () => {
  expect(getCustomProviderDefaultName('custom_19')).toBe('Custom19');
});

test('getProviderDisplayName: built-in provider capitalizes first letter', () => {
  expect(getProviderDisplayName('openai')).toBe('Openai');
});

test('getProviderDisplayName: built-in provider with no config', () => {
  expect(getProviderDisplayName('deepseek')).toBe('Deepseek');
});

test('getProviderDisplayName: custom provider without config uses default name', () => {
  expect(getProviderDisplayName('custom_0')).toBe('Custom0');
});

test('getProviderDisplayName: custom provider with empty displayName uses default', () => {
  expect(getProviderDisplayName('custom_0', { displayName: '' })).toBe('Custom0');
});

test('getProviderDisplayName: custom provider with displayName uses it', () => {
  expect(getProviderDisplayName('custom_0', { displayName: 'My GPT' })).toBe('My GPT');
});

test('getProviderDisplayName: custom provider with undefined displayName uses default', () => {
  expect(getProviderDisplayName('custom_2', { displayName: undefined })).toBe('Custom2');
});

