import { test, expect } from 'vitest';
import { TaskPolicyRegistry, taskPolicyRegistry } from './registry';
import { ManualTaskPolicy } from './manualPolicy';
import { OriginKind } from '../constants';

test('registry: returns LegacyTaskPolicy for legacy origin', () => {
  const policy = taskPolicyRegistry.get({ kind: OriginKind.Legacy });
  expect(policy.kind).toBe(OriginKind.Legacy);
});

test('registry: returns IMTaskPolicy for im origin', () => {
  const policy = taskPolicyRegistry.get({ kind: OriginKind.IM, platform: 'telegram', conversationId: 'c1' });
  expect(policy.kind).toBe(OriginKind.IM);
});

test('registry: returns CoworkTaskPolicy for cowork origin', () => {
  const policy = taskPolicyRegistry.get({ kind: OriginKind.Cowork, sessionId: 's1' });
  expect(policy.kind).toBe(OriginKind.Cowork);
});

test('registry: returns ManualTaskPolicy for manual origin', () => {
  const policy = taskPolicyRegistry.get({ kind: OriginKind.Manual });
  expect(policy.kind).toBe(OriginKind.Manual);
});

test('registry: unknown origin kind falls back to manual', () => {
  const policy = taskPolicyRegistry.get({ kind: 'future_unknown' } as any);
  expect(policy.kind).toBe(OriginKind.Manual);
});

test('registry: custom registry with subset of policies works', () => {
  const reg = new TaskPolicyRegistry([new ManualTaskPolicy()]);
  const policy = reg.get({ kind: OriginKind.Manual });
  expect(policy.kind).toBe(OriginKind.Manual);
});
