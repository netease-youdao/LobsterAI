import { test, expect } from 'vitest';
import { makeModel } from '../fixtures';
import { LegacyTaskPolicy } from './legacyPolicy';
import {
  OriginKind, BindingKind, DeliveryMode, DeliveryChannel,
  SessionTarget, WakeMode,
} from '../constants';

test('LegacyPolicy.getCreateDefaults: returns sessionTarget main + next-heartbeat wakeMode', () => {
  const policy = new LegacyTaskPolicy();
  const defaults = policy.getCreateDefaults();
  expect(defaults.sessionTarget).toBe(SessionTarget.Main);
  expect(defaults.wakeMode).toBe(WakeMode.NextHeartbeat);
});

test('LegacyPolicy.normalizeDraft: announce IM channel + new_session binding -> auto-links to im_session', () => {
  const policy = new LegacyTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Legacy },
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.Announce, channel: 'feishu' },
  });
  const result = policy.normalizeDraft(draft);
  expect(result.binding.kind).toBe(BindingKind.IMSession);
  expect((result.binding as any).platform).toBe('feishu');
  expect((result.binding as any).conversationId).toBe('');
});

test('LegacyPolicy.normalizeDraft: without IM channel -> returns draft unchanged', () => {
  const policy = new LegacyTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Legacy },
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.None },
  });
  const result = policy.normalizeDraft(draft);
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
  expect(result.delivery).toEqual(draft.delivery);
});

test('LegacyPolicy.normalizeDraft: channel=last is not an IM platform -> no binding change', () => {
  const policy = new LegacyTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Legacy },
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last },
  });
  const result = policy.normalizeDraft(draft);
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('LegacyPolicy.onDeliveryChanged: to mode=none -> binding resets to new_session', () => {
  const policy = new LegacyTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Legacy },
    binding: { kind: BindingKind.IMSession, platform: 'feishu', conversationId: '' },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.None });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
  expect(result.delivery.mode).toBe(DeliveryMode.None);
});

test('LegacyPolicy.onDeliveryChanged: to mode=webhook -> binding resets to new_session', () => {
  const policy = new LegacyTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Legacy },
    binding: { kind: BindingKind.IMSession, platform: 'discord', conversationId: '' },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.Webhook });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
  expect(result.delivery.mode).toBe(DeliveryMode.Webhook);
});

test('LegacyPolicy.onDeliveryChanged: to mode=announce -> draft updates normally', () => {
  const policy = new LegacyTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Legacy },
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.None },
  });
  const newDelivery = { mode: DeliveryMode.Announce as const, channel: 'telegram' };
  const result = policy.onDeliveryChanged(draft, newDelivery);
  expect(result.delivery).toEqual(newDelivery);
});

test('LegacyPolicy.toWireBinding: any binding -> always returns sessionTarget main + null sessionKey', () => {
  const policy = new LegacyTaskPolicy();

  const wireNew = policy.toWireBinding({ kind: BindingKind.NewSession });
  expect(wireNew.sessionTarget).toBe(SessionTarget.Main);
  expect(wireNew.sessionKey).toBe(null);

  const wireIm = policy.toWireBinding({
    kind: BindingKind.IMSession,
    platform: 'telegram',
    conversationId: 'c1',
    sessionId: 'sess-1',
  });
  expect(wireIm.sessionTarget).toBe(SessionTarget.Main);
  expect(wireIm.sessionKey).toBe(null);

  const wireSessionKey = policy.toWireBinding({ kind: BindingKind.SessionKey, sessionKey: 'custom:key' });
  expect(wireSessionKey.sessionTarget).toBe(SessionTarget.Main);
  expect(wireSessionKey.sessionKey).toBe(null);
});

test('LegacyPolicy.describeRunBehavior: returns non-empty string', () => {
  const policy = new LegacyTaskPolicy();
  const draft = makeModel({ origin: { kind: OriginKind.Legacy } });
  const desc = policy.describeRunBehavior(draft);
  expect(typeof desc === 'string' && desc.length > 0).toBeTruthy();
});

test('LegacyPolicy.getReadonlyFields: contains origin', () => {
  const policy = new LegacyTaskPolicy();
  const fields = policy.getReadonlyFields();
  expect(fields.includes('origin')).toBeTruthy();
});
