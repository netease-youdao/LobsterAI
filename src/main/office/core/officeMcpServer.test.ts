import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { afterEach, describe, expect, test } from 'vitest';

import { OFFICE_EDITORS } from '../../../shared/office/editors';
import { McpBridgeServer } from '../../libs/mcpBridgeServer';
import { resolveOfficeMcpStdioLaunch } from './officeMcpServer';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.each(OFFICE_EDITORS.map(editor => [editor.editorName, editor] as const))('%s MCP server', (_name, editor) => {
  const { serverName } = editor.agent;
  const toolNames = editor.agent.tools.map(tool => tool.name);

  test('lists the editor\'s tools and forwards calls through the authenticated bridge', async () => {
    const bridge = new McpBridgeServer('secret-for-test');
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    bridge.onEditorTool(editor.id, editor.editorName, async request => {
      calls.push(request);
      return { content: [{ type: 'text', text: `handled ${request.tool}` }] };
    });
    for (const other of OFFICE_EDITORS.filter(other => other.id !== editor.id)) {
      bridge.onEditorTool(other.id, other.editorName, async () => ({ content: [{ type: 'text', text: 'wrong editor' }], isError: true }));
    }
    await bridge.start();
    cleanups.push(() => bridge.stop());

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-office-mcp-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    // A secret left by an earlier build under the old runtime file name is removed.
    const serverDir = path.join(directory, `${serverName}-mcp`);
    await fs.mkdir(serverDir, { recursive: true });
    await fs.writeFile(path.join(serverDir, `${serverName}-mcp-runtime.json`), '{"bridgeSecret":"old"}');
    const launch = resolveOfficeMcpStdioLaunch(directory, editor, {
      electronNodeRuntimePath: process.execPath, bridgeUrl: bridge.editorCallbackUrl(editor.id)!, bridgeSecret: 'secret-for-test',
    });
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(launch.args).toEqual([path.join(serverDir, `${serverName}-mcp-server.mjs`)]);
    expect((await fs.stat(path.join(serverDir, 'runtime.json'))).mode & 0o777).toBe(0o600);
    await expect(fs.access(path.join(serverDir, `${serverName}-mcp-runtime.json`))).rejects.toThrow();

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

    expect((await rpc('initialize', { protocolVersion: '2025-03-26' })).serverInfo.name).toBe(serverName);
    const { tools } = await rpc('tools/list');
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(toolNames);
    expect(tools[1].inputSchema.required).toEqual(['path', 'edits']);
    const target = `/tmp/a${editor.extension}`;
    const result = await rpc('tools/call', { name: toolNames[0], arguments: { path: target } });
    expect(result).toEqual({ content: [{ type: 'text', text: `handled ${toolNames[0]}` }] });
    expect(calls).toEqual([{ tool: toolNames[0], args: { path: target } }]);
    expect((await rpc('tools/call', { name: 'rm_rf', arguments: {} })).isError).toBe(true);
  });

  test('the bridge refuses calls without the secret and serves only registered editors', async () => {
    const bridge = new McpBridgeServer('right-secret');
    await bridge.start();
    cleanups.push(() => bridge.stop());
    const post = (secret: string, body: unknown) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(bridge.editorCallbackUrl(editor.id)!);
      const request = http.request({ host: url.hostname, port: Number(url.port), path: url.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mcp-bridge-secret': secret } }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
      });
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
    expect((await post('wrong', { tool: toolNames[0], args: {} })).status).toBe(401);
    expect((await post('right-secret', { tool: toolNames[0], args: {} })).status).toBe(404);
    bridge.onEditorTool(editor.id, editor.editorName, async request => ({ content: [{ type: 'text', text: request.tool }] }));
    const missingTool = await post('right-secret', { args: {} });
    expect(missingTool.status).toBe(400);
    expect(missingTool.body).toContain(`Missing ${editor.editorName} tool name`);
    expect((await post('right-secret', { tool: toolNames[0], args: {} })).status).toBe(200);
  });
});
