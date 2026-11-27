import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import {
  CleanupCapabilityKind,
  CONTEXT_CLEANUP_KV_KEYS,
  DECISION_MODEL_JEV_ITEM_ID,
} from '../../shared/contextCleanup/constants';
import { CapabilityUsageStore, makeUsageKey } from './capabilityUsageStore';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-cap-usage-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('CapabilityUsageStore', () => {
  test('records debounced usage updates, coalesces counts, and preserves earliest firstSeenAt', () => {
    const db = new Database(':memory:');
    const store = new CapabilityUsageStore(db, { flushDebounceMs: 60_000 });

    store.ensureFirstSeen([
      { kind: CleanupCapabilityKind.Skill, itemId: 'docx', firstSeenAt: 1_000 },
      { kind: CleanupCapabilityKind.Skill, itemId: 'unused-skill', firstSeenAt: 500 },
    ], 2_000);

    store.recordUsage(CleanupCapabilityKind.Skill, 'docx', 3_000);
    store.recordUsage(CleanupCapabilityKind.Skill, 'docx', 5_000);
    store.flush();

    const map = store.getUsageMap();
    const docx = map.get(makeUsageKey(CleanupCapabilityKind.Skill, 'docx'));
    expect(docx).toMatchObject({
      firstSeenAt: 1_000,
      lastUsedAt: 5_000,
      useCount: 2,
    });

    const unused = map.get(makeUsageKey(CleanupCapabilityKind.Skill, 'unused-skill'));
    expect(unused).toMatchObject({
      firstSeenAt: 500,
      lastUsedAt: null,
      useCount: 0,
    });
    db.close();
  });

  test('backfills skill, MCP, and Jev usage once from DSH projection cache', () => {
    const db = new Database(':memory:');
    const dshHome = createTempDir();
    const sessionsDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const now = Date.now();
    const recentFile = path.join(sessionsDir, 'session-1.json');
    fs.writeFileSync(recentFile, JSON.stringify({
      record: {
        rows: {
          contextTimeline: {
            val: {
              totals: { skills: { docx: 2, weather: 1 } },
              timing: {
                tools: {
                  decision_evaluate: { calls: 3 },
                  mcp__custom_crm__search: { calls: 4 },
                  mcp__lobster_word__word_read: { calls: 2 },
                },
              },
            },
          },
        },
      },
    }), 'utf8');
    // Write a corrupt file to verify fault tolerance.
    fs.writeFileSync(path.join(sessionsDir, 'corrupt.json'), '{not json', 'utf8');

    const kv = new Map<string, unknown>();
    const kvStore = {
      get: <T,>(k: string) => kv.get(k) as T | undefined,
      set: (k: string, v: unknown) => { kv.set(k, v); },
    };

    const store = new CapabilityUsageStore(db, { flushDebounceMs: 0 });
    const mcpMap = new Map([['custom_crm', 'crm-server-id']]);

    expect(store.backfillFromDshHistoryOnce({ dshHomeDir: dshHome, kvStore, mcpServerNameToId: mcpMap, now })).toBe(true);
    // Second run is a no-op because marker key is set.
    expect(store.backfillFromDshHistoryOnce({ dshHomeDir: dshHome, kvStore, mcpServerNameToId: mcpMap, now })).toBe(false);
    expect(kv.get(CONTEXT_CLEANUP_KV_KEYS.BackfilledV1)).toBe(now);

    const map = store.getUsageMap();
    expect(map.get(makeUsageKey(CleanupCapabilityKind.Skill, 'docx'))?.useCount).toBe(2);
    expect(map.get(makeUsageKey(CleanupCapabilityKind.Skill, 'weather'))?.useCount).toBe(1);
    expect(map.get(makeUsageKey(CleanupCapabilityKind.DecisionModel, DECISION_MODEL_JEV_ITEM_ID))?.useCount).toBe(3);
    expect(map.get(makeUsageKey(CleanupCapabilityKind.McpServer, 'crm-server-id'))?.useCount).toBe(4);
    db.close();
  });
});
