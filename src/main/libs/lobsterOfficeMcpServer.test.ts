import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { afterEach, describe, expect, test } from 'vitest';

import {
  SHEET_AGENT_MCP_SERVER_NAME, SHEET_AGENT_TIMEOUT_MS, SHEET_AGENT_TOOL_DEFINITIONS, SheetAgentTool,
} from '../../shared/artifactPreview/sheetAgent';
import { resolveLobsterOfficeMcpStdioLaunch } from './lobsterOfficeMcpServer';
import { McpBridgeServer } from './mcpBridgeServer';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SPEC = { serverName: SHEET_AGENT_MCP_SERVER_NAME, editorName: 'Excel', tools: SHEET_AGENT_TOOL_DEFINITIONS, timeoutMs: SHEET_AGENT_TIMEOUT_MS };

describe('LobsterAI Office MCP server (Excel)', () => {
  test('lists the Excel tools and forwards calls through the authenticated bridge', async () => {
    const bridge = new McpBridgeServer('secret-for-test');
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    bridge.onSheetTool(async request => {
      calls.push(request);
      return { content: [{ type: 'text', text: `handled ${request.tool}` }] };
    });
    bridge.onWordTool(async () => ({ content: [{ type: 'text', text: 'word handler must not run' }], isError: true }));
    await bridge.start();
    cleanups.push(() => bridge.stop());

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-excel-mcp-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const launch = resolveLobsterOfficeMcpStdioLaunch(directory, SPEC, {
      electronNodeRuntimePath: process.execPath, bridgeUrl: bridge.sheetCallbackUrl!, bridgeSecret: 'secret-for-test',
    });
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
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

    expect((await rpc('initialize', { protocolVersion: '2025-03-26' })).serverInfo.name).toBe(SHEET_AGENT_MCP_SERVER_NAME);
    const { tools } = await rpc('tools/list');
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([SheetAgentTool.Read, SheetAgentTool.Edit]);
    expect(tools[1].inputSchema.required).toEqual(['path', 'edits']);
    const result = await rpc('tools/call', { name: SheetAgentTool.Read, arguments: { path: '/tmp/a.xlsx' } });
    expect(result).toEqual({ content: [{ type: 'text', text: 'handled excel_read' }] });
    expect(calls).toEqual([{ tool: SheetAgentTool.Read, args: { path: '/tmp/a.xlsx' } }]);
    expect((await rpc('tools/call', { name: 'word_read', arguments: {} })).isError).toBe(true);
    const runtime = path.join(directory, `${SHEET_AGENT_MCP_SERVER_NAME}-mcp`, 'runtime.json');
    expect((await fs.stat(runtime)).mode & 0o777).toBe(0o600);
  });

  test('the bridge refuses Excel calls without the secret and reports a missing editor', async () => {
    const bridge = new McpBridgeServer('right-secret');
    await bridge.start();
    cleanups.push(() => bridge.stop());
    const post = (secret: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(bridge.sheetCallbackUrl!);
      const request = http.request({ host: url.hostname, port: Number(url.port), path: url.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mcp-bridge-secret': secret } }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.on('error', reject);
      request.end(JSON.stringify({ tool: SheetAgentTool.Read, args: {} }));
    });
    expect((await post('wrong')).status).toBe(401);
    const missing = await post('right-secret');
    expect(missing.status).toBe(503);
    expect(missing.body).toContain('Excel editor is not ready');
  });
});
