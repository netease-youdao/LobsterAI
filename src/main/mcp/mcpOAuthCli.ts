import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { McpOAuthErrorCode, McpOAuthState } from '../../shared/mcp/auth';
import { McpUrlProtocol } from '../../shared/mcp/url';
import { resolveOpenClawCliPath } from '../libs/openclawPluginInstallMigration';

/**
 * Drives OpenClaw's MCP OAuth CLI (`openclaw mcp login|logout|status`) for remote
 * servers configured with `auth: "oauth"`. OpenClaw owns the whole OAuth flow
 * (discovery, dynamic registration, PKCE, loopback callback on 127.0.0.1:8989,
 * token storage and refresh); the app only needs to open the printed URL in the
 * user's browser and wait for the CLI to finish.
 *
 * The gateway reads the stored token from OpenClaw's state SQLite on every
 * request, so no gateway restart is needed after login. A server whose tool
 * catalog failed before login is retried by the gateway a few seconds later.
 */

// The CLI waits up to 5 minutes for the browser callback; leave room for startup.
export const MCP_OAUTH_LOGIN_TIMEOUT_MS = 5 * 60 * 1000 + 30_000;
export const MCP_OAUTH_STATUS_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_LIMIT = 2_000;

export interface McpOAuthCliContext {
  /** Electron binary run with ELECTRON_RUN_AS_NODE=1. */
  electronNodeRuntimePath: string;
  runtimeRoot: string;
  stateDir: string;
  configPath: string;
  /** Secrets referenced as ${VAR} in openclaw.json; the CLI loads the same config. */
  secretEnv: Record<string, string>;
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

export function buildMcpOAuthCliInvocation(context: McpOAuthCliContext, mcpArgs: string[]) {
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
        ...context.secretEnv,
        OPENCLAW_HOME: path.dirname(context.stateDir),
        OPENCLAW_STATE_DIR: context.stateDir,
        OPENCLAW_CONFIG_PATH: context.configPath,
        OPENCLAW_NO_RESPAWN: '1',
        ELECTRON_RUN_AS_NODE: '1',
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

/**
 * Whether openclaw.json lists `serverKey` under `mcp.servers`. LobsterAI writes a
 * minimal config without MCP servers until a model is configured, and the CLI
 * then fails with a bare "No MCP server named ..." error. An unreadable config
 * returns true so the CLI can report the real problem.
 */
export function isMcpServerInOpenClawConfig(configPath: string, serverKey: string): boolean {
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return true;
  }
  const servers = (config as { mcp?: { servers?: unknown } } | null)?.mcp?.servers;
  return Boolean(servers && typeof servers === 'object' && Object.prototype.hasOwnProperty.call(servers, serverKey));
}

const SERVER_NOT_LOADED_MESSAGE =
  'OpenClaw has not loaded this MCP server yet. Configure a model first, then sign in again.';

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_LIMIT ? trimmed.slice(-OUTPUT_TAIL_LIMIT) : trimmed;
}

function runCli(
  context: McpOAuthCliContext,
  mcpArgs: string[],
  options: {
    timeoutMs: number;
    spawnImpl?: McpOAuthSpawn;
    onStdoutLine?: (line: string) => void;
  },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const invocation = buildMcpOAuthCliInvocation(context, mcpArgs);
  const child = (options.spawnImpl ?? defaultSpawn)(invocation.command, invocation.args, invocation.options);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
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
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code: number | null) => {
      clearTimeout(timer);
      if (pending && options.onStdoutLine) options.onStdoutLine(pending);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

const activeLogins = new Set<string>();

export function createServerNotLoadedError(): McpOAuthCliError {
  return new McpOAuthCliError(McpOAuthErrorCode.ServerNotLoaded, SERVER_NOT_LOADED_MESSAGE);
}

/**
 * Runs `openclaw mcp login <serverKey>`, opening the authorization URL in the
 * system browser as soon as the CLI prints it. Resolves once OpenClaw has
 * stored the credentials; rejects with a McpOAuthCliError otherwise.
 */
export async function runMcpOAuthLogin(params: {
  context: McpOAuthCliContext;
  serverKey: string;
  openExternal: (url: string) => Promise<void>;
  spawnImpl?: McpOAuthSpawn;
  timeoutMs?: number;
}): Promise<void> {
  if (activeLogins.has(params.serverKey)) {
    throw new McpOAuthCliError(McpOAuthErrorCode.AlreadyInProgress, 'Sign-in is already in progress for this server.');
  }
  activeLogins.add(params.serverKey);
  let openedUrl = false;
  let callbackUnavailable = false;
  try {
    const result = await runCli(params.context, ['login', params.serverKey], {
      timeoutMs: params.timeoutMs ?? MCP_OAUTH_LOGIN_TIMEOUT_MS,
      spawnImpl: params.spawnImpl,
      onStdoutLine: line => {
        // Printed before the URL when the loopback port (8989) is taken. The CLI then
        // exits 0 without a token, so opening the browser would only lead to a dead redirect.
        if (/could not start the local oauth callback/i.test(line)) callbackUnavailable = true;
        if (openedUrl || callbackUnavailable) return;
        const url = extractMcpAuthorizationUrl(line);
        if (!url) return;
        openedUrl = true;
        params.openExternal(url).catch(error =>
          console.warn('[MCP] failed to open OAuth authorization URL:', error instanceof Error ? error.message : error),
        );
      },
    });
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
      if (/no mcp server named/i.test(`${result.stderr}\n${result.stdout}`)) {
        throw new McpOAuthCliError(McpOAuthErrorCode.ServerNotLoaded, SERVER_NOT_LOADED_MESSAGE);
      }
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
    activeLogins.delete(params.serverKey);
  }
}

export async function runMcpOAuthLogout(params: {
  context: McpOAuthCliContext;
  serverKey: string;
  spawnImpl?: McpOAuthSpawn;
}): Promise<void> {
  const result = await runCli(params.context, ['logout', params.serverKey], {
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

/** `openclaw mcp status --json` does not connect to servers, so it is cheap to call. */
export async function readMcpOAuthStatuses(params: {
  context: McpOAuthCliContext;
  spawnImpl?: McpOAuthSpawn;
}): Promise<Record<string, McpOAuthState>> {
  const result = await runCli(params.context, ['status', '--json'], {
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
