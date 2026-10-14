import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getName: vi.fn(() => 'LobsterAI'),
    getPath: vi.fn(() => os.tmpdir()),
    isPackaged: false,
  },
}));

import { getComputerUseMcpServerScript, resolvePackageRoot } from './computerUseMcpServer';

type ToolResult = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

type ClientCall = { method: string; params: Record<string, unknown> };

type BridgeHarness = {
  askRequests: Array<{ questions?: Array<{ question?: string; options?: Array<{ label?: string }> }> }>;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  clientCalls: () => ClientCall[];
  close: () => Promise<void>;
  home: string;
  listTools: () => Promise<Array<{ name: string; description?: string }>>;
};

type BridgeFixture = {
  env: Record<string, string>;
  home: string;
  logPath: string;
  scriptPath: string;
};

const SELF_PID = 4242;

// Minimal stand-in for the platform client module the bridge loads at runtime.
const FAKE_CLIENT_MODULE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const logPath = process.env.FAKE_CLIENT_LOG;
const record = (method, params) => fs.appendFileSync(logPath, JSON.stringify({ method, params }) + '\n');
const windows = [
  { app: 'Notes', id: 11, pid: 101, bundleId: 'com.apple.Notes', title: 'Groceries' },
  { app: 'LobsterAI', id: 12, pid: ${'$'}{SELF_PID}, bundleId: 'com.lobsterai.app', title: 'LobsterAI' },
  { app: 'Terminal', id: 13, pid: 103, bundleId: 'com.apple.Terminal', title: 'zsh' },
];
export class ComputerUseClient {
  // Like the running helper child process, keeps the bridge alive until close().
  helper = setInterval(() => {}, 60000);
  async list_windows() { record('list_windows', {}); return windows; }
  async check_permissions() { record('check_permissions', {}); return { accessibility: false, screenCapture: true, missing: ['accessibility'] }; }
  async request_permissions(params) { record('request_permissions', params); return { accessibility: true, screenCapture: true, missing: [] }; }
  async list_apps(params) { record('list_apps', params || {}); return { running: [], installed: [] }; }
  async resolve_app(params) {
    record('resolve_app', params);
    if (params.app === 'Nope') throw new Error('No installed app matches "Nope".');
    if (params.app === '终端') return { app: '终端', bundleId: 'com.apple.Terminal', running: false };
    return { app: '备忘录', bundleId: 'com.apple.Notes', running: false };
  }
  async launch_app(params) { record('launch_app', params); return { ok: true, app: '备忘录', bundleId: 'com.apple.Notes', pid: 101, windows: [windows[0]] }; }
  async get_window(params) { record('get_window', params); return windows[0]; }
  async get_window_state(params) {
    record('get_window_state', params);
    return {
      state_id: 's-1',
      window: windows[0],
      screenshots: [],
      accessibility: { tree: '[0] window "Groceries"\n  [1] button "Add"', document_text: 'Groceries\nmilk', focused_element: '[1] button "Add"' },
    };
  }
  async activate_window(params) { record('activate_window', params); return { ok: true }; }
  async click(params) {
    record('click', params);
    if (params.window?.title === 'ESC') {
      // Same marker the macOS helper writes when the user presses the physical Escape key.
      const meta = globalThis.nodeRepl.requestMeta;
      const part = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');
      const dir = path.join(meta.computerUseHome, 'cache', 'computer-use', 'interrupts', part(meta.session_id));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, part(meta.turn_id)), 'stopped');
    }
    return { ok: true, delivery: 'ax_press' };
  }
  async press_key(params) { record('press_key', params); return { ok: true }; }
  async type_text(params) { record('type_text', params); return { ok: true }; }
  async scroll(params) { record('scroll', params); return { ok: true }; }
  async drag(params) { record('drag', params); return { ok: true }; }
  async set_value(params) { record('set_value', params); return { ok: true }; }
  async perform_secondary_action(params) { record('perform_secondary_action', params); return { ok: true }; }
  async close() {
    record('close', {});
    // Closing the real helper takes a round trip, so another shutdown trigger can arrive meanwhile.
    await new Promise(resolve => setTimeout(resolve, 50));
    clearInterval(this.helper);
  }
}
`.replace('${SELF_PID}', String(SELF_PID));

const tempRoots: string[] = [];
const harnesses: BridgeHarness[] = [];
const bridgeProcesses: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()));
  for (const child of bridgeProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createBridgeFixture(options: { askUserUrl: string; locale?: string }): BridgeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-cu-bridge-'));
  tempRoots.push(root);
  const scriptPath = path.join(root, 'computer-use-mcp-server.mjs');
  const clientPath = path.join(root, 'fake-client.mjs');
  const logPath = path.join(root, 'client-calls.jsonl');
  const home = path.join(root, 'home');
  fs.writeFileSync(scriptPath, getComputerUseMcpServerScript());
  fs.writeFileSync(clientPath, FAKE_CLIENT_MODULE);
  fs.writeFileSync(logPath, '');
  fs.mkdirSync(home, { recursive: true });

  return {
    home,
    logPath,
    scriptPath,
    env: {
      PATH: process.env.PATH ?? '',
      FAKE_CLIENT_LOG: logPath,
      LOBSTER_COMPUTER_USE_ASKUSER_URL: options.askUserUrl,
      LOBSTER_MCP_BRIDGE_SECRET: 'test-secret',
      LOBSTER_COMPUTER_USE_CLIENT_MODULE: clientPath,
      LOBSTER_COMPUTER_USE_EXE: '/nonexistent/helper',
      LOBSTER_COMPUTER_USE_HOME: home,
      LOBSTER_COMPUTER_USE_LOCALE: options.locale ?? 'zh',
      LOBSTER_COMPUTER_USE_PLATFORM: 'darwin',
      LOBSTER_COMPUTER_USE_SELF_APP: 'LobsterAI',
      LOBSTER_COMPUTER_USE_SELF_PID: String(SELF_PID),
      LOBSTER_COMPUTER_USE_MCP_SDK_ROOT: resolvePackageRoot('@modelcontextprotocol/sdk')!,
      LOBSTER_COMPUTER_USE_ZOD_ROOT: resolvePackageRoot('zod')!,
    },
  };
}

function readClientCalls(logPath: string): ClientCall[] {
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as ClientCall);
}

async function startBridge(options: { answer: 'allow' | 'deny'; locale?: string }): Promise<BridgeHarness> {
  const askRequests: BridgeHarness['askRequests'] = [];
  const askServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body) as BridgeHarness['askRequests'][number];
      askRequests.push(parsed);
      const question = parsed.questions?.[0];
      const labels = (question?.options ?? []).map(option => option.label ?? '');
      const answer = options.answer === 'allow' ? labels[0] : labels[1];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ behavior: 'allow', answers: { [question?.question ?? '']: answer } }));
    });
  });
  await new Promise<void>(resolve => askServer.listen(0, '127.0.0.1', resolve));
  const port = (askServer.address() as { port: number }).port;
  const fixture = createBridgeFixture({
    askUserUrl: `http://127.0.0.1:${port}/askuser`,
    locale: options.locale,
  });

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture.scriptPath],
    env: fixture.env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'computer-use-bridge-test', version: '0.0.0' });
  await client.connect(transport);

  const harness: BridgeHarness = {
    askRequests,
    home: fixture.home,
    async call(name, args = {}) {
      return await client.callTool({ name, arguments: args }) as ToolResult;
    },
    clientCalls() {
      return readClientCalls(fixture.logPath);
    },
    async listTools() {
      return (await client.listTools()).tools;
    },
    async close() {
      await client.close().catch(() => {});
      await new Promise<void>(resolve => askServer.close(() => resolve()));
    },
  };
  harnesses.push(harness);
  return harness;
}

function textOf(result: ToolResult): string {
  return (result.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
}

function writeJsonRpc(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

// Raw pipes instead of the SDK client transport, whose close() falls back to SIGTERM
// and would hide a bridge that ignores the end of its stdio.
async function spawnInitializedBridge(): Promise<{ child: ChildProcessWithoutNullStreams; logPath: string }> {
  const fixture = createBridgeFixture({ askUserUrl: 'http://127.0.0.1:9/askuser' });
  const child = spawn(process.execPath, [fixture.scriptPath], { env: fixture.env, stdio: 'pipe' });
  bridgeProcesses.push(child);
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });

  writeJsonRpc(child, {
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'computer-use-bridge-test', version: '0.0.0' },
    },
  });
  // Once it answers, the stdio transport is reading stdin.
  await vi.waitFor(() => expect(stdout).toContain('"id":1'), { timeout: 10000 });
  return { child, logPath: fixture.logPath };
}

async function expectCleanExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  await vi.waitFor(() => {
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: 0, signal: null });
  }, { timeout: 5000 });
}

const NOTES_WINDOW = { app: 'Notes', id: 11, pid: 101, bundleId: 'com.apple.Notes', title: 'Groceries' };

describe('Computer Use MCP bridge (macOS behavior)', () => {
  test('hides LobsterAI windows and asks once per app with a localized prompt', async () => {
    const bridge = await startBridge({ answer: 'allow' });

    const listed = JSON.parse(textOf(await bridge.call('list_windows'))) as Array<{ id: number }>;
    expect(listed.map(window => window.id)).toEqual([11, 13]);

    await bridge.call('click', { window: NOTES_WINDOW, element_index: 1, state_id: 's-1' });
    await bridge.call('type_text', { window: NOTES_WINDOW, text: 'eggs' });

    expect(bridge.askRequests).toHaveLength(1);
    expect(bridge.askRequests[0].questions?.[0].question).toBe('允许 LobsterAI 操作「Notes」吗？');
    expect(bridge.askRequests[0].questions?.[0].options?.map(option => option.label)).toEqual(['允许', '拒绝']);
    const click = bridge.clientCalls().find(call => call.method === 'click');
    expect(click?.params.window).toEqual({ app: 'Notes', id: 11, title: 'Groceries' });
  });

  test('stops when the user denies an app and never forwards the action', async () => {
    const bridge = await startBridge({ answer: 'deny', locale: 'en' });

    const result = await bridge.call('click', { window: NOTES_WINDOW, element_index: 1 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('did not allow Computer Use to operate "Notes"');
    expect(bridge.askRequests[0].questions?.[0].question).toBe('Allow LobsterAI to use "Notes"?');
    expect(bridge.clientCalls().some(call => call.method === 'click')).toBe(false);
  });

  test('blocks sensitive apps and LobsterAI itself without prompting', async () => {
    const bridge = await startBridge({ answer: 'allow' });

    const terminal = await bridge.call('get_window_state', {
      window: { app: 'Terminal', id: 13, pid: 103, bundleId: 'com.apple.Terminal' },
    });
    const launchTerminal = await bridge.call('launch_app', { app: '终端' });
    const self = await bridge.call('click', { window: { app: 'Electron', id: 12, pid: SELF_PID }, element_index: 0 });

    expect(terminal.isError).toBe(true);
    expect(textOf(terminal)).toContain('blocked for safety');
    expect(launchTerminal.isError).toBe(true);
    expect(self.isError).toBe(true);
    expect(textOf(self)).toContain('cannot operate LobsterAI itself');
    expect(bridge.askRequests).toHaveLength(0);
    expect(bridge.clientCalls().some(call => call.method === 'launch_app')).toBe(false);
  });

  test('resolves launch targets before asking, and unknown apps fail without a prompt', async () => {
    const bridge = await startBridge({ answer: 'allow' });

    const missing = await bridge.call('launch_app', { app: 'Nope' });
    const launched = await bridge.call('launch_app', { app: 'Notes' });
    await bridge.call('get_window_state', { window: NOTES_WINDOW });

    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('No installed app matches');
    expect(launched.isError).toBeFalsy();
    expect(bridge.askRequests).toHaveLength(1);
    expect(bridge.askRequests[0].questions?.[0].question).toBe('允许 LobsterAI 操作「备忘录」吗？');
  });

  test('reports a physical Escape stop once, then starts a fresh turn', async () => {
    const bridge = await startBridge({ answer: 'allow' });
    const escWindow = { ...NOTES_WINDOW, title: 'ESC' };

    const pressed = await bridge.call('click', { window: escWindow, element_index: 1 });
    const stopped = await bridge.call('type_text', { window: NOTES_WINDOW, text: 'more' });
    const nextTurn = await bridge.call('type_text', { window: NOTES_WINDOW, text: 'again' });

    expect(pressed.isError).toBeFalsy();
    expect(stopped.isError).toBe(true);
    expect(textOf(stopped)).toContain('stopped by the user with the physical Escape key');
    expect(nextTurn.isError).toBeFalsy();
    const typed = bridge.clientCalls().filter(call => call.method === 'type_text').map(call => call.params.text);
    expect(typed).toEqual(['again']);
  });

  test('adds permission guidance and exposes request_permissions', async () => {
    const bridge = await startBridge({ answer: 'allow' });

    const tools = await bridge.listTools();
    const status = JSON.parse(textOf(await bridge.call('check_permissions'))) as { ready?: boolean; how_to_fix?: string };
    const requested = JSON.parse(textOf(await bridge.call('request_permissions'))) as { ready?: boolean };

    expect(tools.map(tool => tool.name)).toContain('request_permissions');
    expect(status.ready).toBe(false);
    expect(status.how_to_fix).toContain('Privacy & Security > Accessibility');
    expect(requested.ready).toBe(true);
  });

  test('returns the outline as its own block and drops duplicate document text', async () => {
    const bridge = await startBridge({ answer: 'allow' });

    const result = await bridge.call('get_window_state', { window: NOTES_WINDOW });
    const blocks = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '');
    const request = bridge.clientCalls().find(call => call.method === 'get_window_state');

    expect(request?.params.include_text).toBe(true);
    expect(JSON.parse(blocks[0])).toMatchObject({ state_id: 's-1', accessibility: { focused_element: '[1] button "Add"' } });
    expect(blocks[1]).toContain('Accessibility outline for state_id s-1');
    expect(blocks[1]).toContain('[1] button "Add"');
    expect(blocks[2]).toBe('document_text:\nGroceries\nmilk');
  });

  test('forwards a reduced screenshot scale and omits the default', async () => {
    const bridge = await startBridge({ answer: 'allow' });

    const tools = await bridge.listTools() as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
    const windowStateTool = tools.find(tool => tool.name === 'get_window_state');
    expect(windowStateTool?.inputSchema?.properties).toHaveProperty('scale');

    await bridge.call('get_window_state', { window: NOTES_WINDOW, scale: 0.5 });
    await bridge.call('get_window_state', { window: NOTES_WINDOW, scale: 1 });
    await bridge.call('get_window_state', { window: NOTES_WINDOW });
    const requests = bridge.clientCalls().filter(call => call.method === 'get_window_state');
    expect(requests.map(call => call.params.scale)).toEqual([0.5, undefined, undefined]);

    const rejected = await bridge.call('get_window_state', { window: NOTES_WINDOW, scale: 0.05 });
    expect(rejected.isError).toBe(true);
    expect(bridge.clientCalls().filter(call => call.method === 'get_window_state')).toHaveLength(3);
  });
});

describe('Computer Use MCP bridge shutdown', () => {
  test('closes the helper once and exits when stdin closes, as when the gateway dies', async () => {
    const { child, logPath } = await spawnInitializedBridge();

    child.stdin.end();

    await expectCleanExit(child);
    expect(readClientCalls(logPath).filter(call => call.method === 'close')).toHaveLength(1);
  });

  test('closes the helper and exits instead of crashing when a reply cannot be written', async () => {
    const { child, logPath } = await spawnInitializedBridge();

    child.stdout.destroy();
    writeJsonRpc(child, { id: 2, method: 'tools/list', params: {} });

    await expectCleanExit(child);
    expect(readClientCalls(logPath).filter(call => call.method === 'close')).toHaveLength(1);
  });
});
