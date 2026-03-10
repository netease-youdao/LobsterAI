import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const syncModule = require('../dist-electron/mcpJsonSync.js');
const testUtils = syncModule.__mcpJsonSyncTestUtils;

if (!testUtils?.normalizeMcpJsonServer || !testUtils?.syncMcpJsonFile) {
  throw new Error('mcpJsonSync test utils are not available');
}

class InMemoryMcpStore {
  constructor(initialServers = []) {
    this.servers = initialServers.map((server) => ({ ...server }));
    this.nextId = initialServers.length + 1;
  }

  listServers() {
    return this.servers.map((server) => ({ ...server }));
  }

  createServer(data) {
    const now = Date.now();
    const created = {
      id: `server-${this.nextId++}`,
      name: data.name,
      description: data.description,
      enabled: true,
      transportType: data.transportType,
      command: data.command,
      args: data.args,
      env: data.env,
      url: data.url,
      headers: data.headers,
      isBuiltIn: Boolean(data.isBuiltIn),
      githubUrl: data.githubUrl,
      registryId: data.registryId,
      source: data.source,
      createdAt: now,
      updatedAt: now,
    };
    this.servers.push(created);
    return { ...created };
  }

  updateServer(id, data) {
    const index = this.servers.findIndex((server) => server.id === id);
    if (index < 0) return null;
    const existing = this.servers[index];
    const updated = {
      ...existing,
      ...data,
      enabled: existing.enabled,
      updatedAt: Date.now(),
    };
    this.servers[index] = updated;
    return { ...updated };
  }

  deleteServer(id) {
    const index = this.servers.findIndex((server) => server.id === id);
    if (index < 0) return false;
    this.servers.splice(index, 1);
    return true;
  }
}

test('normalizeMcpJsonServer maps streamable_http to internal http transport', () => {
  const normalized = testUtils.normalizeMcpJsonServer(
    'real-time-stock-mcp',
    {
      type: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: {
        Authorization: 'Bearer token',
      },
    },
    '/tmp/mcp.json'
  );

  assert.ok(!('error' in normalized));
  assert.equal(normalized.data.transportType, 'http');
  assert.equal(normalized.data.url, 'https://example.com/mcp');
  assert.deepEqual(normalized.data.headers, {
    Authorization: 'Bearer token',
  });
});

test('syncMcpJsonFile imports managed servers, skips manual conflicts, and removes stale managed entries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-mcp-sync-'));
  const filePath = path.join(tempDir, 'mcp.json');
  const managedSource = { kind: 'mcp-json', filePath };
  const store = new InMemoryMcpStore([
    {
      id: 'managed-old',
      name: 'old-managed',
      description: 'obsolete',
      enabled: true,
      transportType: 'http',
      url: 'https://obsolete.example/mcp',
      headers: undefined,
      command: undefined,
      args: undefined,
      env: undefined,
      isBuiltIn: false,
      githubUrl: undefined,
      registryId: undefined,
      source: managedSource,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'manual-conflict',
      name: 'manual-server',
      description: 'keep me',
      enabled: true,
      transportType: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: undefined,
      url: undefined,
      headers: undefined,
      isBuiltIn: false,
      githubUrl: undefined,
      registryId: undefined,
      source: undefined,
      createdAt: 2,
      updatedAt: 2,
    },
  ]);

  fs.writeFileSync(filePath, JSON.stringify({
    mcpServers: {
      'real-time-stock-mcp': {
        type: 'streamable_http',
        url: 'https://example.com/mcp',
      },
      'manual-server': {
        type: 'streamable_http',
        url: 'https://should-not-overwrite.example/mcp',
      },
    },
  }, null, 2));

  const result = testUtils.syncMcpJsonFile(store, { filePath });

  assert.deepEqual(result.added, ['real-time-stock-mcp']);
  assert.deepEqual(result.conflicts, ['manual-server']);
  assert.deepEqual(result.removed, ['old-managed']);

  const servers = store.listServers();
  const imported = servers.find((server) => server.name === 'real-time-stock-mcp');
  assert.ok(imported);
  assert.equal(imported.transportType, 'http');
  assert.equal(imported.url, 'https://example.com/mcp');
  assert.deepEqual(imported.source, managedSource);

  const manual = servers.find((server) => server.name === 'manual-server');
  assert.ok(manual);
  assert.equal(manual.transportType, 'stdio');
  assert.equal(manual.command, 'npx');
});
