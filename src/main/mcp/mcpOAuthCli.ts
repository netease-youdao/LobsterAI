import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { McpAuthMode, McpOAuthErrorCode, McpOAuthState } from '../../shared/mcp/auth';
import { McpUrlProtocol } from '../../shared/mcp/url';
import { resolveOpenClawCliPath } from '../libs/openclawPluginInstallMigration';
import type { McpServerFormData, McpServerRecord } from './mcpStore';

/**
 * Drives OpenClaw's MCP OAuth CLI (`openclaw mcp login|logout|status`) for remote
 * servers configured with `auth: "oauth"`. OpenClaw owns the whole OAuth flow
 * (discovery, dynamic registration, PKCE, loopback callback on 127.0.0.1:8989,
 * token storage and refresh); the app only needs to open the printed URL in the
 * user's browser and wait for the CLI to finish.
 *
 * OpenClaw keys stored tokens by server name + URL in its state SQLite, not by
 * config file. So every CLI call runs against a temporary openclaw.json that
 * lists only the servers it is about, next to the gateway's real state dir.
 * That works whether or not the gateway's config already lists the server:
 * disabled, no model configured yet, or a just-saved change still waiting for a
 * busy gateway. The gateway reads the stored token on every request, so no
 * restart is needed after login. A server whose tool catalog failed before
 * login is retried by the gateway a few seconds later.
 */

// The CLI waits up to 5 minutes for the browser callback; leave room for startup.
export const MCP_OAUTH_LOGIN_TIMEOUT_MS = 5 * 60 * 1000 + 30_000;
export const MCP_OAUTH_STATUS_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_LIMIT = 2_000;
const CLI_CONFIG_DIR_PREFIX = 'lobsterai-mcp-oauth-';
const CLI_CONFIG_FILE_NAME = 'openclaw.json';

export interface McpOAuthCliContext {
  /** Electron binary run with ELECTRON_RUN_AS_NODE=1. */
  electronNodeRuntimePath: string;
  runtimeRoot: string;
  /** The gateway's state dir, where OpenClaw stores the tokens. */
  stateDir: string;
}

/**
 * A server as openclaw.json lists it: its `mcp.servers` key and entry. Tokens
 * are keyed by the entry's name and URL, so callers build it the way config
 * sync does.
 */
export interface McpOAuthCliServer {
  key: string;
  entry: Record<string, unknown>;
}

/**
 * The openclaw.json a CLI call runs against. It references no `${VAR}` secrets
 * and no plugins, so the CLI needs none of the gateway's environment.
 */
export function buildMcpOAuthCliConfig(servers: McpOAuthCliServer[]): { mcp: { servers: Record<string, Record<string, unknown>> } } {
  return { mcp: { servers: Object.fromEntries(servers.map(server => [server.key, server.entry])) } };
}

// No CLI call outlives the login timeout, so an older config dir was left behind by
// an app that crashed or was killed mid-call.
const STALE_CLI_CONFIG_AGE_MS = 2 * MCP_OAUTH_LOGIN_TIMEOUT_MS;
let staleCliConfigSweep: Promise<void> | null = null;

/** Removes config dirs left by a crashed app. Runs once per process; never throws. */
export async function removeStaleMcpOAuthCliConfigs(tmpDir = os.tmpdir(), now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(tmpDir);
  } catch {
    return;
  }
  await Promise.all(names.filter(name => name.startsWith(CLI_CONFIG_DIR_PREFIX)).map(async name => {
    const dir = path.join(tmpDir, name);
    try {
      if (now - (await fs.promises.stat(dir)).mtimeMs < STALE_CLI_CONFIG_AGE_MS) return;
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // Another user's dir in a shared tmp, or already gone.
    }
  }));
}

/** Writes the config to a private temp dir for the duration of `run`. */
async function withMcpOAuthCliConfig<T>(
  servers: McpOAuthCliServer[],
  run: (configPath: string) => Promise<T>,
): Promise<T> {
  staleCliConfigSweep ??= removeStaleMcpOAuthCliConfigs();
  await staleCliConfigSweep;
  // Entries may carry the server's other request headers, so keep the file private.
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), CLI_CONFIG_DIR_PREFIX));
  try {
    const configPath = path.join(dir, CLI_CONFIG_FILE_NAME);
    await fs.promises.writeFile(configPath, JSON.stringify(buildMcpOAuthCliConfig(servers)), { mode: 0o600 });
    return await run(configPath);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(error =>
      console.warn('[MCP] failed to remove temporary OAuth CLI config:', error instanceof Error ? error.message : error),
    );
  }
}

export class McpOAuthCliError extends Error {
  constructor(
    readonly code: McpOAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpOAuthCliError';
  }
}

export type McpOAuthSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Pick<ChildProcess, 'stdout' | 'stderr' | 'once' | 'kill'>;

const defaultSpawn: McpOAuthSpawn = (command, args, options) =>
  spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

export function buildMcpOAuthCliInvocation(context: McpOAuthCliContext, configPath: string, mcpArgs: string[]) {
  const cliPath = resolveOpenClawCliPath(context.runtimeRoot);
  if (!cliPath) {
    throw new McpOAuthCliError(McpOAuthErrorCode.RuntimeUnavailable, 'OpenClaw runtime is not installed.');
  }
  return {
    command: context.electronNodeRuntimePath,
    args: [cliPath, 'mcp', ...mcpArgs],
    options: {
      cwd: context.runtimeRoot,
      env: {
        ...process.env,
        OPENCLAW_HOME: path.dirname(context.stateDir),
        OPENCLAW_STATE_DIR: context.stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: '1',
        ELECTRON_RUN_AS_NODE: '1',
        // Output is parsed and shown in the UI, never in a terminal.
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      } as NodeJS.ProcessEnv,
    },
  };
}

/**
 * Picks the authorization URL out of `mcp login` output. The CLI prints
 * `Open this URL to authorize "<name>":` followed by the URL on its own line.
 * Only http(s) URLs are accepted so a hostile server cannot make us open
 * `file:` or custom-scheme links.
 */
export function extractMcpAuthorizationUrl(line: string): string | null {
  const candidate = line.trim();
  if (!/^https?:\/\//i.test(candidate) || /\s/.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === McpUrlProtocol.Http || url.protocol === McpUrlProtocol.Https ? url.toString() : null;
  } catch {
    return null;
  }
}

const KNOWN_OAUTH_STATES: ReadonlySet<McpOAuthState> = new Set([
  McpOAuthState.Authorized,
  McpOAuthState.RequiresAuthorization,
  McpOAuthState.PendingAuthorization,
  McpOAuthState.Unauthenticated,
]);

/** Parses `openclaw mcp status --json` into `{ serverKey: state }` for OAuth servers. */
export function parseMcpOAuthStatusOutput(stdout: string): Record<string, McpOAuthState> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return {};
  }
  const servers = (parsed as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return {};
  const states: Record<string, McpOAuthState> = {};
  for (const entry of servers) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, auth, authStatus } = entry as { name?: unknown; auth?: unknown; authStatus?: { state?: unknown } };
    if (typeof name !== 'string' || auth !== 'oauth') continue;
    const state = authStatus?.state;
    states[name] = KNOWN_OAUTH_STATES.has(state as McpOAuthState) ? (state as McpOAuthState) : McpOAuthState.Unknown;
  }
  return states;
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const CONFIG_WARNING_LINE_RE = /^\[config\]/i;

/**
 * CLI output fit for an error message: no color codes, and none of the
 * `[config] warnings: …` lines the config loader prints about unrelated parts of
 * openclaw.json (missing plugins, unset env vars) before the actual error.
 */
export function cleanMcpCliOutput(text: string): string {
  return text
    .replace(ANSI_ESCAPE_RE, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !CONFIG_WARNING_LINE_RE.test(line))
    .join('\n');
}

function tail(text: string): string {
  const cleaned = cleanMcpCliOutput(text);
  return cleaned.length > OUTPUT_TAIL_LIMIT ? cleaned.slice(-OUTPUT_TAIL_LIMIT) : cleaned;
}

type CliResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean };

function runCli(
  context: McpOAuthCliContext,
  servers: McpOAuthCliServer[],
  mcpArgs: string[],
  options: {
    timeoutMs: number;
    spawnImpl?: McpOAuthSpawn;
    onStdoutLine?: (line: string) => void;
    /** Aborting kills the CLI (which also frees the loopback port) and resolves with `cancelled`. */
    signal?: AbortSignal;
  },
): Promise<CliResult> {
  return withMcpOAuthCliConfig(servers, configPath => spawnCli(context, configPath, mcpArgs, options));
}

function spawnCli(
  context: McpOAuthCliContext,
  configPath: string,
  mcpArgs: string[],
  options: Parameters<typeof runCli>[3],
): Promise<CliResult> {
  const invocation = buildMcpOAuthCliInvocation(context, configPath, mcpArgs);
  const child = (options.spawnImpl ?? defaultSpawn)(invocation.command, invocation.args, invocation.options);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      child.kill('SIGTERM');
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (!options.onStdoutLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      lines.forEach(line => options.onStdoutLine?.(line));
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error: Error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code: number | null) => {
      cleanup();
      if (pending && options.onStdoutLine) options.onStdoutLine(pending);
      resolve({ code, stdout, stderr, timedOut, cancelled });
    });
  });
}

const activeLogins = new Set<string>();

export function createCancelledError(): McpOAuthCliError {
  return new McpOAuthCliError(McpOAuthErrorCode.Cancelled, 'Sign-in was cancelled.');
}

/**
 * Runs `openclaw mcp login <key>`, opening the authorization URL in the
 * system browser as soon as the CLI prints it. Resolves once OpenClaw has
 * stored the credentials; rejects with a McpOAuthCliError otherwise.
 */
export async function runMcpOAuthLogin(params: {
  context: McpOAuthCliContext;
  server: McpOAuthCliServer;
  openExternal: (url: string) => Promise<void>;
  spawnImpl?: McpOAuthSpawn;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const serverKey = params.server.key;
  if (activeLogins.has(serverKey)) {
    throw new McpOAuthCliError(McpOAuthErrorCode.AlreadyInProgress, 'Sign-in is already in progress for this server.');
  }
  if (params.signal?.aborted) throw createCancelledError();
  activeLogins.add(serverKey);
  let openedUrl = false;
  let callbackUnavailable = false;
  try {
    const result = await runCli(params.context, [params.server], ['login', serverKey], {
      timeoutMs: params.timeoutMs ?? MCP_OAUTH_LOGIN_TIMEOUT_MS,
      spawnImpl: params.spawnImpl,
      signal: params.signal,
      onStdoutLine: line => {
        // Printed before the URL when the loopback port (8989) is taken. The CLI then
        // exits 0 without a token, so opening the browser would only lead to a dead redirect.
        if (/could not start the local oauth callback/i.test(line)) callbackUnavailable = true;
        if (openedUrl || callbackUnavailable || params.signal?.aborted) return;
        const url = extractMcpAuthorizationUrl(line);
        if (!url) return;
        openedUrl = true;
        params.openExternal(url).catch(error =>
          console.warn('[MCP] failed to open OAuth authorization URL:', error instanceof Error ? error.message : error),
        );
      },
    });
    if (result.cancelled) throw createCancelledError();
    if (result.timedOut) {
      throw new McpOAuthCliError(McpOAuthErrorCode.Timeout, 'Timed out waiting for the browser authorization.');
    }
    if (callbackUnavailable) {
      throw new McpOAuthCliError(
        McpOAuthErrorCode.CallbackUnavailable,
        'Could not start the local OAuth callback on 127.0.0.1:8989. Close the program using that port and retry.',
      );
    }
    if (result.code !== 0) {
      throw new McpOAuthCliError(
        McpOAuthErrorCode.Failed,
        tail(result.stderr) || tail(result.stdout) || `openclaw mcp login exited with code ${result.code}`,
      );
    }
    // Success always ends with "MCP OAuth credentials saved" — including the case
    // where the stored credentials were still valid and no URL was printed.
    if (!/credentials saved/i.test(result.stdout)) {
      throw new McpOAuthCliError(McpOAuthErrorCode.Failed, tail(result.stdout) || 'Authorization did not complete.');
    }
  } finally {
    activeLogins.delete(serverKey);
  }
}

export async function runMcpOAuthLogout(params: {
  context: McpOAuthCliContext;
  server: McpOAuthCliServer;
  spawnImpl?: McpOAuthSpawn;
}): Promise<void> {
  const result = await runCli(params.context, [params.server], ['logout', params.server.key], {
    timeoutMs: MCP_OAUTH_STATUS_TIMEOUT_MS,
    spawnImpl: params.spawnImpl,
  });
  if (result.code !== 0) {
    throw new McpOAuthCliError(
      McpOAuthErrorCode.Failed,
      tail(result.stderr) || tail(result.stdout) || `openclaw mcp logout exited with code ${result.code}`,
    );
  }
}

/**
 * Whether an update drops the identity OpenClaw keys stored tokens by (server
 * name + URL), or stops using OAuth. The old tokens can no longer be used or
 * signed out of afterwards, so they should be cleared before the update.
 */
export function isMcpOAuthIdentityRemoved(
  existing: Pick<McpServerRecord, 'name' | 'url'>,
  update: Partial<Pick<McpServerFormData, 'name' | 'url' | 'transportType' | 'auth'>>,
): boolean {
  if (update.transportType === 'stdio') return true;
  if (update.auth !== undefined && update.auth !== McpAuthMode.OAuth) return true;
  if (update.name !== undefined && update.name !== existing.name) return true;
  return update.url !== undefined && update.url !== existing.url;
}

/**
 * `openclaw mcp logout` before a server is deleted or loses its OAuth identity,
 * including a disabled server that the gateway's openclaw.json does not list.
 * Never throws.
 */
export async function clearMcpOAuthCredentialsBestEffort(params: {
  context: McpOAuthCliContext;
  server: McpOAuthCliServer;
  spawnImpl?: McpOAuthSpawn;
}): Promise<boolean> {
  try {
    await runMcpOAuthLogout(params);
    return true;
  } catch (error) {
    console.warn('[MCP] failed to clear OAuth credentials:', error instanceof Error ? error.message : error);
    return false;
  }
}

/** `openclaw mcp status --json` does not connect to servers, so it is cheap to call. */
export async function readMcpOAuthStatuses(params: {
  context: McpOAuthCliContext;
  servers: McpOAuthCliServer[];
  spawnImpl?: McpOAuthSpawn;
}): Promise<Record<string, McpOAuthState>> {
  const result = await runCli(params.context, params.servers, ['status', '--json'], {
    timeoutMs: MCP_OAUTH_STATUS_TIMEOUT_MS,
    spawnImpl: params.spawnImpl,
  });
  if (result.code !== 0) {
    throw new McpOAuthCliError(
      McpOAuthErrorCode.Failed,
      tail(result.stderr) || `openclaw mcp status exited with code ${result.code}`,
    );
  }
  return parseMcpOAuthStatusOutput(result.stdout);
}
