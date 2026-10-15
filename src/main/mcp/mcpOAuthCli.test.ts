import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { McpOAuthErrorCode, McpOAuthState } from '../../shared/mcp/auth';
import {
  buildMcpOAuthCliInvocation,
  extractMcpAuthorizationUrl,
  isMcpServerInOpenClawConfig,
  type McpOAuthCliContext,
  McpOAuthCliError,
  type McpOAuthSpawn,
  parseMcpOAuthStatusOutput,
  readMcpOAuthStatuses,
  runMcpOAuthLogin,
} from './mcpOAuthCli';

let runtimeRoot: string;
let context: McpOAuthCliContext;

beforeEach(() => {
  runtimeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-cli-')));
  fs.writeFileSync(path.join(runtimeRoot, 'openclaw.mjs'), '');
  context = {
    electronNodeRuntimePath: '/fake/electron',
    runtimeRoot,
    stateDir: path.join(runtimeRoot, 'home', 'state'),
    configPath: path.join(runtimeRoot, 'home', 'state', 'openclaw.json'),
    secretEnv: { LOBSTER_SECRET: 'x' },
  };
});

afterEach(() => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

/** A fake child process that prints the given stdout lines and exits with `code`. */
function fakeSpawn(lines: string[], code: number, stderr = ''): { spawnImpl: McpOAuthSpawn; calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnImpl: McpOAuthSpawn = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      // Split one line across two chunks to exercise line buffering.
      const text = lines.join('\n');
      const middle = Math.floor(text.length / 2);
      child.stdout.write(text.slice(0, middle));
      child.stdout.write(`${text.slice(middle)}\n`);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code));
    });
    return child as unknown as ReturnType<McpOAuthSpawn>;
  };
  return { spawnImpl, calls };
}

describe('extractMcpAuthorizationUrl', () => {
  test('accepts only a bare http(s) URL line', () => {
    expect(extractMcpAuthorizationUrl('  https://auth.example.com/authorize?a=1&b=2  ')).toBe(
      'https://auth.example.com/authorize?a=1&b=2',
    );
    expect(extractMcpAuthorizationUrl('Open this URL to authorize "x":')).toBeNull();
    expect(extractMcpAuthorizationUrl('file:///etc/passwd')).toBeNull();
    expect(extractMcpAuthorizationUrl('javascript:alert(1)')).toBeNull();
    expect(extractMcpAuthorizationUrl('https://a.example.com/x run this')).toBeNull();
  });
});

describe('parseMcpOAuthStatusOutput', () => {
  test('keeps OAuth servers only and tolerates log noise around the JSON', () => {
    const stdout = [
      '[plugins] loaded 3 plugins',
      JSON.stringify({
        path: '/x/openclaw.json',
        servers: [
          { name: 'lynxce', auth: 'oauth', authStatus: { state: 'authorized' } },
          { name: 'notion', auth: 'oauth', authStatus: { state: 'requires-authorization' } },
          { name: 'odd', auth: 'oauth', authStatus: { state: 'something-new' } },
          { name: 'plain', transport: 'stdio' },
        ],
      }),
    ].join('\n');
    expect(parseMcpOAuthStatusOutput(stdout)).toEqual({
      lynxce: McpOAuthState.Authorized,
      notion: McpOAuthState.RequiresAuthorization,
      odd: McpOAuthState.Unknown,
    });
    expect(parseMcpOAuthStatusOutput('not json')).toEqual({});
  });
});

describe('runMcpOAuthLogin', () => {
  test('opens the printed authorization URL once and resolves when credentials are saved', async () => {
    const { spawnImpl, calls } = fakeSpawn(
      [
        'Open this URL to authorize "lynxce":',
        'https://web.example.com/api/oauth/mcp/authorize?client_id=c1&state=s',
        'Waiting for the browser to return to OpenClaw...',
        'MCP OAuth credentials saved for "lynxce".',
      ],
      0,
    );
    const openExternal = vi.fn(async () => {});

    await runMcpOAuthLogin({ context, serverKey: 'lynxce', openExternal, spawnImpl });

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://web.example.com/api/oauth/mcp/authorize?client_id=c1&state=s');
    expect(calls[0].command).toBe('/fake/electron');
    expect(calls[0].args).toEqual([path.join(runtimeRoot, 'openclaw.mjs'), 'mcp', 'login', 'lynxce']);
    expect(calls[0].env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_STATE_DIR: context.stateDir,
      OPENCLAW_CONFIG_PATH: context.configPath,
      LOBSTER_SECRET: 'x',
    });
  });

  test('treats still-valid stored credentials as success without opening a browser', async () => {
    const { spawnImpl } = fakeSpawn(['MCP OAuth credentials saved for "lynxce".'], 0);
    const openExternal = vi.fn(async () => {});
    await runMcpOAuthLogin({ context, serverKey: 'lynxce', openExternal, spawnImpl });
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('does not open the browser and fails when the loopback callback cannot start (exit 0, no token)', async () => {
    const { spawnImpl } = fakeSpawn(
      [
        'Could not start the local OAuth callback (listen EADDRINUSE 127.0.0.1:8989).',
        'Open this URL to authorize "lynxce":',
        'https://web.example.com/api/oauth/mcp/authorize?client_id=c1',
        'After approval, run openclaw mcp login lynxce --code <code>.',
      ],
      0,
    );
    const openExternal = vi.fn(async () => {});
    await expect(runMcpOAuthLogin({ context, serverKey: 'lynxce', openExternal, spawnImpl })).rejects.toMatchObject({
      code: McpOAuthErrorCode.CallbackUnavailable,
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('surfaces the CLI error when login exits non-zero', async () => {
    const { spawnImpl } = fakeSpawn([], 1, 'MCP server "lynxce" is not configured with auth: "oauth".');
    const error = await runMcpOAuthLogin({ context, serverKey: 'lynxce', openExternal: async () => {}, spawnImpl }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpOAuthCliError);
    expect((error as McpOAuthCliError).code).toBe(McpOAuthErrorCode.Failed);
    expect((error as McpOAuthCliError).message).toContain('not configured with auth');
  });

  test('reports a server missing from openclaw.json as not loaded', async () => {
    const { spawnImpl } = fakeSpawn(
      [],
      1,
      'No MCP server named "lynxce" in /x/openclaw.json. Run openclaw mcp list to see configured servers.',
    );
    await expect(
      runMcpOAuthLogin({ context, serverKey: 'lynxce', openExternal: async () => {}, spawnImpl }),
    ).rejects.toMatchObject({ code: McpOAuthErrorCode.ServerNotLoaded });
  });

  test('rejects a second concurrent login for the same server', async () => {
    const { spawnImpl } = fakeSpawn(['MCP OAuth credentials saved for "lynxce".'], 0);
    const first = runMcpOAuthLogin({ context, serverKey: 'lynxce', openExternal: async () => {}, spawnImpl });
    await expect(
      runMcpOAuthLogin({ context, serverKey: 'lynxce', openExternal: async () => {}, spawnImpl }),
    ).rejects.toMatchObject({ code: McpOAuthErrorCode.AlreadyInProgress });
    await first;
  });

  test('reports a missing runtime before spawning anything', () => {
    fs.rmSync(path.join(runtimeRoot, 'openclaw.mjs'));
    expect(() => buildMcpOAuthCliInvocation(context, ['status', '--json'])).toThrow(McpOAuthCliError);
  });
});

describe('isMcpServerInOpenClawConfig', () => {
  test('checks mcp.servers and lets the CLI handle unreadable configs', () => {
    const configPath = path.join(runtimeRoot, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcp: { servers: { lynxce: { url: 'https://x', auth: 'oauth' } } } }));
    expect(isMcpServerInOpenClawConfig(configPath, 'lynxce')).toBe(true);
    expect(isMcpServerInOpenClawConfig(configPath, 'other')).toBe(false);

    // LobsterAI's minimal config (no model configured yet) has no mcp section.
    fs.writeFileSync(configPath, JSON.stringify({ gateway: {}, plugins: {} }));
    expect(isMcpServerInOpenClawConfig(configPath, 'lynxce')).toBe(false);

    fs.writeFileSync(configPath, '{ not json');
    expect(isMcpServerInOpenClawConfig(configPath, 'lynxce')).toBe(true);
  });
});

describe('readMcpOAuthStatuses', () => {
  test('runs `mcp status --json` and parses the result', async () => {
    const { spawnImpl, calls } = fakeSpawn(
      [JSON.stringify({ servers: [{ name: 'lynxce', auth: 'oauth', authStatus: { state: 'authorized' } }] })],
      0,
    );
    await expect(readMcpOAuthStatuses({ context, spawnImpl })).resolves.toEqual({ lynxce: McpOAuthState.Authorized });
    expect(calls[0].args.slice(1)).toEqual(['mcp', 'status', '--json']);
  });
});
