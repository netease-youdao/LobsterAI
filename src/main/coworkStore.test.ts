import type { Database } from 'sql.js';
import { describe, expect, test, vi } from 'vitest';
import { CoworkStore } from './coworkStore';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp',
    getPath: () => '/tmp',
  },
}));

vi.mock('uuid', () => ({
  v4: () => 'test-id',
}));

function createStore(runImpl?: (sql: string, params?: unknown[]) => void) {
  const run = vi.fn(runImpl);
  const exec = vi.fn(() => []);
  const saveDb = vi.fn();
  const db = {
    run,
    exec,
  } as unknown as Database;

  return {
    run,
    saveDb,
    store: new CoworkStore(db, saveDb),
  };
}

describe('CoworkStore.setConfig', () => {
  test('wraps batched config updates in a transaction and saves once', () => {
    const { store, run, saveDb } = createStore();

    store.setConfig({
      workingDirectory: '/tmp/workspace',
      agentEngine: 'openclaw',
      memoryEnabled: false,
    });

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(run.mock.calls[2]?.[0]).toBe('COMMIT');

    const [insertSql, insertParams] = run.mock.calls[1] ?? [];
    expect(insertSql).toContain('INSERT INTO cowork_config');
    expect(insertSql).toContain('VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)');
    expect(insertParams).toEqual([
      'workingDirectory',
      '/tmp/workspace',
      expect.any(Number),
      'agentEngine',
      'openclaw',
      expect.any(Number),
      'memoryEnabled',
      '0',
      expect.any(Number),
    ]);
    expect(saveDb).toHaveBeenCalledTimes(1);
  });

  test('rolls back the transaction when the batched upsert fails', () => {
    const error = new Error('write failed');
    const { store, run, saveDb } = createStore((sql) => {
      if (sql.includes('INSERT INTO cowork_config')) {
        throw error;
      }
    });

    expect(() => {
      store.setConfig({
        workingDirectory: '/tmp/workspace',
        agentEngine: 'openclaw',
      });
    }).toThrow(error);

    expect(run.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(run.mock.calls[1]?.[0]).toContain('INSERT INTO cowork_config');
    expect(run.mock.calls[2]?.[0]).toBe('ROLLBACK');
    expect(run.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    expect(saveDb).not.toHaveBeenCalled();
  });
});
