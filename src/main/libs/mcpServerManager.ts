/**
 * McpServerManager — manages MCP server lifecycles and tool discovery
 * for the OpenClaw MCP Bridge.
 *
 * Starts enabled MCP servers as child processes via the MCP SDK stdio transport,
 * discovers available tools, and routes tool calls to the correct server.
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerRecord } from '../mcpStore';
import { getElectronNodeRuntimePath, getEnhancedEnv } from './coworkUtil';

export interface McpToolManifestEntry {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ManagedMcpServer {
  record: McpServerRecord;
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolManifestEntry[];
}

const log = (level: string, msg: string) => {
  console.log(`[McpBridge][${level}] ${msg}`);
};

// ── Windows hidden-subprocess init script ────────────────────────
const WINDOWS_HIDE_INIT_SCRIPT_NAME = 'mcp-bridge-windows-hide-init.js';
const WINDOWS_HIDE_INIT_SCRIPT_CONTENT = [
  '// Auto-generated: hide subprocess console windows on Windows',
  'const cp = require("child_process");',
  'for (const fn of ["spawn", "execFile"]) {',
  '  const original = cp[fn];',
  '  cp[fn] = function(file, args, options) {',
  '    const addWindowsHide = (o) => ({ ...(o || {}), windowsHide: true });',
  '    if (typeof args === "function" || args === undefined) {',
  '      return original.call(this, file, addWindowsHide(undefined), args);',
  '    }',
  '    return original.call(this, file, addWindowsHide(args), options);',
  '  };',
  '}',
  '',
].join('\n');

function ensureWindowsHideInitScript(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const dir = path.join(app.getPath('userData'), 'mcp-bridge', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const scriptPath = path.join(dir, WINDOWS_HIDE_INIT_SCRIPT_NAME);
    const existing = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
    if (existing !== WINDOWS_HIDE_INIT_SCRIPT_CONTENT) {
      fs.writeFileSync(scriptPath, WINDOWS_HIDE_INIT_SCRIPT_CONTENT, 'utf8');
    }
    return scriptPath;
  } catch (e) {
    log('WARN', `Failed to create Windows hide init script: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function prependRequireArg(args: string[], scriptPath: string): string[] {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--require' && args[i + 1] === scriptPath) return args;
  }
  return ['--require', scriptPath, ...args];
}

// ── Command resolution (mirrors coworkRunner logic) ──────────────

interface ResolvedStdioCommand {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
}

/**
 * Check whether a system-installed Node.js runtime is available on the PATH.
 * Caches the result for the lifetime of the process to avoid repeated lookups.
 */
let _systemNodePath: string | false | undefined;

function findSystemNodePath(): string | null {
  if (_systemNodePath !== undefined) {
    return _systemNodePath || null;
  }
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(whichCmd, ['node'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      const resolved = result.stdout.trim().split(/\r?\n/)[0].trim();
      if (resolved) {
        _systemNodePath = resolved;
        log('INFO', `System Node.js found: ${resolved}`);
        return resolved;
      }
    }
  } catch { /* ignore */ }
  _systemNodePath = false;
  log('INFO', 'System Node.js not found on PATH');
  return null;
}

/**
 * Check if a command is a node/npx/npm variant.
 */
function isNodeCommand(normalized: string): 'node' | 'npx' | 'npm' | null {
  if (
    normalized === 'node' || normalized === 'node.exe'
    || normalized.endsWith('\\node.cmd') || normalized.endsWith('/node.cmd')
  ) {
    return 'node';
  }
  if (
    normalized === 'npx' || normalized === 'npx.cmd'
    || normalized.endsWith('\\npx.cmd') || normalized.endsWith('/npx.cmd')
  ) {
    return 'npx';
  }
  if (
    normalized === 'npm' || normalized === 'npm.cmd'
    || normalized.endsWith('\\npm.cmd') || normalized.endsWith('/npm.cmd')
  ) {
    return 'npm';
  }
  return null;
}

/**
 * Resolve a stdio MCP server command/args/env for the current platform.
 *
 * On packaged builds, node/npx/npm commands are resolved in this order:
 * 1. Use system-installed Node.js if available (avoids Electron stdin quirks)
 * 2. Fall back to Electron runtime with ELECTRON_RUN_AS_NODE=1
 */
async function resolveStdioCommand(server: McpServerRecord): Promise<ResolvedStdioCommand> {
  const stdioCommand = server.command || '';
  let effectiveCommand = stdioCommand;
  const stdioArgs = server.args || [];
  let effectiveArgs = [...stdioArgs];
  let stdioEnv = server.env && Object.keys(server.env).length > 0
    ? { ...server.env }
    : undefined;
  let shouldInjectWindowsHide = false;

  const electronNodeRuntimePath = getElectronNodeRuntimePath();

  if (process.platform === 'win32' && app.isPackaged && effectiveCommand) {
    const normalized = effectiveCommand.trim().toLowerCase();
    const nodeCommandType = isNodeCommand(normalized);

    if (nodeCommandType) {
      const systemNode = findSystemNodePath();
      if (systemNode) {
        if (nodeCommandType === 'node') {
          effectiveCommand = systemNode;
          log('INFO', `"${server.name}": using system Node.js "${systemNode}" (preferred over Electron runtime)`);
        } else {
          const enhancedEnv = await getEnhancedEnv();
          const npmBinDir = enhancedEnv.LOBSTERAI_NPM_BIN_DIR;
          const cliJs = nodeCommandType === 'npx'
            ? (npmBinDir ? path.join(npmBinDir, 'npx-cli.js') : '')
            : (npmBinDir ? path.join(npmBinDir, 'npm-cli.js') : '');
          if (cliJs && fs.existsSync(cliJs)) {
            effectiveCommand = systemNode;
            effectiveArgs = [cliJs, ...stdioArgs];
            log('INFO', `"${server.name}": using system Node.js "${systemNode}" + ${nodeCommandType}-cli.js (preferred over Electron runtime)`);
          } else {
            effectiveCommand = stdioCommand;
            log('INFO', `"${server.name}": using system "${stdioCommand}" directly`);
          }
        }
      } else {
        const enhancedEnv = await getEnhancedEnv();
        const npmBinDir = enhancedEnv.LOBSTERAI_NPM_BIN_DIR;
        const npxCliJs = npmBinDir ? path.join(npmBinDir, 'npx-cli.js') : '';
        const npmCliJs = npmBinDir ? path.join(npmBinDir, 'npm-cli.js') : '';

        const withElectronNodeEnv = (base: Record<string, string> | undefined): Record<string, string> => ({
          ...(base || {}),
          ELECTRON_RUN_AS_NODE: '1',
          LOBSTERAI_ELECTRON_PATH: electronNodeRuntimePath,
        });

        if (nodeCommandType === 'node') {
          effectiveCommand = electronNodeRuntimePath;
          stdioEnv = withElectronNodeEnv(stdioEnv);
          shouldInjectWindowsHide = true;
          log('WARN', `"${server.name}": no system Node.js found, falling back to Electron runtime (may cause stdin issues)`);
        } else if (nodeCommandType === 'npx' && npxCliJs && fs.existsSync(npxCliJs)) {
          effectiveCommand = electronNodeRuntimePath;
          effectiveArgs = [npxCliJs, ...stdioArgs];
          stdioEnv = withElectronNodeEnv(stdioEnv);
          shouldInjectWindowsHide = true;
          log('WARN', `"${server.name}": no system Node.js found, falling back to Electron + npx-cli.js (may cause stdin issues)`);
        } else if (nodeCommandType === 'npm' && npmCliJs && fs.existsSync(npmCliJs)) {
          effectiveCommand = electronNodeRuntimePath;
          effectiveArgs = [npmCliJs, ...stdioArgs];
          stdioEnv = withElectronNodeEnv(stdioEnv);
          shouldInjectWindowsHide = true;
          log('WARN', `"${server.name}": no system Node.js found, falling back to Electron + npm-cli.js (may cause stdin issues)`);
        }
      }
    }
  }

  // macOS packaged: rewrite absolute command pointing to app executable
  if (app.isPackaged && process.platform === 'darwin' && stdioCommand && path.isAbsolute(stdioCommand)) {
    const commandCandidates = new Set([stdioCommand, path.resolve(stdioCommand)]);
    const appExecCandidates = new Set([
      process.execPath, path.resolve(process.execPath),
      electronNodeRuntimePath, path.resolve(electronNodeRuntimePath),
    ]);
    try { commandCandidates.add(fs.realpathSync.native(stdioCommand)); } catch { /* ignore */ }
    try { appExecCandidates.add(fs.realpathSync.native(process.execPath)); } catch { /* ignore */ }
    try { appExecCandidates.add(fs.realpathSync.native(electronNodeRuntimePath)); } catch { /* ignore */ }

    if (Array.from(commandCandidates).some(c => appExecCandidates.has(c))) {
      effectiveCommand = electronNodeRuntimePath;
      stdioEnv = {
        ...(stdioEnv || {}),
        ELECTRON_RUN_AS_NODE: '1',
        LOBSTERAI_ELECTRON_PATH: electronNodeRuntimePath,
      };
      log('INFO', `"${server.name}": rewrote macOS command → Electron helper`);
    }
  }

  // Inject Windows hidden-subprocess preload
  if (process.platform === 'win32' && shouldInjectWindowsHide) {
    const initScript = ensureWindowsHideInitScript();
    if (initScript) {
      effectiveArgs = prependRequireArg(effectiveArgs, initScript);
    }
  }

  return { command: effectiveCommand, args: effectiveArgs, env: stdioEnv };
}

// ── McpServerManager ─────────────────────────────────────────────

export class McpServerManager {
  private servers: Map<string, ManagedMcpServer> = new Map();
  private _toolManifest: McpToolManifestEntry[] = [];

  get toolManifest(): McpToolManifestEntry[] {
    return this._toolManifest;
  }

  get isRunning(): boolean {
    return this.servers.size > 0;
  }

  /**
   * Start MCP servers and discover their tools.
   */
  async startServers(enabledServers: McpServerRecord[]): Promise<McpToolManifestEntry[]> {
    // Only handle stdio servers for now
    const stdioServers = enabledServers.filter(s => s.transportType === 'stdio');
    log('INFO', `Starting ${stdioServers.length} stdio MCP servers`);

    const results = await Promise.allSettled(
      stdioServers.map(server => this.startSingleServer(server))
    );

    // Collect tools from all successfully started servers
    this._toolManifest = [];
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value) {
        this._toolManifest.push(...result.value.tools);
      } else if (result.status === 'rejected') {
        log('WARN', `Failed to start MCP server "${stdioServers[i].name}": ${result.reason}`);
      }
    }

    log('INFO', `Discovered ${this._toolManifest.length} tools from ${this.servers.size} servers`);
    return this._toolManifest;
  }

  private async startSingleServer(record: McpServerRecord): Promise<ManagedMcpServer | null> {
    if (record.transportType !== 'stdio') {
      log('WARN', `Skipping non-stdio server "${record.name}" (type=${record.transportType})`);
      return null;
    }

    const resolved = await resolveStdioCommand(record);
    if (!resolved.command) {
      log('WARN', `Server "${record.name}" has no command, skipping`);
      return null;
    }

    log('INFO', `Starting "${record.name}": command=${resolved.command}, args=${JSON.stringify(resolved.args)}`);

    const enhancedEnv = await getEnhancedEnv();
    const spawnEnv: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(enhancedEnv).filter((e): e is [string, string] => typeof e[1] === 'string'),
      ),
      ...(resolved.env || {}),
    };

    const transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: spawnEnv,
    });

    const stderrChunks: string[] = [];
    if (transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          stderrChunks.push(text);
          log('WARN', `"${record.name}" stderr: ${text}`);
        }
      });
    }

    const client = new Client(
      { name: `lobsterai-mcp-bridge`, version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      log('INFO', `Connected to MCP server "${record.name}"`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const stderrSummary = stderrChunks.length > 0
        ? ` | stderr: ${stderrChunks.join(' ').slice(0, 500)}`
        : '';
      log('ERROR', `Failed to connect to "${record.name}": ${errMsg}${stderrSummary}`);
      try { await transport.close(); } catch { /* ignore */ }
      return null;
    }

    // Discover tools
    let tools: McpToolManifestEntry[] = [];
    try {
      const result = await client.listTools();
      tools = (result.tools || []).map(t => ({
        server: record.name,
        name: t.name,
        description: t.description || '',
        inputSchema: (t.inputSchema || {}) as Record<string, unknown>,
      }));
      log('INFO', `Server "${record.name}": discovered ${tools.length} tools: [${tools.map(t => t.name).join(', ')}]`);
    } catch (error) {
      log('WARN', `Failed to list tools from "${record.name}": ${error instanceof Error ? error.message : String(error)}`);
    }

    const managed: ManagedMcpServer = { record, client, transport, tools };
    this.servers.set(record.name, managed);
    return managed;
  }

  /**
   * Execute a tool on the specified MCP server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError: boolean }> {
    const server = this.servers.get(serverName);
    if (!server) {
      return {
        content: [{ type: 'text', text: `MCP server "${serverName}" not found or not running` }],
        isError: true,
      };
    }

    try {
      log('INFO', `Calling tool "${toolName}" on server "${serverName}"`);
      const result = await server.client.callTool({ name: toolName, arguments: args });
      const content = Array.isArray(result.content)
        ? (result.content as Array<{ type: string; text?: string }>)
        : [{ type: 'text', text: String(result.content) }];
      return { content, isError: result.isError === true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log('ERROR', `Tool call "${toolName}" on "${serverName}" failed: ${errMsg}`);
      return {
        content: [{ type: 'text', text: `Tool execution error: ${errMsg}` }],
        isError: true,
      };
    }
  }

  /**
   * Stop all managed MCP servers.
   */
  async stopServers(): Promise<void> {
    log('INFO', `Stopping ${this.servers.size} MCP servers`);
    const closePromises: Promise<void>[] = [];

    for (const [name, server] of this.servers) {
      closePromises.push(
        (async () => {
          try {
            await server.client.close();
            log('INFO', `Stopped MCP server "${name}"`);
          } catch (error) {
            log('WARN', `Error stopping "${name}": ${error instanceof Error ? error.message : String(error)}`);
          }
        })()
      );
    }

    await Promise.allSettled(closePromises);
    this.servers.clear();
    this._toolManifest = [];
  }
}
