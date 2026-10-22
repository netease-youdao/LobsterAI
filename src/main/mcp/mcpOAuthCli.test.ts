import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { McpOAuthErrorCode, McpOAuthState } from '../../shared/mcp/auth';
import {
  buildMcpOAuthCliConfig,
  buildMcpOAuthCliInvocation,
  cleanMcpCliOutput,
  clearMcpOAuthCredentialsBestEffort,
  extractMcpAuthorizationUrl,
  isMcpOAuthIdentityRemoved,
  MCP_OAUTH_LOGIN_TIMEOUT_MS,
  type McpOAuthCliContext,
  McpOAuthCliError,
  type McpOAuthCliServer,
  type McpOAuthSpawn,
  parseMcpOAuthStatusOutput,
  readMcpOAuthStatuses,
  removeStaleMcpOAuthCliConfigs,
  runMcpOAuthLogin,
  runMcpOAuthLogout,
} from './mcpOAuthCli';

let runtimeRoot: string;
let context: McpOAuthCliContext;

const server: McpOAuthCliServer = {
  key: 'lynxce',
  entry: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http', auth: 'oauth' },
};

beforeEach(() => {
  runtimeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-cli-')));
  fs.writeFileSync(path.join(runtimeRoot, 'openclaw.mjs'), '');
  context = {
    electronNodeRuntimePath: '/fake/electron',
    runtimeRoot,
    stateDir: path.join(runtimeRoot, 'home', 'state'),
  };
});

afterEach(() => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

type SpawnCall = { command: string; args: string[]; env: NodeJS.ProcessEnv; configPath: string; config: unknown; configMode: number };

/** What the CLI would see: the config file named by OPENCLAW_CONFIG_PATH, read while it runs. */
function recordCall(command: string, args: string[], env: NodeJS.ProcessEnv): SpawnCall {
  const configPath = env.OPENCLAW_CONFIG_PATH ?? '';
  return {
    command,
    args,
    env,
    configPath,
    config: JSON.parse(fs.readFileSync(configPath, 'utf8')),
    configMode: fs.statSync(configPath).mode & 0o777,
  };
}

/** A fake child process that prints the given stdout lines and exits with `code`. */
function fakeSpawn(lines: string[], code: number, stderr = ''): { spawnImpl: McpOAuthSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnImpl: McpOAuthSpawn = (command, args, options) => {
    calls.push(recordCall(command, args, options.env));
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

/** A fake `mcp login` that prints the given lines, then waits for the browser until it is killed. */
function waitingSpawn(lines: string[]): { spawnImpl: McpOAuthSpawn; kill: ReturnType<typeof vi.fn>; spawned: () => number } {
  let spawnCount = 0;
  const kill = vi.fn();
  const spawnImpl: McpOAuthSpawn = () => {
    spawnCount += 1;
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      kill();
      setImmediate(() => child.emit('close', null));
      return true;
    };
    setImmediate(() => child.stdout.write(`${lines.join('\n')}\n`));
    return child as unknown as ReturnType<McpOAuthSpawn>;
  };
  return { spawnImpl, kill, spawned: () => spawnCount };
}

/** A spawn whose child fails to start (e.g. a missing Electron binary). */
function failingSpawn(): { spawnImpl: McpOAuthSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnImpl: McpOAuthSpawn = (command, args, options) => {
    calls.push(recordCall(command, args, options.env));
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
    return child as unknown as ReturnType<McpOAuthSpawn>;
  };
  return { spawnImpl, calls };
}

// What `openclaw mcp logout` really prints on stderr when openclaw.json has unrelated issues.
const ESC = String.fromCharCode(27);
const CONFIG_WARNINGS = `${ESC}[35m[config]${ESC}[39m ${ESC}[33mwarnings: plugins.entries.acpx: plugin not installed: acpx; `
  + `gateway.auth.token: *** env var "OPENCLAW_GATEWAY_TOKEN" - feature using this value will be unavailable${ESC}[39m`;
const NO_SERVER = 'No MCP server named "lynxce" in /x/openclaw.json. Run openclaw mcp list to see configured servers.';

describe('cleanMcpCliOutput', () => {
  test('drops color codes and config loader warnings, keeping the actual error', () => {
    expect(cleanMcpCliOutput(`${CONFIG_WARNINGS}\n${NO_SERVER}\n`)).toBe(NO_SERVER);
    expect(cleanMcpCliOutput(`${ESC}[31mboom${ESC}[39m`)).toBe('boom');
  });
});

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

describe('buildMcpOAuthCliConfig', () => {
  test('lists exactly the given servers and nothing that needs the gateway environment', () => {
    const other: McpOAuthCliServer = { key: 'notion', entry: { url: 'https://mcp.notion.example/sse', auth: 'oauth' } };
    expect(buildMcpOAuthCliConfig([server, other])).toEqual({
      mcp: { servers: { lynxce: server.entry, notion: other.entry } },
    });
    expect(buildMcpOAuthCliConfig([])).toEqual({ mcp: { servers: {} } });
  });
});

describe('removeStaleMcpOAuthCliConfigs', () => {
  test('removes only config dirs older than any CLI call can run', async () => {
    const tmp = path.join(runtimeRoot, 'tmp');
    const now = Date.now();
    const make = (name: string, ageMs: number) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'openclaw.json'), '{}');
      const time = new Date(now - ageMs);
      fs.utimesSync(dir, time, time);
      return dir;
    };
    const crashed = make('lobsterai-mcp-oauth-old', 3 * MCP_OAUTH_LOGIN_TIMEOUT_MS);
    const running = make('lobsterai-mcp-oauth-new', MCP_OAUTH_LOGIN_TIMEOUT_MS);
    const unrelated = make('something-else', 3 * MCP_OAUTH_LOGIN_TIMEOUT_MS);

    await removeStaleMcpOAuthCliConfigs(tmp, now);

    expect(fs.existsSync(crashed)).toBe(false);
    expect(fs.existsSync(running)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    await expect(removeStaleMcpOAuthCliConfigs(path.join(tmp, 'missing'), now)).resolves.toBeUndefined();
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

    await runMcpOAuthLogin({ context, server, openExternal, spawnImpl });

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://web.example.com/api/oauth/mcp/authorize?client_id=c1&state=s');
    expect(calls[0].command).toBe('/fake/electron');
    expect(calls[0].args).toEqual([path.join(runtimeRoot, 'openclaw.mjs'), 'mcp', 'login', 'lynxce']);
    expect(calls[0].env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_HOME: path.dirname(context.stateDir),
      OPENCLAW_STATE_DIR: context.stateDir,
    });
  });

  test('runs against a private config of its own that lists only this server, removed afterwards', async () => {
    const { spawnImpl, calls } = fakeSpawn(['MCP OAuth credentials saved for "lynxce".'], 0);
    await runMcpOAuthLogin({ context, server, openExternal: async () => {}, spawnImpl });

    expect(calls[0].config).toEqual({ mcp: { servers: { lynxce: server.entry } } });
    // Tokens live in the gateway's state dir; the config is not the gateway's.
    expect(path.dirname(calls[0].configPath).startsWith(context.stateDir)).toBe(false);
    if (process.platform !== 'win32') expect(calls[0].configMode).toBe(0o600);
    expect(fs.existsSync(path.dirname(calls[0].configPath))).toBe(false);
  });

  test('removes its config when the CLI cannot be started', async () => {
    const { spawnImpl, calls } = failingSpawn();
    await expect(runMcpOAuthLogin({ context, server, openExternal: async () => {}, spawnImpl })).rejects.toThrow(
      'spawn ENOENT',
    );
    expect(fs.existsSync(path.dirname(calls[0].configPath))).toBe(false);
  });

  test('treats still-valid stored credentials as success without opening a browser', async () => {
    const { spawnImpl } = fakeSpawn(['MCP OAuth credentials saved for "lynxce".'], 0);
    const openExternal = vi.fn(async () => {});
    await runMcpOAuthLogin({ context, server, openExternal, spawnImpl });
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
    await expect(runMcpOAuthLogin({ context, server, openExternal, spawnImpl })).rejects.toMatchObject({
      code: McpOAuthErrorCode.CallbackUnavailable,
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('surfaces the CLI error when login exits non-zero', async () => {
    const { spawnImpl } = fakeSpawn([], 1, 'MCP server "lynxce" is not configured with auth: "oauth".');
    const error = await runMcpOAuthLogin({ context, server, openExternal: async () => {}, spawnImpl }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpOAuthCliError);
    expect((error as McpOAuthCliError).code).toBe(McpOAuthErrorCode.Failed);
    expect((error as McpOAuthCliError).message).toContain('not configured with auth');
  });

  test('rejects a second concurrent login for the same server', async () => {
    const { spawnImpl } = fakeSpawn(['MCP OAuth credentials saved for "lynxce".'], 0);
    const first = runMcpOAuthLogin({ context, server, openExternal: async () => {}, spawnImpl });
    await expect(
      runMcpOAuthLogin({ context, server, openExternal: async () => {}, spawnImpl }),
    ).rejects.toMatchObject({ code: McpOAuthErrorCode.AlreadyInProgress });
    await first;
  });

  test('kills the waiting CLI and reports cancellation when the signal aborts', async () => {
    const { spawnImpl, kill } = waitingSpawn([
      'Open this URL to authorize "lynxce":',
      'https://web.example.com/api/oauth/mcp/authorize?client_id=c1',
      'Waiting for the browser to return to OpenClaw...',
    ]);
    const openExternal = vi.fn(async () => {});
    const controller = new AbortController();
    const login = runMcpOAuthLogin({ context, server, openExternal, spawnImpl, signal: controller.signal });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(login).rejects.toMatchObject({ code: McpOAuthErrorCode.Cancelled });
    expect(kill).toHaveBeenCalledTimes(1);
    // The server is free for a new sign-in once the cancelled one has ended.
    const { spawnImpl: retrySpawn } = fakeSpawn(['MCP OAuth credentials saved for "lynxce".'], 0);
    await runMcpOAuthLogin({ context, server, openExternal, spawnImpl: retrySpawn });
  });

  test('does not spawn the CLI when the signal is already aborted', async () => {
    const { spawnImpl, spawned } = waitingSpawn([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runMcpOAuthLogin({ context, server, openExternal: async () => {}, spawnImpl, signal: controller.signal }),
    ).rejects.toMatchObject({ code: McpOAuthErrorCode.Cancelled });
    expect(spawned()).toBe(0);
  });

  test('keeps config warnings out of the error message', async () => {
    const { spawnImpl } = fakeSpawn([], 1, `${CONFIG_WARNINGS}\nMCP server "lynxce" needs a URL for OAuth login.`);
    const error = await runMcpOAuthLogin({ context, server, openExternal: async () => {}, spawnImpl })
      .catch((e: unknown) => e as McpOAuthCliError);
    expect(error.code).toBe(McpOAuthErrorCode.Failed);
    expect(error.message).toBe('MCP server "lynxce" needs a URL for OAuth login.');
  });

  test('asks the CLI for plain, uncolored output', () => {
    expect(buildMcpOAuthCliInvocation(context, '/tmp/x/openclaw.json', ['status', '--json']).options.env).toMatchObject({
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      OPENCLAW_CONFIG_PATH: '/tmp/x/openclaw.json',
    });
  });

  test('reports a missing runtime before spawning anything, leaving no config behind', async () => {
    fs.rmSync(path.join(runtimeRoot, 'openclaw.mjs'));
    expect(() => buildMcpOAuthCliInvocation(context, '/tmp/x/openclaw.json', ['status', '--json'])).toThrow(McpOAuthCliError);

    const mkdtemp = vi.spyOn(fs.promises, 'mkdtemp');
    const { spawnImpl, calls } = fakeSpawn([], 0);
    await expect(runMcpOAuthLogin({ context, server, openExternal: async () => {}, spawnImpl })).rejects.toMatchObject({
      code: McpOAuthErrorCode.RuntimeUnavailable,
    });
    expect(calls).toHaveLength(0);
    const dir = await (mkdtemp.mock.results[0].value as Promise<string>);
    expect(fs.existsSync(dir)).toBe(false);
    mkdtemp.mockRestore();
  });
});

describe('runMcpOAuthLogout', () => {
  test('runs `mcp logout` against a config listing only that server', async () => {
    const { spawnImpl, calls } = fakeSpawn(['MCP OAuth credentials cleared for "lynxce".'], 0);
    await runMcpOAuthLogout({ context, server, spawnImpl });
    expect(calls[0].args.slice(1)).toEqual(['mcp', 'logout', 'lynxce']);
    expect(calls[0].config).toEqual({ mcp: { servers: { lynxce: server.entry } } });
  });

  test('reports a CLI failure without the CLI noise', async () => {
    const { spawnImpl } = fakeSpawn([], 1, `${CONFIG_WARNINGS}\n${NO_SERVER}`);
    const error = await runMcpOAuthLogout({ context, server, spawnImpl }).catch((e: unknown) => e as McpOAuthCliError);
    expect(error.code).toBe(McpOAuthErrorCode.Failed);
    expect(error.message).toBe(NO_SERVER);
  });
});

describe('isMcpOAuthIdentityRemoved', () => {
  const existing = { name: 'lynxce', url: 'https://mcp.example.com/mcp' };

  test('flags changes that orphan the stored tokens', () => {
    expect(isMcpOAuthIdentityRemoved(existing, { name: 'renamed' })).toBe(true);
    expect(isMcpOAuthIdentityRemoved(existing, { url: 'https://other.example.com/mcp' })).toBe(true);
    expect(isMcpOAuthIdentityRemoved(existing, { auth: 'none' })).toBe(true);
    expect(isMcpOAuthIdentityRemoved(existing, { transportType: 'stdio' })).toBe(true);
  });

  test('ignores updates that keep the same identity', () => {
    expect(isMcpOAuthIdentityRemoved(existing, {})).toBe(false);
    expect(isMcpOAuthIdentityRemoved(existing, {
      name: 'lynxce',
      url: 'https://mcp.example.com/mcp',
      transportType: 'http',
      auth: 'oauth',
    })).toBe(false);
  });
});

describe('clearMcpOAuthCredentialsBestEffort', () => {
  test('signs out a server the gateway config does not list, such as a disabled one', async () => {
    // No gateway openclaw.json exists at all here: the CLI gets a config of its own.
    const { spawnImpl, calls } = fakeSpawn(['MCP OAuth credentials cleared for "lynxce".'], 0);
    await expect(clearMcpOAuthCredentialsBestEffort({ context, server, spawnImpl })).resolves.toBe(true);
    expect(calls[0].args.slice(1)).toEqual(['mcp', 'logout', 'lynxce']);
    expect(calls[0].config).toEqual({ mcp: { servers: { lynxce: server.entry } } });
    expect(calls[0].env.OPENCLAW_STATE_DIR).toBe(context.stateDir);
  });

  test('swallows CLI failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawnImpl } = fakeSpawn([], 1, 'boom');
    await expect(clearMcpOAuthCredentialsBestEffort({ context, server, spawnImpl })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('readMcpOAuthStatuses', () => {
  test('runs `mcp status --json` against a config listing the given servers and parses the result', async () => {
    const other: McpOAuthCliServer = { key: 'notion', entry: { url: 'https://mcp.notion.example/sse', auth: 'oauth' } };
    const { spawnImpl, calls } = fakeSpawn(
      [JSON.stringify({ servers: [
        { name: 'lynxce', auth: 'oauth', authStatus: { state: 'authorized' } },
        { name: 'notion', auth: 'oauth', authStatus: { state: 'unauthenticated' } },
      ] })],
      0,
    );
    await expect(readMcpOAuthStatuses({ context, servers: [server, other], spawnImpl })).resolves.toEqual({
      lynxce: McpOAuthState.Authorized,
      notion: McpOAuthState.Unauthenticated,
    });
    expect(calls[0].args.slice(1)).toEqual(['mcp', 'status', '--json']);
    expect(calls[0].config).toEqual({ mcp: { servers: { lynxce: server.entry, notion: other.entry } } });
  });
});
