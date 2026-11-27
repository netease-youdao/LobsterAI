import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { approvePairingCode, requestPopoPairing } from './imPairingStore';

test('POPO pairing grants a sender access to the approved instance only and limits duplicate requests', () => {
  const state = mkdtempSync(join(tmpdir(), 'lobster-popo-pairing-'));
  try {
    const result = requestPopoPairing('bot-a', 'alice', state);
    expect(result.code).toMatch(/^[A-F0-9]{10}$/);
    expect(requestPopoPairing('bot-a', 'alice', state)).toEqual({ approved: false });
    expect(approvePairingCode('popo:bot-b', result.code!, state)).toBeNull();
    expect(approvePairingCode('popo:bot-a', result.code!, state)?.id).toBe('alice');
    expect(requestPopoPairing('bot-a', 'alice', state)).toEqual({ approved: true });
    expect(requestPopoPairing('bot-b', 'alice', state).approved).toBe(false);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
