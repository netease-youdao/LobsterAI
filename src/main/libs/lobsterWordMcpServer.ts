import fs from 'fs';
import path from 'path';

import { WORD_AGENT_TIMEOUT_MS, WORD_AGENT_TOOL_DEFINITIONS } from '../../shared/artifactPreview/wordAgent';

const SERVER_FILE_NAME = 'lobster-word-mcp-server.mjs';
const RUNTIME_CONFIG_FILE_NAME = 'lobster-word-mcp-runtime.json';

export interface LobsterWordMcpLaunchOptions {
  electronNodeRuntimePath: string;
  bridgeUrl: string;
  bridgeSecret: string;
}

export interface LobsterWordMcpStdioLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * A dependency-free MCP stdio server run with Electron's Node. It lists the Word tools and
 * forwards each call to LobsterAI's authenticated loopback bridge, which drives the editor.
 */
export const buildLobsterWordMcpServerSource = (): string => String.raw`import fs from 'node:fs/promises';
import readline from 'node:readline';

const tools = ${JSON.stringify(WORD_AGENT_TOOL_DEFINITIONS)};
const requestTimeoutMs = ${WORD_AGENT_TIMEOUT_MS + 5000};

function writeDiagnostic(message) {
  process.stderr.write('[LobsterWordMcp] ' + message + '\n');
}

const runtimeConfig = await fs.readFile(new URL('./${RUNTIME_CONFIG_FILE_NAME}', import.meta.url), 'utf8')
  .then((raw) => JSON.parse(raw))
  .catch((error) => {
    writeDiagnostic('runtime-config-error ' + (error instanceof Error ? error.message : String(error)));
    return null;
  });
const bridgeUrl = runtimeConfig?.version === 1 && typeof runtimeConfig.bridgeUrl === 'string' ? runtimeConfig.bridgeUrl : '';
const bridgeSecret = runtimeConfig?.version === 1 && typeof runtimeConfig.bridgeSecret === 'string' ? runtimeConfig.bridgeSecret : '';

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callBridge(name, args) {
  if (!bridgeUrl || !bridgeSecret) return errorResult('The LobsterAI Word bridge is not configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-bridge-secret': bridgeSecret },
      body: JSON.stringify({ tool: name, args: args || {} }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!payload || !Array.isArray(payload.content)) {
      return errorResult('The LobsterAI Word bridge returned HTTP ' + response.status + '.');
    }
    return payload;
  } catch (error) {
    writeDiagnostic('bridge-request-failed tool=' + name + ' error=' + (error instanceof Error ? error.message : String(error)));
    return errorResult('LobsterAI is not reachable: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handleRequest(message) {
  if (!message || message.jsonrpc !== '2.0' || !message.method) return;
  if (message.method.startsWith('notifications/')) return;
  let result;
  if (message.method === 'initialize') {
    result = {
      protocolVersion: message.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'lobster-word', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    result = { tools };
  } else if (message.method === 'tools/call') {
    const name = message.params?.name;
    result = typeof name === 'string' && tools.some((tool) => tool.name === name)
      ? await callBridge(name, message.params?.arguments || {})
      : errorResult('Unknown LobsterAI Word tool.');
  } else if (message.method === 'ping') {
    result = {};
  } else {
    writeMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  if (message.id !== undefined) writeMessage({ jsonrpc: '2.0', id: message.id, result });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    writeDiagnostic('invalid-json-rpc');
    return;
  }
  void handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      writeMessage({ jsonrpc: '2.0', id: message.id, result: errorResult(error instanceof Error ? error.message : String(error)) });
    }
  });
});
`;

const writeFileIfChanged = (filePath: string, contents: string, mode: number): void => {
  let current: string | null = null;
  try {
    current = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Not written yet.
  }
  if (current !== contents) fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode });
  if (process.platform !== 'win32') fs.chmodSync(filePath, mode);
};

/** Write the server and its bridge credentials under the generated OpenClaw state directory. */
export const resolveLobsterWordMcpStdioLaunch = (
  baseDir: string,
  options: LobsterWordMcpLaunchOptions,
): LobsterWordMcpStdioLaunch => {
  if (!options.electronNodeRuntimePath.trim() || !options.bridgeUrl.trim() || !options.bridgeSecret) {
    throw new Error('LobsterAI Word MCP requires an Electron Node runtime and an active bridge.');
  }
  const serverDir = path.join(baseDir, 'lobster-word-mcp');
  fs.mkdirSync(serverDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(serverDir, 0o700);
  const serverPath = path.join(serverDir, SERVER_FILE_NAME);
  writeFileIfChanged(serverPath, buildLobsterWordMcpServerSource(), 0o600);
  writeFileIfChanged(
    path.join(serverDir, RUNTIME_CONFIG_FILE_NAME),
    `${JSON.stringify({ version: 1, bridgeUrl: options.bridgeUrl, bridgeSecret: options.bridgeSecret }, null, 2)}\n`,
    0o600,
  );
  return { command: options.electronNodeRuntimePath, args: [serverPath], env: { ELECTRON_RUN_AS_NODE: '1' } };
};
