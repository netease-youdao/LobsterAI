/**
 * resolveStdioCommand — resolves stdio MCP server commands for the current platform.
 *
 * On packaged builds, node/npx/npm commands are resolved in this order:
 * 1. Use system-installed Node.js if available (avoids Electron stdin quirks)
 * 2. Fall back to Electron runtime with ELECTRON_RUN_AS_NODE=1
 *
 * Extracted from McpServerManager for reuse by openclawConfigSync (native MCP migration).
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import type { McpServerRecord } from '../mcp/mcpStore';
import { getElectronNodeRuntimePath } from './coworkUtil';
import { findSpawnableSystemNodePath } from './nodeRuntime';

export interface ResolvedStdioCommand {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
}

/**
 * Get the packaged npm bin directory path.
 * This is a lightweight alternative to getEnhancedEnv() — it only computes
 * the LOBSTERAI_NPM_BIN_DIR path without resolving API config or proxy settings.
 */
function getPackagedNpmBinDir(): string | undefined {
  if (!app.isPackaged) return undefined;
  const npmBinDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin');
  return fs.existsSync(npmBinDir) ? npmBinDir : undefined;
}

const log = (level: string, msg: string) => {
  const formatted = `[MCP:Resolve][${level}] ${msg}`;
  if (level === 'ERROR') {
    console.error(formatted);
  } else if (level === 'WARN') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
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

// ── Command resolution ────────────────────────────────────────────

/**
 * Check whether a system-installed Node.js runtime is available on the PATH.
 * Caches the result for the lifetime of the process to avoid repeated lookups.
 */
let _systemNodePath: string | false | undefined;

export function findSystemNodePath(): string | null {
  if (_systemNodePath !== undefined) {
    return _systemNodePath || null;
  }
  const resolved = findSpawnableSystemNodePath();
  if (resolved) {
    _systemNodePath = resolved;
    log('INFO', `System Node.js found: ${resolved}`);
    return resolved;
  }
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
export async function resolveStdioCommand(server: McpServerRecord): Promise<ResolvedStdioCommand> {
  const stdioCommand = server.command || '';
  let effectiveCommand = stdioCommand;
  const stdioArgs = server.args || [];
  let effectiveArgs = [...stdioArgs];
  let stdioEnv = server.env && Object.keys(server.env).length > 0
    ? { ...server.env }
    : undefined;
  let shouldInjectWindowsHide = false;

  const electronNodeRuntimePath = getElectronNodeRuntimePath();

  // Resolve node/npx/npm commands on Windows (both dev and packaged mode).
  // The MCP SDK's StdioClientTransport only inherits a limited set of env vars
  // (PATH, APPDATA, TEMP, etc.) — our node shims in PATH need LOBSTERAI_ELECTRON_PATH
  // and LOBSTERAI_NPM_BIN_DIR which won't be inherited. Pre-resolving to absolute
  // paths avoids depending on shims entirely.
  if (process.platform === 'win32' && effectiveCommand) {
    const normalized = effectiveCommand.trim().toLowerCase();
    const nodeCommandType = isNodeCommand(normalized);

    if (nodeCommandType) {
      const systemNode = findSystemNodePath();
      if (systemNode) {
        if (nodeCommandType === 'node') {
          effectiveCommand = systemNode;
          log('INFO', `"${server.name}": using system Node.js "${systemNode}" (preferred over Electron runtime)`);
        } else {
          let npmBinDir = getPackagedNpmBinDir();
          // In dev mode, the packaged npmBinDir may not exist.
          // Fall back to the npm bin dir relative to system Node.js.
          if (!npmBinDir || !fs.existsSync(npmBinDir)) {
            const systemNpmBin = path.join(path.dirname(systemNode), 'node_modules', 'npm', 'bin');
            if (fs.existsSync(systemNpmBin)) {
              npmBinDir = systemNpmBin;
            }
          }
          const cliJs = nodeCommandType === 'npx'
            ? (npmBinDir ? path.join(npmBinDir, 'npx-cli.js') : '')
            : (npmBinDir ? path.join(npmBinDir, 'npm-cli.js') : '');
          if (cliJs && fs.existsSync(cliJs)) {
            effectiveCommand = systemNode;
            effectiveArgs = [cliJs, ...stdioArgs];
            log('INFO', `"${server.name}": using system Node.js "${systemNode}" + ${nodeCommandType}-cli.js (preferred over Electron runtime)`);
          } else {
            // npx-cli.js not found; use the system npx/npm executable directly
            // (cross-spawn handles .cmd files on Windows)
            const systemBinCmd = path.join(path.dirname(systemNode), `${nodeCommandType}.cmd`);
            if (fs.existsSync(systemBinCmd)) {
              effectiveCommand = systemBinCmd;
              effectiveArgs = [...stdioArgs];
              log('INFO', `"${server.name}": using system "${systemBinCmd}" directly`);
            } else {
              log('INFO', `"${server.name}": keeping raw "${stdioCommand}" (system fallback not found)`);
            }
          }
        }
      } else if (app.isPackaged) {
        const npmBinDir = getPackagedNpmBinDir();
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
