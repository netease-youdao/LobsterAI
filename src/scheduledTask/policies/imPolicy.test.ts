import { test, expect } from 'vitest';
import { makeModel } from '../fixtures';
import { IMTaskPolicy } from './imPolicy';
import {
  OriginKind, BindingKind, DeliveryMode, SessionTarget,
} from '../constants';

test('IMPolicy.getCreateDefaults: with im origin -> delivery defaults to announce + platform', () => {
  const policy = new IMTaskPolicy();
  const defaults = policy.getCreateDefaults({
    kind: OriginKind.IM,
    platform: 'discord',
    conversationId: 'c1',
  });
  expect(defaults.delivery!.mode).toBe(DeliveryMode.Announce);
  expect(defaults.delivery!.channel).toBe('discord');
  expect(defaults.sessionTarget).toBe(SessionTarget.Main);
});

test('IMPolicy.getCreateDefaults: with telegram origin -> channel is telegram', () => {
  const policy = new IMTaskPolicy();
  const defaults = policy.getCreateDefaults({
    kind: OriginKind.IM,
    platform: 'telegram',
    conversationId: 'chat-123',
  });
  expect(defaults.delivery!.channel).toBe('telegram');
});

test('IMPolicy.getCreateDefaults: with non-im origin -> throws Error', () => {
  const policy = new IMTaskPolicy();
  expect(() => policy.getCreateDefaults({ kind: OriginKind.Manual } as any)).toThrow(/Invalid origin/);
});

test('IMPolicy.getCreateDefaults: with cowork origin -> throws Error', () => {
  const policy = new IMTaskPolicy();
  expect(() => policy.getCreateDefaults({ kind: OriginKind.Cowork, sessionId: 's1' } as any)).toThrow(/Invalid origin/);
});

test('IMPolicy.normalizeDraft: binding platform != delivery channel -> corrects delivery.channel', () => {
  const policy = new IMTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.IM, platform: 'telegram', conversationId: 'c1' },
    binding: { kind: BindingKind.IMSession, platform: 'telegram', conversationId: 'c1' },
    delivery: { mode: DeliveryMode.Announce, channel: 'feishu' },
  });
  const result = policy.normalizeDraft(draft);
  expect(result.delivery.channel).toBe('telegram');
  expect(result.delivery.mode).toBe(DeliveryMode.Announce);
});

test('IMPolicy.normalizeDraft: already consistent -> returns unchanged', () => {
  const policy = new IMTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.IM, platform: 'discord', conversationId: 'ch1' },
    binding: { kind: BindingKind.IMSession, platform: 'discord', conversationId: 'ch1' },
    delivery: { mode: DeliveryMode.Announce, channel: 'discord' },
  });
  const result = policy.normalizeDraft(draft);
  expect(result.delivery).toEqual(draft.delivery);
  expect(result.binding).toEqual(draft.binding);
});

test('IMPolicy.normalizeDraft: binding not im_session -> returns unchanged', () => {
  const policy = new IMTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.IM, platform: 'telegram', conversationId: 'c1' },
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.Announce, channel: 'feishu' },
  });
  const result = policy.normalizeDraft(draft);
  expect(result).toEqual(draft);
});

test('IMPolicy.onDeliveryChanged: from announce to none -> binding resets to new_session', () => {
  const policy = new IMTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.IM, platform: 'telegram', conversationId: 'c1' },
    binding: { kind: BindingKind.IMSession, platform: 'telegram', conversationId: 'c1' },
    delivery: { mode: DeliveryMode.Announce, channel: 'telegram' },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.None });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
  expect(result.delivery.mode).toBe(DeliveryMode.None);
});

test('IMPolicy.onDeliveryChanged: from announce to different IM channel -> binding.platform updates', () => {
  const policy = new IMTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.IM, platform: 'telegram', conversationId: 'c1' },
    binding: { kind: BindingKind.IMSession, platform: 'telegram', conversationId: 'c1' },
    delivery: { mode: DeliveryMode.Announce, channel: 'telegram' },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.Announce, channel: 'discord' });
  expect(result.binding.kind).toBe(BindingKind.IMSession);
  expect((result.binding as any).platform).toBe('discord');
  expect((result.binding as any).conversationId).toBe('c1');
});

test('IMPolicy.onDeliveryChanged: announce to webhook -> binding resets to new_session', () => {
  const policy = new IMTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.IM, platform: 'feishu', conversationId: 'c2' },
    binding: { kind: BindingKind.IMSession, platform: 'feishu', conversationId: 'c2' },
    delivery: { mode: DeliveryMode.Announce, channel: 'feishu' },
  });
  const result = policy.onDeliveryChanged(draft, { mode: DeliveryMode.Webhook });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('IMPolicy.toWireBinding: im_session with sessionId -> managed sessionKey', () => {
  const policy = new IMTaskPolicy();
  const result = policy.toWireBinding({
    kind: BindingKind.IMSession,
    platform: 'telegram',
    conversationId: 'c1',
    sessionId: 'sess-1',
  });
  expect(result.sessionTarget).toBe(SessionTarget.Main);
  expect(result.sessionKey).toBe('agent:main:lobsterai:sess-1');
});

test('IMPolicy.toWireBinding: im_session without sessionId -> sessionKey null', () => {
  const policy = new IMTaskPolicy();
  const result = policy.toWireBinding({
    kind: BindingKind.IMSession,
    platform: 'telegram',
    conversationId: 'c1',
    sessionId: undefined,
  });
  expect(result.sessionTarget).toBe(SessionTarget.Main);
  expect(result.sessionKey).toBe(null);
});

test('IMPolicy.toWireBinding: new_session -> sessionKey null', () => {
  const policy = new IMTaskPolicy();
  const result = policy.toWireBinding({ kind: BindingKind.NewSession });
  expect(result.sessionTarget).toBe(SessionTarget.Main);
  expect(result.sessionKey).toBe(null);
});

test('IMPolicy.describeRunBehavior: im_session binding -> contains platform name', () => {
  const policy = new IMTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.IM, platform: 'discord', conversationId: 'ch1' },
    binding: { kind: BindingKind.IMSession, platform: 'discord', conversationId: 'ch1' },
  });
  const desc = policy.describeRunBehavior(draft);
  expect(desc).toContain('discord');
});

test('IMPolicy.describeRunBehavior: new_session binding -> generic text', () => {
  const policy = new IMTaskPolicy();
  const draft = makeModel({
    origin: { kind: OriginKind.IM, platform: 'telegram', conversationId: 'c1' },
    binding: { kind: BindingKind.NewSession },
  });
  const desc = policy.describeRunBehavior(draft);
  expect(typeof desc === 'string' && desc.length > 0).toBeTruthy();
});

test('IMPolicy.getReadonlyFields: contains origin', () => {
  const policy = new IMTaskPolicy();
  const fields = policy.getReadonlyFields();
  expect(fields).toContain('origin');
});
