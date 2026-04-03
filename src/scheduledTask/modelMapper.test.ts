import { test, expect } from 'vitest';
import { makeTask, makeModel } from './fixtures';
import { TaskModelMapper } from './modelMapper';
import { ManualTaskPolicy } from './policies/manualPolicy';
import { CoworkTaskPolicy } from './policies/coworkPolicy';
import {
  OriginKind, BindingKind, ScheduleKind, PayloadKind,
  DeliveryMode, DeliveryChannel, SessionTarget, WakeMode,
} from './constants';

const mapper = new TaskModelMapper();
const manualPolicy = new ManualTaskPolicy();
const coworkPolicy = new CoworkTaskPolicy();

test('mapper.fromWire: with explicit meta, uses meta directly', () => {
  const wire = makeTask({ sessionKey: null });
  const meta = {
    origin: { kind: OriginKind.Cowork as const, sessionId: 'sess-x' },
    binding: { kind: BindingKind.UISession as const, sessionId: 'sess-x' },
  };
  const model = mapper.fromWire(wire, meta);
  expect(model.origin).toEqual(meta.origin);
  expect(model.binding).toEqual(meta.binding);
  expect(model.id).toBe(wire.id);
  expect(model.name).toBe(wire.name);
});

test('mapper.fromWire: without meta, falls back to infer', () => {
  const wire = makeTask({ sessionKey: 'agent:main:lobsterai:sess-1' });
  const model = mapper.fromWire(wire);
  expect(model.origin.kind).toBe(OriginKind.Cowork);
  expect(model.binding.kind).toBe(BindingKind.UISession);
});

test('mapper.fromWire: preserves all wire fields', () => {
  const wire = makeTask({
    name: 'My Task',
    description: 'Test desc',
    schedule: { kind: ScheduleKind.Cron, expr: '*/5 * * * *' },
    payload: { kind: PayloadKind.AgentTurn, message: 'work', timeoutSeconds: 120 },
    delivery: { mode: DeliveryMode.Announce, channel: 'feishu' },
  });
  const model = mapper.fromWire(wire, { origin: { kind: OriginKind.Manual }, binding: { kind: BindingKind.NewSession } });
  expect(model.name).toBe('My Task');
  expect(model.description).toBe('Test desc');
  expect(model.schedule).toEqual({ kind: ScheduleKind.Cron, expr: '*/5 * * * *' });
  expect(model.delivery.channel).toBe('feishu');
});

test('mapper.toWireInput: new_session binding -> sessionKey null', () => {
  const model = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
    name: 'Test',
  });
  const wire = mapper.toWireInput(model, manualPolicy);
  expect(wire.sessionTarget).toBe(SessionTarget.Main);
  expect(wire.sessionKey).toBe(null);
  expect(wire.name).toBe('Test');
});

test('mapper.toWireInput: ui_session binding -> managed sessionKey', () => {
  const model = makeModel({
    origin: { kind: OriginKind.Cowork, sessionId: 'sess-x' },
    binding: { kind: BindingKind.UISession, sessionId: 'sess-x' },
  });
  const wire = mapper.toWireInput(model, coworkPolicy);
  expect(wire.sessionKey).toBe('agent:main:lobsterai:sess-x');
  expect(wire.sessionTarget).toBe(SessionTarget.Main);
});

test('mapper.toWireInput: im_session without sessionId -> sessionKey null', () => {
  const model = makeModel({
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.IMSession, platform: 'telegram', conversationId: 'c1' },
  });
  const wire = mapper.toWireInput(model, manualPolicy);
  expect(wire.sessionKey).toBe(null);
});

test('mapper.toWireInput: passes through non-binding fields', () => {
  const model = makeModel({
    name: 'Pass-through Test',
    description: 'Desc with \u7279\u6b8a\u5b57\u7b26',
    schedule: { kind: ScheduleKind.Every, everyMs: 60000 },
    payload: { kind: PayloadKind.SystemEvent, text: 'hello' },
    delivery: { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last },
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
  });
  const wire = mapper.toWireInput(model, manualPolicy);
  expect(wire.name).toBe('Pass-through Test');
  expect(wire.description).toBe('Desc with \u7279\u6b8a\u5b57\u7b26');
  expect(wire.schedule).toEqual({ kind: ScheduleKind.Every, everyMs: 60000 });
  expect(wire.delivery).toEqual({ mode: DeliveryMode.Announce, channel: DeliveryChannel.Last });
});

test('mapper.createDraft: from manual origin has valid defaults', () => {
  const draft = mapper.createDraft({ kind: OriginKind.Manual }, { sessionTarget: SessionTarget.Isolated, wakeMode: WakeMode.Now });
  expect(draft.id.startsWith('draft-')).toBeTruthy();
  expect(draft.origin.kind).toBe(OriginKind.Manual);
  expect(draft.binding.kind).toBe(BindingKind.NewSession);
  expect(draft.sessionTarget).toBe(SessionTarget.Isolated);
  expect(draft.wakeMode).toBe(WakeMode.Now);
});

test('mapper.createDraft: from im origin uses provided defaults', () => {
  const origin = { kind: OriginKind.IM as const, platform: 'telegram', conversationId: 'c1' };
  const draft = mapper.createDraft(origin, {
    delivery: { mode: DeliveryMode.Announce, channel: 'telegram' },
  });
  expect(draft.origin.kind).toBe(OriginKind.IM);
  expect(draft.delivery.mode).toBe(DeliveryMode.Announce);
  expect(draft.delivery.channel).toBe('telegram');
});

test('mapper.createDraft: draft has non-empty id', () => {
  const draft = mapper.createDraft({ kind: OriginKind.Manual }, {});
  expect(draft.id).toBeTruthy();
  expect(draft.id.length > 0).toBeTruthy();
});
