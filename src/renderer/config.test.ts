import { test, expect } from 'vitest';
import {
  isCustomProvider,
  getCustomProviderDefaultName,
  getProviderDisplayName,
} from './config';

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

