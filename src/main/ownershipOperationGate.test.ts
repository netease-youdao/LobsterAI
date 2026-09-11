import { describe, expect, test } from 'vitest';

import { OwnershipOperationGate } from './ownershipOperationGate';

describe('ownership operation reservations', () => {
  const resources = { agentIds: ['office'], sessionIds: ['task'] };
  test('allows concurrent work but excludes association until every reservation ends', () => {
    const gate = new OwnershipOperationGate();
    const first = gate.beginOperation(resources)!;
    const second = gate.beginOperation(resources)!;
    expect(gate.tryAcquire(resources)).toBeNull();
    first(); first();
    expect(gate.isBusy(resources)).toBe(true);
    second();
    const commit = gate.tryAcquire(resources)!;
    expect(commit).toBeTypeOf('function');
    expect(gate.beginOperation(resources)).toBeNull();
    commit();
    expect(gate.isBusy(resources)).toBe(false);
  });
  test('reserves all keys without partially taking a conflicting set', () => {
    const gate = new OwnershipOperationGate();
    const release = gate.beginOperation(resources)!;
    expect(gate.tryAcquire({ agentIds: ['other', 'office'], sessionIds: [] })).toBeNull();
    expect(gate.isBusy({ agentIds: ['other'], sessionIds: [] })).toBe(false);
    release();
  });
});
