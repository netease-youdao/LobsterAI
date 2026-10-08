import { describe, expect, test } from 'vitest';

import { withManagedOpenClawModelPolicy } from './openclawManagedModelPolicy';

type Fixture = {
  agents: { defaults: {
    models: Record<string, { alias?: string; params?: Record<string, unknown> }>;
    modelPolicy?: { allow?: string[] };
  } };
  meta?: { migrations?: Record<string, unknown> };
};
const fixture = (refs: string[]): Fixture => ({
  agents: { defaults: { models: Object.fromEntries(refs.map(ref => [ref, {}])) } },
});
const sync = (next: Fixture, previous: Fixture = next): Fixture => (
  withManagedOpenClawModelPolicy(next, previous) as Fixture
);

describe('legacy model policy compatibility', () => {
  test.each([
    'custom_0/DeepSeek V4 Pro', 'custom_0/model\tname', 'custom_0/model\u007f',
    'custom_0/model\nname', 'custom_0/model\rname', 'custom_0/model\u00a0name',
    'custom_0/model\u3000name', 'custom_0/model\ufeffname', 'custom_0/model\u0000name',
    'custom_0/model\u001fname', 'pro\u001fvider/model',
    'custom_0//model', 'custom_0/', '/model', 'unresolved-alias',
    'provider/model*', 'provider/*/nested', 'provider/a /b',
    'provider/**', '*/model', 'provider//model', 'provider/model/',
  ])('retains the entire legacy map when %j cannot be materialized', ref => {
    const original = fixture(['qwen/qwen3.6-plus', ref]);
    const next = sync(original);
    expect(next.agents.defaults.models).toEqual(original.agents.defaults.models);
    expect(next.agents.defaults.modelPolicy).toBeUndefined();
    expect(next.meta?.migrations?.modelPolicyAllowlist).toBeUndefined();
    expect(sync(next)).toEqual(next);
  });

  test.each([
    'custom_0/deepseek-v4-pro', 'openrouter/openai/gpt-oss-120b:free',
    'provider/a/b/c/d/e/f', 'provider / model', 'provider/*', ' provider / namespace / * ',
    'openrouter:auto', 'openrouter:free',
    'provider/model:free@2026.09-22_v2+q4', 'provider/模型-v1', 'provider/mo\u200bdel',
  ])('materializes supported policy reference %j', ref => {
    const next = sync(fixture([ref]));
    expect(next.agents.defaults.modelPolicy).toEqual({ allow: [ref] });
    expect(next.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  test('resolves configured aliases without accepting arbitrary bare references', () => {
    const original = fixture(['anthropic/claude-sonnet-4-6', 'Sonnet']);
    original.agents.defaults.models['anthropic/claude-sonnet-4-6'].alias = 'sonnet';
    expect(sync(original).agents.defaults.modelPolicy?.allow).toEqual(Object.keys(original.agents.defaults.models));
  });

  test('repairs the complete generated invalid policy and clears only its migration marker', () => {
    const refs = ['qwen/qwen3.6-plus', 'custom_0/DeepSeek V4 Pro'];
    const previous = fixture(refs);
    previous.agents.defaults.modelPolicy = { allow: [...refs].reverse() };
    previous.meta = { migrations: { modelPolicyAllowlist: true, unrelated: true } };
    const next = sync(fixture(refs), previous);
    expect(next.agents.defaults.models).toEqual(previous.agents.defaults.models);
    expect(next.agents.defaults.modelPolicy).toBeUndefined();
    expect(next.meta?.migrations).toEqual({ unrelated: true });
    expect(sync(next)).toEqual(next);
  });

  test('defers the whole managed policy when an invalid model is added, then completes after correction', () => {
    const before = sync(fixture(['qwen/qwen3.6-plus']));
    const deferred = sync(fixture(['qwen/qwen3.6-plus', 'custom_0/DeepSeek V4 Pro']), before);
    expect(deferred.agents.defaults.modelPolicy).toBeUndefined();
    expect(deferred.meta?.migrations?.modelPolicyAllowlist).toBeUndefined();
    const corrected = sync(fixture(['qwen/qwen3.6-plus', 'custom_0/deepseek-v4-pro']), deferred);
    expect(corrected.agents.defaults.modelPolicy?.allow).toEqual(Object.keys(corrected.agents.defaults.models));
    expect(corrected.meta?.migrations?.modelPolicyAllowlist).toBe(true);
    expect(sync(corrected)).toEqual(corrected);
  });

  test.each([
    { allow: ['qwen/*'] }, { allow: ['unresolved user policy'] }, { allow: [] }, {},
  ])('preserves authored policy %j despite an invalid legacy model key', policy => {
    const previous = fixture(['qwen/qwen3.6-plus', 'custom_0/DeepSeek V4 Pro']);
    previous.agents.defaults.modelPolicy = policy;
    previous.meta = { migrations: { modelPolicyAllowlist: true } };
    const next = sync(previous);
    expect(next.agents.defaults.modelPolicy).toEqual(policy);
    expect(next.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  test('keeps a migrated unrestricted model map unrestricted', () => {
    const previous = fixture(['custom_0/DeepSeek V4 Pro']);
    previous.meta = { migrations: { modelPolicyAllowlist: true } };
    const next = sync(previous);
    expect(next.agents.defaults.modelPolicy).toBeUndefined();
    expect(next.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });
});
