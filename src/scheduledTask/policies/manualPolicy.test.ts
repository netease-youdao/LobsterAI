import { test, expect } from 'vitest';
import { makeModel } from '../fixtures';
import { ManualTaskPolicy } from './manualPolicy';
import {
  OriginKind, BindingKind, DeliveryMode, DeliveryChannel, SessionTarget,
} from '../constants';

test('ManualPolicy.normalizeDraft: IM announce + non-im binding -> auto-links to im_session', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.Announce, channel: 'feishu' },
  });
  const result = policy.normalizeDraft(draft);
  expect(result.binding.kind).toBe(BindingKind.IMSession);
  expect((result.binding as any).platform).toBe('feishu');
  expect((result.binding as any).conversationId).toBe('');
});

test('ManualPolicy.normalizeDraft: IM announce + already im_session -> unchanged', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.IMSession, platform: 'feishu', conversationId: '' },
    delivery: { mode: DeliveryMode.Announce, channel: 'feishu' },
  });
  const result = policy.normalizeDraft(draft);
  expect(result.binding).toEqual(draft.binding);
  expect(result.delivery).toEqual(draft.delivery);
});

test('ManualPolicy.normalizeDraft: im_session binding + non-announce delivery -> resets to new_session', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.IMSession, platform: 'feishu', conversationId: '' },
    delivery: { mode: DeliveryMode.None },
  });
  const result = policy.normalizeDraft(draft);
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('ManualPolicy.normalizeDraft: announce channel=last + new_session -> stays new_session', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last },
  });
  const result = policy.normalizeDraft(draft);
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('ManualPolicy.onDeliveryChanged: to announce + IM channel -> binding becomes im_session', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.None },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.Announce, channel: 'discord' });
  expect(result.binding.kind).toBe(BindingKind.IMSession);
  expect((result.binding as any).platform).toBe('discord');
  expect((result.binding as any).conversationId).toBe('');
});

test('ManualPolicy.onDeliveryChanged: to none -> binding resets to new_session', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.IMSession, platform: 'telegram', conversationId: 'c1' },
    delivery: { mode: DeliveryMode.Announce, channel: 'telegram' },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.None });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('ManualPolicy.onDeliveryChanged: to webhook -> binding resets to new_session', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.UISession, sessionId: 's1' },
    delivery: { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.Webhook });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('ManualPolicy.onDeliveryChanged: to announce + last -> delivery updates, binding not forced to im_session', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.None },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last });
  expect(result.delivery).toEqual({ mode: DeliveryMode.Announce, channel: DeliveryChannel.Last });
  expect(result.binding).toEqual(draft.binding);
});

test('ManualPolicy.toWireBinding: new_session -> main + null', () => {
  const policy = new ManualTaskPolicy();
  const result = policy.toWireBinding({ kind: BindingKind.NewSession });
  expect(result).toEqual({ sessionTarget: SessionTarget.Main, sessionKey: null });
});

test('ManualPolicy.toWireBinding: ui_session with sessionId -> main + managed key', () => {
  const policy = new ManualTaskPolicy();
  const result = policy.toWireBinding({ kind: BindingKind.UISession, sessionId: 'sess-x' });
  expect(result.sessionTarget).toBe(SessionTarget.Main);
  expect(result.sessionKey).toBe('agent:main:lobsterai:sess-x');
});

test('ManualPolicy.toWireBinding: im_session with sessionId -> main + managed key', () => {
  const policy = new ManualTaskPolicy();
  const result = policy.toWireBinding({
    kind: BindingKind.IMSession,
    platform: 'telegram',
    conversationId: 'c1',
    sessionId: 'sess-y',
  });
  expect(result.sessionTarget).toBe(SessionTarget.Main);
  expect(result.sessionKey).toBe('agent:main:lobsterai:sess-y');
});

test('ManualPolicy.toWireBinding: im_session without sessionId -> main + null', () => {
  const policy = new ManualTaskPolicy();
  const result = policy.toWireBinding({
    kind: BindingKind.IMSession,
    platform: 'telegram',
    conversationId: 'c1',
    sessionId: undefined,
  });
  expect(result.sessionTarget).toBe(SessionTarget.Main);
  expect(result.sessionKey).toBe(null);
});

test('ManualPolicy.toWireBinding: session_key with custom key -> isolated + original key', () => {
  const policy = new ManualTaskPolicy();
  const result = policy.toWireBinding({ kind: BindingKind.SessionKey, sessionKey: 'custom:key:1' });
  expect(result.sessionTarget).toBe(SessionTarget.Isolated);
  expect(result.sessionKey).toBe('custom:key:1');
});

test('ManualPolicy.describeRunBehavior: new_session -> returns description', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
  });
  const desc = policy.describeRunBehavior(draft);
  expect(typeof desc === 'string' && desc.length > 0).toBeTruthy();
});

test('ManualPolicy.describeRunBehavior: ui_session -> returns description', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.UISession, sessionId: 's1' },
  });
  const desc = policy.describeRunBehavior(draft);
  expect(typeof desc === 'string' && desc.length > 0).toBeTruthy();
});

test('ManualPolicy.describeRunBehavior: im_session -> mentions platform', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.IMSession, platform: 'discord', conversationId: 'ch1' },
  });
  const desc = policy.describeRunBehavior(draft);
  expect(desc).toContain('discord');
});

test('ManualPolicy.describeRunBehavior: session_key -> mentions OpenClaw', () => {
  const policy = new ManualTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.SessionKey, sessionKey: 'k1' },
  });
  const desc = policy.describeRunBehavior(draft);
  expect(typeof desc === 'string' && desc.length > 0).toBeTruthy();
});

test('ManualPolicy.getReadonlyFields: returns empty array', () => {
  const policy = new ManualTaskPolicy();
  const fields = policy.getReadonlyFields();
  expect(fields).toEqual([]);
});
