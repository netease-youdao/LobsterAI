import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { makeTask, makeModel } from './fixtures';
import { ScheduledTaskMetaStore } from './metaStore';
import { TaskModelMapper } from './modelMapper';
import { taskPolicyRegistry } from './policies/registry';
import {
  OriginKind, BindingKind, ScheduleKind, PayloadKind,
  DeliveryMode, DeliveryChannel,
} from './constants';

const mapper = new TaskModelMapper();

function createMetaStore() {
  const db = new Database(':memory:');
  return new ScheduledTaskMetaStore(db);
}

test('integration: manual create -> edit delivery to IM -> binding auto-updates', () => {
  const metaStore = createMetaStore();
  const origin = { kind: OriginKind.Manual };
  const policy = taskPolicyRegistry.get(origin);

  // 1. Create draft
  const draft = mapper.createDraft(origin, policy.getCreateDefaults(origin));
  draft.name = 'Daily Reminder';
  draft.schedule = { kind: ScheduleKind.Cron, expr: '0 9 * * *' };
  draft.payload = { kind: PayloadKind.SystemEvent, text: 'Good morning' };
  expect(draft.binding.kind).toBe(BindingKind.NewSession);

  // 2. Normalize
  const normalized = policy.normalizeDraft(draft);

  // 3. Edit delivery -> IM
  const edited = policy.onDeliveryChanged(normalized, { mode: DeliveryMode.Announce, channel: 'telegram' });
  expect(edited.binding.kind).toBe(BindingKind.IMSession);
  expect((edited.binding as any).platform).toBe('telegram');

  // 4. Save meta
  metaStore.set('task-int-1', edited.origin, edited.binding);
  const savedMeta = metaStore.get('task-int-1');
  expect(savedMeta).toBeTruthy();
  expect(JSON.parse(savedMeta!.binding).kind).toBe(BindingKind.IMSession);
});

test('integration: IM task -> switch to different IM platform -> binding platform updates', () => {
  const origin = { kind: OriginKind.IM, platform: 'telegram', conversationId: 'c1' };
  const policy = taskPolicyRegistry.get(origin);
  const defaults = policy.getCreateDefaults(origin);
  const draft = mapper.createDraft(origin, defaults);
  draft.binding = { kind: BindingKind.IMSession, platform: 'telegram', conversationId: 'c1', sessionId: 'sess-1' };

  const edited = policy.onDeliveryChanged(draft, { mode: DeliveryMode.Announce, channel: 'discord' });
  expect(edited.binding.kind).toBe(BindingKind.IMSession);
  expect((edited.binding as any).platform).toBe('discord');
});

test('integration: cowork task -> delivery change to webhook -> binding stays', () => {
  const origin = { kind: OriginKind.Cowork, sessionId: 'sess-99' };
  const policy = taskPolicyRegistry.get(origin);
  const model = makeModel({
    origin,
    binding: { kind: BindingKind.UISession, sessionId: 'sess-99' },
    delivery: { mode: DeliveryMode.None },
  });

  const edited = policy.onDeliveryChanged(model, { mode: DeliveryMode.Webhook });
  expect(edited.binding).toEqual(model.binding);
  expect(edited.delivery.mode).toBe(DeliveryMode.Webhook);
});

test('integration: infer -> persist -> reload uses stored meta (not re-infer)', () => {
  const metaStore = createMetaStore();
  const wire = makeTask({ sessionKey: 'agent:main:lobsterai:sess-99' });

  // 1. First load -- infer
  const model1 = mapper.fromWire(wire);
  expect(model1.origin.kind).toBe(OriginKind.Cowork);
  metaStore.set(wire.id, model1.origin, model1.binding);

  // 2. Second load -- read from store
  const meta = metaStore.get(wire.id);
  const model2 = mapper.fromWire(wire, {
    origin: JSON.parse(meta!.origin),
    binding: JSON.parse(meta!.binding),
  });
  expect(model2.origin).toEqual(model1.origin);
  expect(model2.binding).toEqual(model1.binding);
});

test('integration: wire roundtrip preserves all fields', () => {
  const model = makeModel({
    name: 'Roundtrip',
    description: 'Desc with "quotes" & special chars',
    schedule: { kind: ScheduleKind.Cron, expr: '*/5 * * * *' },
    payload: { kind: PayloadKind.AgentTurn, message: 'Do work', timeoutSeconds: 120 },
    delivery: { mode: DeliveryMode.Announce, channel: 'feishu', to: 'user-1' },
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
  });
  const policy = taskPolicyRegistry.get(model.origin);
  const wire = mapper.toWireInput(model, policy);

  // Simulate fromWire (add back id/state/timestamps that toWireInput strips)
  const restored = mapper.fromWire(
    { ...wire, id: 'id-1', state: {}, createdAt: '', updatedAt: '' } as any,
    { origin: model.origin, binding: model.binding },
  );

  expect(restored.name).toBe('Roundtrip');
  expect(restored.description).toBe('Desc with "quotes" & special chars');
  expect(restored.schedule).toEqual({ kind: ScheduleKind.Cron, expr: '*/5 * * * *' });
  expect((restored.payload as any).message).toBe('Do work');
  expect((restored.payload as any).timeoutSeconds).toBe(120);
  expect((restored.delivery as any).channel).toBe('feishu');
});

test('integration: legacy task with IM announce -> normalizeDraft links binding', () => {
  const origin = { kind: OriginKind.Legacy };
  const policy = taskPolicyRegistry.get(origin);
  const model = makeModel({
    origin,
    binding: { kind: BindingKind.NewSession },
    delivery: { mode: DeliveryMode.Announce, channel: 'feishu' },
  });

  const normalized = policy.normalizeDraft(model);
  expect(normalized.binding.kind).toBe(BindingKind.IMSession);
  expect((normalized.binding as any).platform).toBe('feishu');
});
