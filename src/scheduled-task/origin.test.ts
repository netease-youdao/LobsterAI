import { test, expect } from 'vitest';
import { makeTask } from './fixtures';
import { inferOriginAndBinding } from './origin';
import {
  OriginKind, BindingKind, DeliveryMode, DeliveryChannel,
} from './constants';

test('infer: managed key without IM channel -> cowork origin + ui_session binding', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'agent:main:lobsterai:sess-001', delivery: { mode: DeliveryMode.None } })
  );
  expect(result.origin).toEqual({ kind: OriginKind.Cowork, sessionId: 'sess-001' });
  expect(result.binding).toEqual({ kind: BindingKind.UISession, sessionId: 'sess-001' });
});

test('infer: managed key with IM announce channel -> im origin + im_session binding', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'agent:main:lobsterai:sess-002', delivery: { mode: DeliveryMode.Announce, channel: 'telegram' } })
  );
  expect(result.origin.kind).toBe(OriginKind.IM);
  expect((result.origin as any).platform).toBe('telegram');
  expect(result.binding.kind).toBe(BindingKind.IMSession);
  expect((result.binding as any).platform).toBe('telegram');
  expect((result.binding as any).sessionId).toBe('sess-002');
});

test('infer: non-main agentId managed key -> cowork origin', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'agent:secondary:lobsterai:sess-003', delivery: { mode: DeliveryMode.None } })
  );
  expect(result.origin).toEqual({ kind: OriginKind.Cowork, sessionId: 'sess-003' });
  expect(result.binding).toEqual({ kind: BindingKind.UISession, sessionId: 'sess-003' });
});

test('infer: managed key with channel=last -> cowork origin (last is not an IM platform)', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'agent:main:lobsterai:sess-004', delivery: { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last } })
  );
  expect(result.origin.kind).toBe(OriginKind.Cowork);
  expect(result.binding.kind).toBe(BindingKind.UISession);
});

test('infer: telegram channel key -> im origin + im_session binding', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'agent:main:telegram:user:12345' })
  );
  expect(result.origin.kind).toBe(OriginKind.IM);
  expect((result.origin as any).platform).toBe('telegram');
  expect(result.binding.kind).toBe(BindingKind.IMSession);
  expect((result.binding as any).platform).toBe('telegram');
  expect((result.binding as any).conversationId).toBe('user:12345');
});

test('infer: dingtalk connector channel key -> im origin', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'agent:main:openai-user:dingtalk-connector:acct1:user:peer1' })
  );
  expect(result.origin.kind).toBe(OriginKind.IM);
  expect((result.origin as any).platform).toBe('dingtalk');
  expect(result.binding.kind).toBe(BindingKind.IMSession);
});

test('infer: unknown sessionKey format -> session_key binding fallback', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'custom:opaque:key:value' })
  );
  expect(result.origin.kind).toBe(OriginKind.Cowork);
  expect((result.origin as any).sessionId).toBe('');
  expect(result.binding.kind).toBe(BindingKind.SessionKey);
  expect((result.binding as any).sessionKey).toBe('custom:opaque:key:value');
});

test('infer: null sessionKey -> manual origin + new_session binding', () => {
  const result = inferOriginAndBinding(makeTask({ sessionKey: null }));
  expect(result.origin).toEqual({ kind: OriginKind.Manual });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('infer: undefined sessionKey -> manual origin', () => {
  const result = inferOriginAndBinding(makeTask({ sessionKey: undefined }));
  expect(result.origin).toEqual({ kind: OriginKind.Manual });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('infer: empty string sessionKey -> manual origin', () => {
  const result = inferOriginAndBinding(makeTask({ sessionKey: '' }));
  expect(result.origin).toEqual({ kind: OriginKind.Manual });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('infer: sessionKey with whitespace is trimmed before parsing', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: '  agent:main:lobsterai:sess-trimmed  ' })
  );
  expect(result.origin.kind).toBe(OriginKind.Cowork);
  expect((result.origin as any).sessionId).toBe('sess-trimmed');
});

test('infer: pure function - same input, same output', () => {
  const task = makeTask({ sessionKey: 'agent:main:lobsterai:sess-stable' });
  const r1 = inferOriginAndBinding(task);
  const r2 = inferOriginAndBinding(task);
  expect(r1).toEqual(r2);
});

test('infer: missing delivery field does not crash', () => {
  const result = inferOriginAndBinding({ sessionKey: null } as any);
  expect(result.origin).toEqual({ kind: OriginKind.Manual });
});
