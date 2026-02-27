import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldUseAnthropicConnectionProbe } = require('../dist-electron/libs/providerProbeFormat.js');

test('antigravity with openai apiType should use anthropic probe path', () => {
  assert.equal(shouldUseAnthropicConnectionProbe('antigravity', 'openai'), true);
});

test('antigravity with anthropic apiType should use anthropic probe path', () => {
  assert.equal(shouldUseAnthropicConnectionProbe('antigravity', 'anthropic'), true);
});

test('openai with openai apiType should not use anthropic probe path', () => {
  assert.equal(shouldUseAnthropicConnectionProbe('openai', 'openai'), false);
});

test('openai with anthropic apiType should use anthropic probe path', () => {
  assert.equal(shouldUseAnthropicConnectionProbe('openai', 'anthropic'), true);
});

test('other providers follow apiFormat', () => {
  assert.equal(shouldUseAnthropicConnectionProbe('qwen', 'openai'), false);
  assert.equal(shouldUseAnthropicConnectionProbe('qwen', 'anthropic'), true);
});

