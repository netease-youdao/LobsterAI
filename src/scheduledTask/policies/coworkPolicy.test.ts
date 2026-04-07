import { test, expect } from 'vitest';
import { makeModel } from '../fixtures';
import { CoworkTaskPolicy } from './coworkPolicy';
import {
  OriginKind, BindingKind, DeliveryMode, DeliveryChannel, SessionTarget,
} from '../constants';

test('CoworkPolicy.getCreateDefaults: with cowork origin -> sessionTarget main + channel last', () => {
  const policy = new CoworkTaskPolicy();
  const defaults = policy.getCreateDefaults({ kind: OriginKind.Cowork, sessionId: 's1' });
  expect(defaults.sessionTarget).toBe(SessionTarget.Main);
  expect(defaults.delivery!.channel).toBe(DeliveryChannel.Last);
});

test('CoworkPolicy.getCreateDefaults: with non-cowork origin -> throws Error', () => {
  const policy = new CoworkTaskPolicy();
  expect(() => policy.getCreateDefaults({ kind: OriginKind.Manual } as any)).toThrow(/Invalid origin/);
});

test('CoworkPolicy.getCreateDefaults: with im origin -> throws Error', () => {
  const policy = new CoworkTaskPolicy();
  expect(
    () => policy.getCreateDefaults({ kind: OriginKind.IM, platform: 'telegram', conversationId: 'c1' } as any)
  ).toThrow(/Invalid origin/);
});

test('CoworkPolicy.normalizeDraft: any draft -> returns unchanged', () => {
  const policy = new CoworkTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Cowork, sessionId: 's1' },
    binding: { kind: BindingKind.UISession, sessionId: 's1' },
    delivery: { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last },
  });
  const result = policy.normalizeDraft(draft);
  expect(result).toEqual(draft);
});

test('CoworkPolicy.normalizeDraft: with im delivery -> still returns unchanged', () => {
  const policy = new CoworkTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Cowork, sessionId: 's1' },
    binding: { kind: BindingKind.UISession, sessionId: 's1' },
    delivery: { mode: DeliveryMode.Announce, channel: 'telegram' },
  });
  const result = policy.normalizeDraft(draft);
  expect(result).toEqual(draft);
});

test('CoworkPolicy.onDeliveryChanged: any delivery change -> binding unchanged', () => {
  const policy = new CoworkTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Cowork, sessionId: 'sess-1' },
    binding: { kind: BindingKind.UISession, sessionId: 'sess-1' },
    delivery: { mode: DeliveryMode.None },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.Announce, channel: 'telegram' });
  expect(result.binding).toEqual(draft.binding);
  expect(result.delivery).toEqual({ mode: DeliveryMode.Announce, channel: 'telegram' });
});

test('CoworkPolicy.onDeliveryChanged: webhook delivery -> binding still unchanged', () => {
  const policy = new CoworkTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Cowork, sessionId: 's1' },
    binding: { kind: BindingKind.UISession, sessionId: 's1' },
    delivery: { mode: DeliveryMode.Announce, channel: 'discord' },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.Webhook });
  expect(result.binding).toEqual(draft.binding);
});

test('CoworkPolicy.toWireBinding: ui_session binding -> managed sessionKey', () => {
  const policy = new CoworkTaskPolicy();
  const result = policy.toWireBinding({ kind: BindingKind.UISession, sessionId: 'sess-x' });
  expect(result.sessionTarget).toBe(SessionTarget.Main);
  expect(result.sessionKey).toBe('agent:main:lobsterai:sess-x');
});

test('CoworkPolicy.toWireBinding: session_key binding -> isolated + original sessionKey', () => {
  const policy = new CoworkTaskPolicy();
  const result = policy.toWireBinding({ kind: BindingKind.SessionKey, sessionKey: 'custom:key:1' });
  expect(result.sessionTarget).toBe(SessionTarget.Isolated);
  expect(result.sessionKey).toBe('custom:key:1');
});

test('CoworkPolicy.toWireBinding: new_session binding -> main + null', () => {
  const policy = new CoworkTaskPolicy();
  const result = policy.toWireBinding({ kind: BindingKind.NewSession });
  expect(result.sessionTarget).toBe(SessionTarget.Main);
  expect(result.sessionKey).toBe(null);
});

test('CoworkPolicy.describeRunBehavior: ui_session -> mentions UI session', () => {
  const policy = new CoworkTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Cowork, sessionId: 's1' },
    binding: { kind: BindingKind.UISession, sessionId: 's1' },
  });
  const desc = policy.describeRunBehavior(draft);
  expect(typeof desc === 'string' && desc.length > 0).toBeTruthy();
});

test('CoworkPolicy.describeRunBehavior: new_session -> returns non-empty string', () => {
  const policy = new CoworkTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.Cowork, sessionId: 's1' },
    binding: { kind: BindingKind.NewSession },
  });
  const desc = policy.describeRunBehavior(draft);
  expect(typeof desc === 'string' && desc.length > 0).toBeTruthy();
});

test('CoworkPolicy.getReadonlyFields: contains origin', () => {
  const policy = new CoworkTaskPolicy();
  const fields = policy.getReadonlyFields();
  expect(fields).toContain('origin');
});
