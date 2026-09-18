import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { McpStore, normalizeMcpToolFilter } from './mcpStore';

describe('McpStore', () => {
  let db: Database.Database | undefined;
  let store: McpStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        resolver_kind TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        package_name TEXT,
        requested_version TEXT,
        resolved_version TEXT,
        install_dir TEXT,
        command TEXT,
        args_json TEXT,
        env_json TEXT,
        error TEXT,
        installed_at INTEGER,
        resolved_at INTEGER,
        last_probe_at INTEGER,
        last_probe_status TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    store = new McpStore(db);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test('clears remote headers when update passes an empty headers object', () => {
    const server = store.createServer({
      name: 'remote',
      description: '',
      transportType: 'http',
      url: 'https://mcp.example.com',
      headers: {
        Authorization: 'Bearer token',
        'X-Tenant-Id': 'tenant-123',
      },
    });

    const updated = store.updateServer(server.id, { headers: {} });

    expect(updated?.headers).toBeUndefined();
    expect(updated?.url).toBe('https://mcp.example.com');
  });

  test('roundtrips toolFilter and supportsParallelToolCalls, surviving unrelated updates', () => {
    const server = store.createServer({
      name: 'docs-server',
      description: '',
      transportType: 'http',
      url: 'https://mcp.example.com/mcp',
      toolFilter: { include: ['doc.get', ' sheet.* ', ''], exclude: [] },
      supportsParallelToolCalls: true,
    });

    // Normalized on write: names are trimmed, blanks dropped, and an empty exclude list is not stored.
    expect(server.toolFilter).toEqual({ include: ['doc.get', 'sheet.*'] });
    expect(server.supportsParallelToolCalls).toBe(true);

    // Updating an unrelated field must keep both knobs; updateServer rebuilds the record field by field.
    const updated = store.updateServer(server.id, { description: 'renamed' });
    expect(updated?.toolFilter).toEqual({ include: ['doc.get', 'sheet.*'] });
    expect(updated?.supportsParallelToolCalls).toBe(true);

    // An all-empty filter clears the setting.
    const cleared = store.updateServer(server.id, { toolFilter: { include: [], exclude: [] } });
    expect(cleared?.toolFilter).toBeUndefined();
  });

  test('drops stale remote fields when switching to stdio', () => {
    const server = store.createServer({
      name: 'switchable',
      description: '',
      transportType: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer token' },
    });

    const updated = store.updateServer(server.id, {
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'key' },
    });

    expect(updated).toMatchObject({
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'key' },
    });
    expect(updated?.url).toBeUndefined();
    expect(updated?.headers).toBeUndefined();
  });

  test('drops stale stdio fields when switching to remote', () => {
    const server = store.createServer({
      name: 'stdio-server',
      description: '',
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'key' },
    });

    const updated = store.updateServer(server.id, {
      transportType: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    });

    expect(updated).toMatchObject({
      transportType: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    });
    expect(updated?.command).toBeUndefined();
    expect(updated?.args).toBeUndefined();
    expect(updated?.env).toBeUndefined();
  });
});

// Pure function, independent of sqlite: still runs when the better-sqlite3 native
// binding is built for the Electron ABI and the store tests above are skipped.
describe('normalizeMcpToolFilter', () => {
  test('trims names, drops empties, and collapses an all-empty filter to undefined', () => {
    expect(normalizeMcpToolFilter(undefined)).toBeUndefined();
    expect(normalizeMcpToolFilter({})).toBeUndefined();
    expect(normalizeMcpToolFilter({ include: ['', '  '], exclude: [] })).toBeUndefined();
    expect(normalizeMcpToolFilter({ include: [' doc.get ', 'sheet.*', ''] }))
      .toEqual({ include: ['doc.get', 'sheet.*'] });
    expect(normalizeMcpToolFilter({ exclude: ['dangerous_delete'] }))
      .toEqual({ exclude: ['dangerous_delete'] });
  });
});
