import fs from 'fs';
import path from 'path';

import {
  BrowserCredentialLoginTool,
  BrowserCredentialMcpServer,
} from '../../shared/browserCredentials/constants';

const SERVER_FILE_NAME = 'lobster-browser-mcp-server.mjs';
const RUNTIME_CONFIG_FILE_NAME = 'lobster-browser-mcp-runtime.json';
const WINDOWS_LAUNCHER_FILE_NAME = 'lobster-browser-mcp.cmd';
const POSIX_LAUNCHER_FILE_NAME = 'lobster-browser-mcp';

export interface LobsterBrowserMcpLaunchOptions {
  electronNodeRuntimePath: string;
  bridgeUrl: string;
  bridgeSecret: string;
  platform?: NodeJS.Platform;
}

export interface LobsterBrowserMcpStdioLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const MCP_SERVER_SOURCE = String.raw`import fs from 'node:fs/promises';
import readline from 'node:readline';

function formatDiagnosticError(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 2000);
}

function writeDiagnostic(message) {
  process.stderr.write('[LobsterBrowserMcp] ' + message + '\n');
}

function formatBridgeEndpoint(value) {
  if (!value) return '<missing>';
  try {
    const endpoint = new URL(value);
    return endpoint.protocol + '//' + endpoint.host + endpoint.pathname;
  } catch {
    return '<invalid>';
  }
}

process.on('uncaughtExceptionMonitor', (error, origin) => {
  writeDiagnostic(
    'uncaught-exception origin=' + JSON.stringify(origin)
    + ' error=' + JSON.stringify(formatDiagnosticError(error)),
  );
});

let runtimeConfigState = 'loaded';
const runtimeConfig = await fs.readFile(
  new URL('./${RUNTIME_CONFIG_FILE_NAME}', import.meta.url),
  'utf8',
).then((raw) => {
  const parsed = JSON.parse(raw);
  if (
    parsed?.version !== 1
    || typeof parsed.bridgeUrl !== 'string'
    || typeof parsed.bridgeSecret !== 'string'
  ) {
    runtimeConfigState = 'invalid';
    return null;
  }
  return parsed;
}).catch((error) => {
  runtimeConfigState = 'read-error';
  writeDiagnostic('runtime-config-error error=' + JSON.stringify(formatDiagnosticError(error)));
  return null;
});

const bridgeUrlArg = process.argv.find((arg) => arg.startsWith('--lobster-bridge-url='));
const bridgeUrl = bridgeUrlArg
  ? bridgeUrlArg.slice('--lobster-bridge-url='.length)
  : runtimeConfig?.bridgeUrl || '';
const bridgeSecret = runtimeConfig?.bridgeSecret || '';

const credentialOnly = process.argv.includes('${BrowserCredentialMcpServer.ToolSetArgument}');
writeDiagnostic(
  'startup pid=' + process.pid
  + ' platform=' + process.platform
  + ' arch=' + process.arch
  + ' node=' + process.version
  + ' electronRunAsNode=' + (process.env.ELECTRON_RUN_AS_NODE === '1')
  + ' runtimeConfig=' + runtimeConfigState
  + ' bridge=' + formatBridgeEndpoint(bridgeUrl)
  + ' bridgeUrlArg=' + Boolean(bridgeUrlArg)
  + ' bridgeSecretConfigured=' + Boolean(bridgeSecret)
  + ' credentialOnly=' + credentialOnly,
);
const toolDefinitions = [
  ['list_pages', {}],
  ['new_page', { url: { type: 'string' }, timeout: { type: 'number' } }],
  ['select_page', { pageId: { type: 'number' }, bringToFront: { type: 'boolean' } }],
  ['close_page', { pageId: { type: 'number' } }],
  ['navigate_page', { pageId: { type: 'number' }, type: { type: 'string' }, url: { type: 'string' }, timeout: { type: 'number' } }],
  ['take_snapshot', { pageId: { type: 'number' }, verbose: { type: 'boolean' } }],
  ['take_screenshot', { pageId: { type: 'number' }, filePath: { type: 'string' }, format: { type: 'string' }, uid: { type: 'string' }, fullPage: { type: 'boolean' } }],
  ['click', { pageId: { type: 'number' }, uid: { type: 'string' }, dblClick: { type: 'boolean' } }],
  ['fill', { pageId: { type: 'number' }, uid: { type: 'string' }, value: { type: 'string' } }],
  ['fill_form', { pageId: { type: 'number' }, elements: { type: 'array', items: { type: 'object' } } }],
  ['hover', { pageId: { type: 'number' }, uid: { type: 'string' } }],
  ['drag', { pageId: { type: 'number' }, from_uid: { type: 'string' }, to_uid: { type: 'string' } }],
  ['upload_file', { pageId: { type: 'number' }, uid: { type: 'string' }, filePath: { type: 'string' } }],
  ['press_key', { pageId: { type: 'number' }, key: { type: 'string' } }],
  ['resize_page', { pageId: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }],
  ['handle_dialog', { pageId: { type: 'number' }, action: { type: 'string' }, promptText: { type: 'string' } }],
  ['evaluate_script', { pageId: { type: 'number' }, function: { type: 'string' }, args: { type: 'array' } }],
  ['wait_for', { pageId: { type: 'number' }, text: { type: 'string' }, timeout: { type: 'number' } }],
  ['${BrowserCredentialLoginTool.Name}', {
    pageId: { type: 'number' },
    accountHint: { type: 'string' },
    reason: { type: 'string' },
  }, 'Sign in through an isolated LobsterAI login view with a credential saved for the current website. The password is never returned to the Agent. This may ask the user for approval; after approval, continue the task without asking the user to type or paste the password.'],
];
const tools = toolDefinitions
  .filter(([name]) => !credentialOnly || name === '${BrowserCredentialLoginTool.Name}')
  .map(([name, properties, description]) => ({
  name,
  description: description || 'Operate the LobsterAI in-app browser.',
  inputSchema: { type: 'object', properties, additionalProperties: true },
  }));

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

async function callBridge(name, args) {
  if (!bridgeUrl || !bridgeSecret) {
    writeDiagnostic(
      'bridge-unavailable tool=' + JSON.stringify(name)
      + ' bridge=' + formatBridgeEndpoint(bridgeUrl)
      + ' bridgeSecretConfigured=' + Boolean(bridgeSecret),
    );
    return errorResult('LobsterAI browser bridge is not configured.');
  }
  let response;
  try {
    response = await fetch(bridgeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mcp-bridge-secret': bridgeSecret,
      },
      body: JSON.stringify({ tool: name, args: args || {} }),
    });
  } catch (error) {
    writeDiagnostic(
      'bridge-request-failed tool=' + JSON.stringify(name)
      + ' bridge=' + formatBridgeEndpoint(bridgeUrl)
      + ' error=' + JSON.stringify(formatDiagnosticError(error)),
    );
    throw error;
  }
  const payload = await response.json().catch(() => null);
  if (!payload) {
    writeDiagnostic(
      'bridge-invalid-json tool=' + JSON.stringify(name)
      + ' bridge=' + formatBridgeEndpoint(bridgeUrl)
      + ' status=' + response.status,
    );
  }
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : 'LobsterAI browser bridge returned HTTP ' + response.status + '.';
    writeDiagnostic(
      'bridge-http-error tool=' + JSON.stringify(name)
      + ' bridge=' + formatBridgeEndpoint(bridgeUrl)
      + ' status=' + response.status
      + ' error=' + JSON.stringify(formatDiagnosticError(message)),
    );
    return errorResult(message);
  }
  return payload;
}

async function callTool(name, args) {
  const result = await callBridge(name, args);
  if (name !== 'take_screenshot' || result?.isError) {
    return result;
  }

  const imageBase64 = result?.structuredContent?.imageBase64;
  const format = result?.structuredContent?.format === 'jpeg' ? 'jpeg' : 'png';
  const filePath = typeof args?.filePath === 'string' ? args.filePath : '';
  if (!imageBase64 || !filePath) {
    return errorResult('LobsterAI browser screenshot data or destination path is missing.');
  }
  await fs.writeFile(filePath + '.' + format, Buffer.from(imageBase64, 'base64'));
  return {
    content: [{ type: 'text', text: 'Screenshot saved.' }],
    structuredContent: { message: 'Screenshot saved.' },
  };
}

async function handleRequest(message) {
  if (!message || message.jsonrpc !== '2.0' || !message.method) return;
  if (message.method.startsWith('notifications/')) return;

  let result;
  if (message.method === 'initialize') {
    result = {
      protocolVersion: message.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'lobster-browser', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    result = { tools };
  } else if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (typeof name !== 'string' || !tools.some((tool) => tool.name === name)) {
      result = errorResult('Unknown LobsterAI browser tool.');
    } else {
      result = await callTool(name, message.params?.arguments || {});
    }
  } else if (message.method === 'ping') {
    result = {};
  } else {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Method not found' },
    });
    return;
  }

  if (message.id !== undefined) {
    writeMessage({ jsonrpc: '2.0', id: message.id, result });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const message = JSON.parse(trimmed);
    void handleRequest(message).catch((error) => {
      writeDiagnostic(
        'request-failed method=' + JSON.stringify(message.method)
        + ' tool=' + JSON.stringify(message.params?.name || '')
        + ' error=' + JSON.stringify(formatDiagnosticError(error)),
      );
      if (message.id !== undefined) {
        writeMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: errorResult(error instanceof Error ? error.message : String(error)),
        });
      }
    });
  } catch (error) {
    writeDiagnostic('invalid-json-rpc error=' + JSON.stringify(formatDiagnosticError(error)));
  }
});
`;

const formatBridgeEndpointForLog = (bridgeUrl: string): string => {
  try {
    const endpoint = new URL(bridgeUrl);
    return `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`;
  } catch {
    return '<invalid>';
  }
};

const escapeWindowsBatchValue = (value: string): string => value.replace(/%/g, '%%');

const quotePosixShellValue = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

// cmd.exe decodes batch files with the active console code page. Keep the
// bootstrap lines ASCII and switch to UTF-8 before it reads the literal
// Electron path, which may contain characters such as a Chinese install dir.
const buildWindowsLauncherSource = (electronNodeRuntimePath: string): string => [
  '@echo off',
  'chcp 65001 >nul 2>&1',
  'setlocal DisableDelayedExpansion',
  'set "ELECTRON_RUN_AS_NODE=1"',
  `"${escapeWindowsBatchValue(electronNodeRuntimePath)}" "%~dp0${SERVER_FILE_NAME}" %*`,
  '',
].join('\r\n');

const buildPosixLauncherSource = (electronNodeRuntimePath: string): string => [
  '#!/bin/sh',
  `exec env ELECTRON_RUN_AS_NODE=1 ${quotePosixShellValue(electronNodeRuntimePath)} "$(dirname "$0")/${SERVER_FILE_NAME}" "$@"`,
  '',
].join('\n');

const writeFileIfChanged = (filePath: string, contents: string, mode?: number): void => {
  let current: string | null = null;
  try {
    current = fs.readFileSync(filePath, 'utf8');
  } catch {
    // File does not exist yet.
  }
  if (current !== contents) {
    fs.writeFileSync(filePath, contents, {
      encoding: 'utf8',
      ...(mode !== undefined ? { mode } : {}),
    });
  }
  if (mode !== undefined && process.platform !== 'win32') {
    fs.chmodSync(filePath, mode);
  }
};

interface PreparedLobsterBrowserMcpRuntime {
  serverDir: string;
  serverPath: string;
}

const prepareLobsterBrowserMcpRuntime = (
  baseDir: string,
  options: LobsterBrowserMcpLaunchOptions,
): PreparedLobsterBrowserMcpRuntime => {
  if (!options.electronNodeRuntimePath.trim()) {
    throw new Error('LobsterAI browser MCP requires an Electron Node runtime path.');
  }
  if (!options.bridgeUrl.trim() || !options.bridgeSecret) {
    throw new Error('LobsterAI browser MCP requires an active browser bridge.');
  }

  const serverDir = path.join(baseDir, 'lobster-browser-mcp');
  fs.mkdirSync(serverDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(serverDir, 0o700);
  }
  const serverPath = path.join(serverDir, SERVER_FILE_NAME);
  writeFileIfChanged(serverPath, MCP_SERVER_SOURCE, 0o600);
  writeFileIfChanged(
    path.join(serverDir, RUNTIME_CONFIG_FILE_NAME),
    `${JSON.stringify({
      version: 1,
      bridgeUrl: options.bridgeUrl,
      bridgeSecret: options.bridgeSecret,
    }, null, 2)}\n`,
    0o600,
  );

  return { serverDir, serverPath };
};

export const resolveLobsterBrowserMcpCommand = (
  baseDir: string,
  options: LobsterBrowserMcpLaunchOptions,
): string => {
  const { serverDir } = prepareLobsterBrowserMcpRuntime(baseDir, options);

  if ((options.platform ?? process.platform) === 'win32') {
    const launcherPath = path.join(serverDir, WINDOWS_LAUNCHER_FILE_NAME);
    writeFileIfChanged(
      launcherPath,
      buildWindowsLauncherSource(options.electronNodeRuntimePath),
      0o700,
    );
    console.log('[LobsterBrowserMcp] Prepared browser MCP launcher', {
      platform: options.platform ?? process.platform,
      launcherPath,
      launcherExists: fs.existsSync(launcherPath),
      electronNodeRuntimePath: options.electronNodeRuntimePath,
      electronNodeRuntimeExists: fs.existsSync(options.electronNodeRuntimePath),
      bridgeEndpoint: formatBridgeEndpointForLog(options.bridgeUrl),
    });
    return launcherPath;
  }

  const launcherPath = path.join(serverDir, POSIX_LAUNCHER_FILE_NAME);
  writeFileIfChanged(
    launcherPath,
    buildPosixLauncherSource(options.electronNodeRuntimePath),
    0o700,
  );
  console.log('[LobsterBrowserMcp] Prepared browser MCP launcher', {
    platform: options.platform ?? process.platform,
    launcherPath,
    launcherExists: fs.existsSync(launcherPath),
    electronNodeRuntimePath: options.electronNodeRuntimePath,
    electronNodeRuntimeExists: fs.existsSync(options.electronNodeRuntimePath),
    bridgeEndpoint: formatBridgeEndpointForLog(options.bridgeUrl),
  });
  return launcherPath;
};

export const resolveLobsterBrowserMcpStdioLaunch = (
  baseDir: string,
  options: LobsterBrowserMcpLaunchOptions,
): LobsterBrowserMcpStdioLaunch => {
  const { serverPath } = prepareLobsterBrowserMcpRuntime(baseDir, options);
  console.log('[LobsterBrowserMcp] Prepared browser MCP stdio launch', {
    platform: options.platform ?? process.platform,
    serverPath,
    serverExists: fs.existsSync(serverPath),
    electronNodeRuntimePath: options.electronNodeRuntimePath,
    electronNodeRuntimeExists: fs.existsSync(options.electronNodeRuntimePath),
    bridgeEndpoint: formatBridgeEndpointForLog(options.bridgeUrl),
  });
  return {
    command: options.electronNodeRuntimePath,
    args: [serverPath],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
};
