import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AgentId } from '../../shared/agent/constants';
import { withRequiredOpenClawSessionStoreOwner } from './openclawSessionStoreOwner';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-session-owner-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('OpenClaw session store compatibility ownership', () => {
  test.each([undefined, '', '  ', '/state/agents/{agentId}/sessions.json'])(
    'does not pin a runtime owner for per-agent store %s', (store) => {
      const config = { session: { store } };
      expect(withRequiredOpenClawSessionStoreOwner(config, { stateDir })).toBe(config);
    },
  );

  test('keeps a legacy shared owner until Doctor has archived the source', () => {
    const source = path.join(stateDir, 'sessions', 'sessions.json');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, JSON.stringify({ 'voice:legacy': { sessionId: 'existing' } }));
    const config = { agents: { entries: { main: {}, worker: {} } } };
    expect(withRequiredOpenClawSessionStoreOwner(config, { stateDir })).toMatchObject({
      agents: { defaults: { sessionStore: { agentId: AgentId.Main } } },
    });
    // A failed import leaves the file in place; config generation must retain ownership.
    expect(withRequiredOpenClawSessionStoreOwner(config, { stateDir })).toMatchObject({
      agents: { defaults: { sessionStore: { agentId: AgentId.Main } } },
    });
    fs.renameSync(source, `${source}.migrated`);
    expect(withRequiredOpenClawSessionStoreOwner(config, { stateDir })).toBe(config);
  });

  test('preserves the previous shared migration owner instead of reassigning it to main', () => {
    fs.mkdirSync(path.join(stateDir, 'sessions'));
    fs.writeFileSync(path.join(stateDir, 'sessions', 'sessions.json'), '{}');
    expect(withRequiredOpenClawSessionStoreOwner({}, { stateDir, legacyOwner: { agentId: 'worker' } }))
      .toMatchObject({ agents: { defaults: { sessionStore: { agentId: 'worker' } } } });
  });

  test('does not discard ownership on an unreadable migration source', () => {
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    });
    expect(() => withRequiredOpenClawSessionStoreOwner({}, { stateDir })).toThrow('access denied');
  });

  test('pins the existing LobsterAI main owner for a fixed store without an explicit owner', () => {
    const config = { session: { store: '/state/shared.sqlite' }, agents: { entries: { main: {}, worker: {} } } };
    const resolved = withRequiredOpenClawSessionStoreOwner(config);
    expect(resolved).toMatchObject({ agents: { defaults: { sessionStore: { agentId: AgentId.Main } } } });
    expect(config.agents).not.toHaveProperty('defaults');
  });

  test.each([undefined, '/state/shared.sqlite'])(
    'preserves an explicitly authored owner for store %s', (store) => {
      const config = { session: { store }, agents: { defaults: { sessionStore: { agentId: 'worker' } } } };
      expect(withRequiredOpenClawSessionStoreOwner(config, { stateDir })).toBe(config);
    },
  );
});
