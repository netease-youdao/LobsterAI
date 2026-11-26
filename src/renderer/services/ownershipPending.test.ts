import { OwnershipTargetKind } from '@shared/ownership/constants';
import { describe, expect, test } from 'vitest';

import { clearOwnershipPending, type OwnershipPendingIntent,readOwnershipPending, saveOwnershipPending } from './ownershipPending';

function storage() {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
}
const intent = (partition: string): OwnershipPendingIntent => ({
  partition, target: { kind: OwnershipTargetKind.Task, id: 'task-1' },
  request: { planId: 'plan', planVersion: 'version', accountGeneration: 'epoch', requestId: 'request' },
});

describe('association pending intents', () => {
  test('preserves immutable confirmation and separates the same request ID by account scope', () => {
    const db = storage();
    saveOwnershipPending(db, intent('a-personal'));
    saveOwnershipPending(db, intent('a-team'));
    clearOwnershipPending(db, intent('a-personal'));
    expect(readOwnershipPending(db)).toEqual([intent('a-team')]);
  });
  test('allowlists fields and rejects invalid saved confirmation', () => {
    const db = storage();
    saveOwnershipPending(db, { ...intent('a'), title: 'private preview', token: 'secret' } as OwnershipPendingIntent);
    expect(db.getItem()).not.toContain('private preview');
    expect(db.getItem()).not.toContain('secret');
    db.setItem('', '{broken');
    expect(readOwnershipPending(db)).toEqual([]);
    db.setItem('', JSON.stringify([{ ...intent('a'), request: { requestId: 'alone' } }]));
    expect(readOwnershipPending(db)).toEqual([]);
  });
  test('fails synchronously before callers can send a commit when durable intent saving fails', () => {
    expect(() => saveOwnershipPending({ getItem: () => null, setItem: () => { throw new Error('full'); } }, intent('a'))).toThrow('full');
  });
});
