import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { afterEach, describe, expect, test } from 'vitest';

import { WordAgentTool } from '../../shared/artifactPreview/wordAgent';
import { resolveLobsterWordMcpStdioLaunch } from './lobsterWordMcpServer';
import { McpBridgeServer } from './mcpBridgeServer';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('LobsterAI Word MCP server', () => {
  test('lists the Word tools and forwards calls through the authenticated bridge', async () => {
    const bridge = new McpBridgeServer('secret-for-test');
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    bridge.onWordTool(async request => {
      calls.push(request);
      return { content: [{ type: 'text', text: `handled ${request.tool}` }] };
    });
    await bridge.start();
    cleanups.push(() => bridge.stop());

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-word-mcp-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const launch = resolveLobsterWordMcpStdioLaunch(directory, {
      electronNodeRuntimePath: process.execPath, bridgeUrl: bridge.wordCallbackUrl!, bridgeSecret: 'secret-for-test',
    });
    const child = spawn(process.execPath, launch.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    cleanups.push(() => { child.kill(); });
    const replies = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, (value: unknown) => void>();
    replies.on('line', line => {
      const message = JSON.parse(line) as { id: number; result: unknown };
      pending.get(message.id)?.(message.result);
    });
    let nextId = 1;
    const rpc = (method: string, params?: unknown) => new Promise<any>(resolve => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

    expect((await rpc('initialize', { protocolVersion: '2025-03-26' })).serverInfo.name).toBe('lobster-word');
    const { tools } = await rpc('tools/list');
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([WordAgentTool.Read, WordAgentTool.Edit]);
    expect(tools[1].inputSchema.required).toEqual(['path', 'edits']);
    const result = await rpc('tools/call', { name: WordAgentTool.Read, arguments: { path: '/tmp/a.docx' } });
    expect(result).toEqual({ content: [{ type: 'text', text: 'handled word_read' }] });
    expect(calls).toEqual([{ tool: WordAgentTool.Read, args: { path: '/tmp/a.docx' } }]);
    expect((await rpc('tools/call', { name: 'rm_rf', arguments: {} })).isError).toBe(true);
    expect((await fs.stat(path.join(directory, 'lobster-word-mcp', 'lobster-word-mcp-runtime.json'))).mode & 0o777).toBe(0o600);
  });

  test('the bridge refuses Word calls without the secret', async () => {
    const bridge = new McpBridgeServer('right-secret');
    bridge.onWordTool(async () => ({ content: [{ type: 'text', text: 'should not run' }] }));
    await bridge.start();
    cleanups.push(() => bridge.stop());
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(bridge.wordCallbackUrl!);
      const request = http.request({ host: url.hostname, port: (url.port as unknown as AddressInfo['port']), path: url.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mcp-bridge-secret': 'wrong' } }, response => resolve(response.statusCode ?? 0));
      request.on('error', reject);
      request.end(JSON.stringify({ tool: WordAgentTool.Read, args: {} }));
    });
    expect(status).toBe(401);
  });
});
