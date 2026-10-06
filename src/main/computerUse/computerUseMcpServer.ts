import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { getLanguage } from '../i18n';
import type { ResolvedMcpServer } from '../libs/openclawConfigSync';
import { findSystemNodePath } from '../libs/resolveStdioCommand';
import {
  ensureComputerUseLogDir,
  getComputerUseLogRetentionDays,
} from './computerUseLogs';
import {
  type ComputerUseRuntimePaths,
  ensureComputerUseHelperStateHome,
  inspectComputerUseRuntime,
} from './computerUseRuntime';

export const ComputerUseMcpServerName = {
  BuiltIn: 'computer-use',
} as const;
export type ComputerUseMcpServerName =
  typeof ComputerUseMcpServerName[keyof typeof ComputerUseMcpServerName];

export const ComputerUseMcpEnv = {
  AskUserUrl: 'LOBSTER_COMPUTER_USE_ASKUSER_URL',
  BridgeSecret: 'LOBSTER_MCP_BRIDGE_SECRET',
  ClientModulePath: 'LOBSTER_COMPUTER_USE_CLIENT_MODULE',
  ExePath: 'LOBSTER_COMPUTER_USE_EXE',
  HelperStateHome: 'LOBSTER_COMPUTER_USE_HOME',
  Locale: 'LOBSTER_COMPUTER_USE_LOCALE',
  LogDir: 'LOBSTER_COMPUTER_USE_LOG_DIR',
  LogLevel: 'LOBSTER_COMPUTER_USE_LOG_LEVEL',
  LogRetentionDays: 'LOBSTER_COMPUTER_USE_LOG_RETENTION_DAYS',
  RuntimePackageRoot: 'LOBSTER_COMPUTER_USE_RUNTIME_PACKAGE_ROOT',
  SdkRoot: 'LOBSTER_COMPUTER_USE_MCP_SDK_ROOT',
  SelfAppName: 'LOBSTER_COMPUTER_USE_SELF_APP',
  SelfPid: 'LOBSTER_COMPUTER_USE_SELF_PID',
  ZodRoot: 'LOBSTER_COMPUTER_USE_ZOD_ROOT',
} as const;
export type ComputerUseMcpEnv =
  typeof ComputerUseMcpEnv[keyof typeof ComputerUseMcpEnv];

/**
 * OpenClaw substitutes ${VAR} placeholders from the gateway environment when it
 * loads openclaw.json, so the per-launch bridge secret never lands on disk.
 */
export const COMPUTER_USE_BRIDGE_SECRET_PLACEHOLDER = '${LOBSTER_MCP_BRIDGE_SECRET}';

type ResolveComputerUseMcpServerOptions = {
  askUserCallbackUrl: string | null;
  electronNodePath: string;
};

const SERVER_SCRIPT_NAME = 'computer-use-mcp-server.mjs';

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolvePackageRoot(packageName: string): string | null {
  try {
    let currentDir = path.dirname(require.resolve(`${packageName}/package.json`));
    while (currentDir && currentDir !== path.dirname(currentDir)) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (isFile(packageJsonPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
            name?: string;
          };
          if (manifest.name === packageName) {
            return currentDir;
          }
        } catch {
          // Keep walking upward; package export shims can point at tiny
          // package.json files that are not the package root.
        }
      }
      currentDir = path.dirname(currentDir);
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveComputerUseRuntimePaths(): ComputerUseRuntimePaths | null {
  const inspection = inspectComputerUseRuntime();
  return inspection.paths;
}

export function getComputerUseMcpServerScript(): string {
  return COMPUTER_USE_MCP_SERVER_SCRIPT;
}

export function ensureComputerUseMcpServerScript(): string {
  const scriptDir = path.join(app.getPath('userData'), 'mcp-bridge', 'bin');
  fs.mkdirSync(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, SERVER_SCRIPT_NAME);
  const existing = isFile(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  if (existing !== COMPUTER_USE_MCP_SERVER_SCRIPT) {
    fs.writeFileSync(scriptPath, COMPUTER_USE_MCP_SERVER_SCRIPT, 'utf8');
  }
  return scriptPath;
}

export function resolveComputerUseMcpServer(
  options: ResolveComputerUseMcpServerOptions,
): ResolvedMcpServer | null {
  if (!options.askUserCallbackUrl) {
    console.warn('[ComputerUseMCP] skipped built-in server because AskUser callback is unavailable');
    return null;
  }

  const runtimePaths = resolveComputerUseRuntimePaths();
  if (!runtimePaths) {
    const inspection = inspectComputerUseRuntime();
    const missing = inspection.missing.length > 0
      ? `; missing=${inspection.missing.join(', ')}`
      : '';
    console.warn(
      `[ComputerUseMCP] skipped built-in server because Computer Use runtime is not installed (status=${inspection.status}, userData=${app.getPath('userData')}${missing})`,
    );
    return null;
  }

  if (!runtimePaths.clientModulePath || !runtimePaths.helperExePath || !runtimePaths.runtimePackageRoot) {
    console.warn(`[ComputerUseMCP] skipped built-in server because ${runtimePaths.mode} runtime paths are incomplete`);
    return null;
  }

  const sdkRoot = resolvePackageRoot('@modelcontextprotocol/sdk');
  const zodRoot = resolvePackageRoot('zod');
  if (!sdkRoot || !zodRoot) {
    console.warn('[ComputerUseMCP] skipped built-in server because MCP SDK or zod was not found');
    return null;
  }

  const systemNodePath = app.isPackaged ? null : findSystemNodePath();
  const command = systemNodePath || options.electronNodePath;
  const env: Record<string, string> = {
    [ComputerUseMcpEnv.AskUserUrl]: options.askUserCallbackUrl,
    [ComputerUseMcpEnv.BridgeSecret]: COMPUTER_USE_BRIDGE_SECRET_PLACEHOLDER,
    [ComputerUseMcpEnv.ClientModulePath]: runtimePaths.clientModulePath,
    [ComputerUseMcpEnv.ExePath]: runtimePaths.helperExePath,
    [ComputerUseMcpEnv.HelperStateHome]: ensureComputerUseHelperStateHome(),
    [ComputerUseMcpEnv.Locale]: getLanguage(),
    [ComputerUseMcpEnv.LogDir]: ensureComputerUseLogDir(),
    [ComputerUseMcpEnv.LogLevel]: 'info',
    [ComputerUseMcpEnv.LogRetentionDays]: String(getComputerUseLogRetentionDays()),
    [ComputerUseMcpEnv.RuntimePackageRoot]: runtimePaths.runtimePackageRoot,
    [ComputerUseMcpEnv.SdkRoot]: sdkRoot,
    [ComputerUseMcpEnv.SelfAppName]: app.getName(),
    [ComputerUseMcpEnv.SelfPid]: String(process.pid),
    [ComputerUseMcpEnv.ZodRoot]: zodRoot,
  };
  if (!systemNodePath) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  return {
    name: ComputerUseMcpServerName.BuiltIn,
    transportType: 'stdio',
    command,
    args: [ensureComputerUseMcpServerScript()],
    env,
  };
}

// Platform-neutral MCP bridge between OpenClaw and the platform client module.
// It is written to userData and run with Node, so keep it plain ESM without
// template literals (this file embeds it in a String.raw template).
const COMPUTER_USE_MCP_SERVER_SCRIPT = String.raw`import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const env = process.env;
// LOBSTER_COMPUTER_USE_PLATFORM lets tests exercise the macOS bridge behavior elsewhere.
const IS_MAC = (env.LOBSTER_COMPUTER_USE_PLATFORM || process.platform) === 'darwin';

function requireEnv(name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(name + ' is required');
  }
  return value;
}

function moduleUrl(...parts) {
  return pathToFileURL(path.join(...parts)).href;
}

const sdkRoot = requireEnv('LOBSTER_COMPUTER_USE_MCP_SDK_ROOT');
const zodRoot = requireEnv('LOBSTER_COMPUTER_USE_ZOD_ROOT');
const clientModulePath = requireEnv('LOBSTER_COMPUTER_USE_CLIENT_MODULE');
const helperExePath = requireEnv('LOBSTER_COMPUTER_USE_EXE');
const askUserUrl = requireEnv('LOBSTER_COMPUTER_USE_ASKUSER_URL');
const bridgeSecret = requireEnv('LOBSTER_MCP_BRIDGE_SECRET');
const helperStateHome = requireEnv('LOBSTER_COMPUTER_USE_HOME');
const locale = String(env.LOBSTER_COMPUTER_USE_LOCALE || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh';
const selfPid = Number(env.LOBSTER_COMPUTER_USE_SELF_PID || 0) || null;
const selfAppName = String(env.LOBSTER_COMPUTER_USE_SELF_APP || 'LobsterAI').trim();

const { McpServer } = await import(moduleUrl(sdkRoot, 'dist', 'esm', 'server', 'mcp.js'));
const { StdioServerTransport } = await import(moduleUrl(sdkRoot, 'dist', 'esm', 'server', 'stdio.js'));
const { z } = await import(moduleUrl(zodRoot, 'index.js'));
const clientModule = await import(pathToFileURL(clientModulePath).href);
const ComputerUseClient = clientModule.ComputerUseClient
  ?? clientModule.WindowsComputerUseClient
  ?? clientModule.MacComputerUseClient;
if (!ComputerUseClient) {
  throw new Error('Computer Use client module must export ComputerUseClient');
}

const APPROVED_APP_META_KEY = 'x-lobsterai-computer-use-approved-app';
const MAX_TEXT_CHARS = 30000;
const MAX_WAIT_MS = 45000;
const deniedAppPattern = [
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'windowsterminal.exe',
  'wt.exe',
  'openssh',
  'terminal',
  '终端',
  'iterm',
  'warp',
  'ghostty',
  'alacritty',
  'wezterm',
  '1password',
  'keepass',
  'bitwarden',
  'lastpass',
  'dashlane',
  'enpass',
  'credential',
  'keychain',
  '钥匙串',
  'com\\.apple\\.passwords',
  '^passwords$',
  '^密码$',
  'securityagent',
  'coreautha',
  'securityhealth',
  'windowsdefender',
  'taskmgr.exe',
  'activity monitor',
  '活动监视器',
].join('|');
const deniedAppRe = new RegExp(deniedAppPattern, 'i');

const STRINGS = {
  zh: {
    title: '电脑操作',
    subtitle: 'LobsterAI 需要操作你电脑上的应用',
    question: (app) => '允许 LobsterAI 操作「' + app + '」吗？',
    allow: '允许',
    allowDescription: IS_MAC
      ? '本次会话中允许查看并操作该应用。无法在后台完成的步骤会短暂接管鼠标和键盘，按 Esc 可随时停止。'
      : '本次会话中允许查看并操作该应用，按 Esc 可随时停止。',
    deny: '拒绝',
    denyDescription: '不允许操作该应用',
  },
  en: {
    title: 'Computer Use',
    subtitle: 'LobsterAI wants to use an app on your computer',
    question: (app) => 'Allow LobsterAI to use "' + app + '"?',
    allow: 'Allow',
    allowDescription: IS_MAC
      ? 'Lets LobsterAI view and operate this app for this session. Steps that cannot run in the background briefly take over the mouse and keyboard. Press Esc to stop at any time.'
      : 'Lets LobsterAI view and operate this app for this session. Press Esc to stop at any time.',
    deny: 'Deny',
    denyDescription: 'Do not allow this app.',
  },
};
const text = STRINGS[locale];

const approvedApps = new Set();
const windowInfoById = new Map();
let nextTurnId = 0;
function createHelperTurnId() {
  return String(Date.now()) + '-' + String(++nextTurnId);
}
const requestMeta = {
  computerUseHome: helperStateHome,
  session_id: 'lobsterai-computer-use',
  turn_id: createHelperTurnId(),
};

function truncateText(value, maxChars = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars) + '\n\n[truncated ' + (value.length - maxChars) + ' chars]';
}

function normalizeAppLabel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'Unknown app';
}

function appKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isDeniedApp(...labels) {
  return labels.some(label => label && deniedAppRe.test(String(label)));
}

function isSelfApp(label, pid) {
  if (selfPid && Number(pid) === selfPid) {
    return true;
  }
  return Boolean(selfAppName) && appKey(label) === appKey(selfAppName);
}

function rememberWindows(windows) {
  if (!Array.isArray(windows)) {
    return;
  }
  for (const window of windows) {
    if (window && typeof window === 'object' && window.id !== undefined) {
      windowInfoById.set(Number(window.id), {
        app: window.app,
        bundleId: typeof window.bundleId === 'string' ? window.bundleId : undefined,
        pid: typeof window.pid === 'number' ? window.pid : undefined,
      });
    }
  }
}

function isSelfWindow(window) {
  if (!window || typeof window !== 'object') {
    return false;
  }
  const known = windowInfoById.get(Number(window.id));
  return isSelfApp(window.app, window.pid ?? known?.pid);
}

function withoutSelfWindows(windows) {
  return Array.isArray(windows) ? windows.filter(window => !isSelfWindow(window)) : windows;
}

async function promptForApp(displayName) {
  let response;
  try {
    response = await fetch(askUserUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mcp-bridge-secret': bridgeSecret,
      },
      body: JSON.stringify({
        questions: [{
          title: text.title,
          subtitle: text.subtitle,
          question: text.question(displayName),
          options: [
            { label: text.allow, description: text.allowDescription },
            { label: text.deny, description: text.denyDescription },
          ],
        }],
      }),
    });
  } catch (error) {
    throw new Error('Computer Use could not show the approval prompt in LobsterAI ('
      + (error instanceof Error ? error.message : String(error))
      + '). Ask the user to make sure LobsterAI is open, then retry.');
  }

  if (!response.ok) {
    throw new Error('Computer Use approval failed with HTTP ' + response.status);
  }
  const body = await response.json();
  const answer = Object.values(body.answers || {})[0];
  return body.behavior === 'allow' && String(answer || '') === text.allow;
}

async function ensureAppApproved(appLabel, details = {}) {
  const label = normalizeAppLabel(appLabel);
  const bundleId = typeof details.bundleId === 'string' ? details.bundleId : undefined;
  const displayName = normalizeAppLabel(details.displayName || label);
  if (isDeniedApp(label, bundleId, displayName)) {
    throw new Error('Computer Use is not allowed to control "' + displayName + '". Password managers, terminals, system authentication dialogs, and similar sensitive apps are blocked for safety.');
  }
  if (isSelfApp(label, details.pid)) {
    throw new Error('Computer Use cannot operate LobsterAI itself. Work with other apps, or ask the user to do this step in LobsterAI.');
  }
  const keys = [appKey(label), bundleId ? appKey(bundleId) : ''].filter(Boolean);
  if (!keys.some(key => approvedApps.has(key))) {
    const allowed = await promptForApp(displayName);
    if (!allowed) {
      throw new Error('The user did not allow Computer Use to operate "' + displayName + '". Do not retry; tell the user and continue without that app.');
    }
  }
  keys.forEach(key => approvedApps.add(key));
  requestMeta[APPROVED_APP_META_KEY] = label;
}

function approvalDetailsForWindow(window) {
  const known = windowInfoById.get(Number(window?.id)) || {};
  return {
    bundleId: window?.bundleId ?? known.bundleId,
    pid: window?.pid ?? known.pid,
  };
}

async function approveWindow(window) {
  await ensureAppApproved(window?.app, approvalDetailsForWindow(window));
}

// Elicitation hook used by clients (Windows) that ask before touching an app.
async function askUserApproval(request) {
  const meta = request?.meta && typeof request.meta === 'object' ? request.meta : {};
  const toolParams = meta.tool_params && typeof meta.tool_params === 'object' ? meta.tool_params : {};
  const app = normalizeAppLabel(toolParams.app);
  const displayName = normalizeAppLabel(
    meta.tool_params_display?.[0]?.value || toolParams.app || request?.message,
  );
  await ensureAppApproved(app, { displayName });
  return { action: 'accept' };
}

globalThis.nodeRepl = {
  requestMeta,
  createElicitation: askUserApproval,
  emitImage: async () => {},
};

let client = new ComputerUseClient({
  helperPath: helperExePath,
  timeoutMs: 30000,
});

async function restartClient() {
  try {
    await client.close();
  } catch {
    // ignore: the next request spawns a fresh helper either way
  }
  client = new ComputerUseClient({
    helperPath: helperExePath,
    timeoutMs: 30000,
  });
}

const STOPPED_BY_USER_MESSAGE = 'Computer Use was stopped by the user with the physical Escape key. Stop your work, do not call further Computer Use tools in this turn, and send a final message noting that the user stopped Computer Use.';

function isComputerUseStoppedError(error) {
  return error instanceof Error && error.message.includes('physical Escape key');
}

function renewHelperTurn() {
  requestMeta.turn_id = createHelperTurnId();
}

function helperPathPart(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function hasHelperInterruptMarker() {
  const markerPath = path.join(
    helperStateHome,
    'cache',
    'computer-use',
    'interrupts',
    helperPathPart(requestMeta.session_id),
    helperPathPart(requestMeta.turn_id),
  );
  return existsSync(markerPath);
}

function assertHelperTurnActive() {
  if (hasHelperInterruptMarker()) {
    throw new Error(STOPPED_BY_USER_MESSAGE);
  }
}

const server = new McpServer({
  name: 'computer-use',
  version: '1.1.0',
});

const WindowSchema = z.object({
  app: z.string().min(1).describe('App name exactly as returned by list_windows or list_apps.'),
  id: z.number().int().nonnegative().describe('Window id returned by list_windows, list_apps, or launch_app.'),
  title: z.string().optional(),
  bundleId: z.string().optional(),
  pid: z.number().int().optional(),
}).describe('A window object returned by list_windows, list_apps, launch_app, or get_window_state. Pass it back unchanged.');
const StateIdSchema = z.string().optional().describe('state_id from the get_window_state call that produced element_index.');
const ElementIndexSchema = z.number().int().nonnegative();
const CoordinateSpaceSchema = z.enum(['screenshot_pixels', 'window_points']);
const DeliverySchema = z.enum(['auto', 'background', 'foreground', 'hid', 'pid'])
  .describe('auto (default): background element actions first, briefly using the real pointer/keyboard only when needed. background: never take over the pointer or activate apps. foreground: always use real input on the activated window.');
const ScreenshotIdSchema = z.string().optional().describe('screenshots[].id from get_window_state; coordinates are pixels in that image.');
const ExpectTextSchema = z.string().optional().describe('Optional text that should appear (or disappear with expect_gone) after the action; the call fails if it is not observed.');
const DEFAULT_INCLUDE_TEXT = IS_MAC;

function clientWindow(window) {
  if (!window || typeof window !== 'object') {
    return window;
  }
  const value = { app: window.app, id: window.id };
  if (window.title) {
    value.title = window.title;
  }
  return value;
}

function forClient(args) {
  const next = { ...args };
  if (next.window) {
    next.window = clientWindow(next.window);
  }
  if (IS_MAC && next.delivery === 'hid') {
    next.delivery = 'foreground';
  } else if (IS_MAC && next.delivery === 'pid') {
    next.delivery = 'background';
  }
  return next;
}

function assertCoordinateContext(args, toolName) {
  if (args.element_index !== undefined) {
    return;
  }
  if (args.screenshotId || args.coordinate_space === 'window_points') {
    return;
  }
  throw new Error(
    toolName + ' coordinate actions require screenshotId from get_window_state. '
    + 'Only pass coordinate_space: "window_points" when you intentionally use window-relative macOS point coordinates. '
    + 'Do not pass screen coordinates.'
  );
}

function textContent(value) {
  return [{ type: 'text', text: value }];
}

function jsonText(value) {
  return JSON.stringify(value, null, 1);
}

function successText(value) {
  return { content: textContent(typeof value === 'string' ? value : jsonText(value)) };
}

function screenshotContent(screenshot) {
  const url = String(screenshot.url || '');
  const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }
  return {
    type: 'image',
    mimeType: match[1],
    data: match[2],
  };
}

function windowSummary(window) {
  const value = {
    app: window?.app,
    id: window?.id,
    title: window?.title,
  };
  if (window?.bundleId) {
    value.bundleId = window.bundleId;
  }
  if (typeof window?.pid === 'number') {
    value.pid = window.pid;
  }
  if (window?.bounds) {
    value.bounds = window.bounds;
  }
  return value;
}

function stateToContent(state) {
  const screenshots = Array.isArray(state.screenshots) ? state.screenshots : [];
  const accessibility = state.accessibility && typeof state.accessibility === 'object'
    ? state.accessibility
    : null;
  const tree = accessibility && typeof accessibility.tree === 'string' ? accessibility.tree : '';
  const documentText = accessibility && typeof accessibility.document_text === 'string'
    ? accessibility.document_text
    : '';
  const summary = {
    state_id: state.state_id,
    window: windowSummary(state.window),
    screenshot_error: typeof state.screenshot_error === 'string' ? state.screenshot_error : undefined,
    screenshots: screenshots.map((screenshot) => ({
      id: screenshot.id,
      zIndex: screenshot.zIndex,
      originX: screenshot.originX,
      originY: screenshot.originY,
      width: screenshot.width,
      height: screenshot.height,
      pointWidth: screenshot.pointWidth,
      pointHeight: screenshot.pointHeight,
      scaleX: screenshot.scaleX,
      scaleY: screenshot.scaleY,
      coordinateSpace: screenshot.coordinateSpace,
    })),
    accessibility: accessibility
      ? {
          error: accessibility.error,
          note: accessibility.note,
          focused_element: truncateText(accessibility.focused_element, 2000),
          selected_text: truncateText(accessibility.selected_text, 4000),
          selected_elements: accessibility.selected_elements,
          element_count: accessibility.element_count,
          truncated: accessibility.truncated,
        }
      : null,
  };
  const content = [{ type: 'text', text: jsonText(summary) }];
  if (tree) {
    content.push({
      type: 'text',
      text: 'Accessibility outline for state_id ' + state.state_id
        + ' ([index] role "label" ...; @x,y = center in screenshot pixels):\n' + truncateText(tree),
    });
  }
  if (documentText && documentText !== tree) {
    content.push({ type: 'text', text: 'document_text:\n' + truncateText(documentText) });
  }
  for (const screenshot of screenshots) {
    const image = screenshotContent(screenshot);
    if (image) {
      content.push(image);
    }
  }
  return content;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function accessibilityTextFromState(state) {
  const accessibility = state?.accessibility && typeof state.accessibility === 'object'
    ? state.accessibility
    : {};
  return [
    state?.window?.title,
    accessibility.document_text,
    accessibility.tree,
    accessibility.focused_element,
    accessibility.selected_text,
  ]
    .filter(value => typeof value === 'string' && value)
    .join('\n');
}

async function waitForText({ window, text: needleText, gone = false, timeout_ms = 3000 }) {
  const needle = String(needleText || '').toLowerCase();
  if (!needle) {
    throw new Error('wait_for_text requires non-empty text');
  }
  // Stay below OpenClaw's default 60s MCP request timeout.
  const timeoutMs = Math.max(100, Math.min(MAX_WAIT_MS, Number(timeout_ms) || 3000));
  const startedAt = Date.now();
  let lastState = null;
  let matched = false;

  while (Date.now() - startedAt <= timeoutMs) {
    assertHelperTurnActive();
    const request = {
      window: clientWindow(window),
      include_screenshot: false,
      include_text: true,
    };
    if (IS_MAC) {
      request.text_limit = 100000;
    }
    lastState = await client.get_window_state(request);
    const haystack = accessibilityTextFromState(lastState).toLowerCase();
    matched = haystack.includes(needle);
    if (gone ? !matched : matched) {
      return {
        satisfied: true,
        timedOut: false,
        gone,
        text: needleText,
        matched,
        elapsed_ms: Date.now() - startedAt,
        state_id: lastState?.state_id,
        window: windowSummary(lastState?.window),
      };
    }
    await sleep(200);
  }

  return {
    satisfied: false,
    timedOut: true,
    gone,
    text: needleText,
    matched,
    elapsed_ms: Date.now() - startedAt,
    state_id: lastState?.state_id,
    window: windowSummary(lastState?.window),
  };
}

async function applyExpectedText(args, actionResult) {
  if (typeof args.expect_text !== 'string' || !args.expect_text.trim()) {
    return actionResult;
  }
  const expectation = await waitForText({
    window: args.window,
    text: args.expect_text,
    gone: Boolean(args.expect_gone),
    timeout_ms: args.expect_timeout_ms,
  });
  if (!expectation.satisfied) {
    throw new Error(
      'Computer Use action was delivered but expected text was not '
      + (expectation.gone ? 'gone' : 'observed')
      + ' within ' + String(args.expect_timeout_ms || 3000) + 'ms: '
      + args.expect_text,
    );
  }
  return {
    action: actionResult,
    expectation,
  };
}

function permissionGuidance(status) {
  if (!IS_MAC || !status || typeof status !== 'object') {
    return status;
  }
  const missing = Array.isArray(status.missing)
    ? status.missing
    : [status.accessibility === false && 'accessibility', status.screenCapture === false && 'screenCapture'].filter(Boolean);
  if (missing.length === 0) {
    return { ...status, ready: true };
  }
  const panes = missing.map(name => name === 'accessibility' ? 'Accessibility' : 'Screen Recording').join(' and ');
  return {
    ...status,
    ready: false,
    how_to_fix: 'Ask the user to open System Settings > Privacy & Security > ' + panes
      + ' and turn on ' + selfAppName + ' (call request_permissions to open the pane). '
      + 'Then retry; if Screen Recording still reports missing, the user may need to quit and reopen ' + selfAppName + '.',
  };
}

// Tools that read or operate an app's window. On macOS the bridge asks for per-app
// approval itself; the Windows client asks through nodeRepl.createElicitation.
const APPROVAL_TOOL_NAMES = new Set([
  'get_window_state', 'activate_window', 'click', 'press_key', 'type_text',
  'scroll', 'drag', 'set_value', 'perform_secondary_action', 'wait_for_text',
]);

function registerTool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      assertHelperTurnActive();
      const input = args || {};
      if (IS_MAC && APPROVAL_TOOL_NAMES.has(name) && input.window) {
        await approveWindow(input.window);
      }
      return await handler(input);
    } catch (error) {
      const result = {
        content: textContent(error instanceof Error ? error.message : String(error)),
        isError: true,
      };
      if (isComputerUseStoppedError(error)) {
        renewHelperTurn();
      }
      return result;
    }
  });
}

registerTool('list_windows', 'List open app windows Computer Use can target, front to back. Off-screen (minimized or other Space) windows are marked onScreen:false.', {}, async () => {
  const windows = withoutSelfWindows(await client.list_windows());
  rememberWindows(windows);
  return successText(windows);
});

registerTool('check_permissions', 'Check the operating system permissions Computer Use needs (macOS: Accessibility and Screen Recording for LobsterAI).', {}, async () => {
  const status = await client.check_permissions();
  const guided = permissionGuidance(status);
  if (guided && guided.ready === false) {
    // A fresh helper picks up permissions the user grants after this call.
    await restartClient();
  }
  return successText(guided);
});

if (typeof client.request_permissions === 'function') {
  registerTool('request_permissions', 'Show the macOS permission prompts for LobsterAI and open the matching System Settings pane for any missing Accessibility or Screen Recording permission. Tell the user which switch to turn on, then wait for them.', {
    open_settings: z.boolean().optional().default(true).describe('Open System Settings to the missing permission pane.'),
  }, async (args) => {
    const status = await client.request_permissions({ open_settings: args.open_settings !== false });
    await restartClient();
    return successText(permissionGuidance(status));
  });
}

registerTool('list_apps', IS_MAC
  ? 'List running apps with their windows, plus installed apps (name and bundleId) that can be opened with launch_app.'
  : 'List installed and recently used desktop apps, including open windows.', IS_MAC
  ? { include_installed: z.boolean().optional().default(true).describe('Include installed apps that are not running.') }
  : {}, async (args) => {
  const result = IS_MAC ? await client.list_apps({ include_installed: args.include_installed !== false }) : await client.list_apps();
  if (result && typeof result === 'object' && Array.isArray(result.running)) {
    result.running = result.running.filter(app => !isSelfApp(app.app, app.pid));
    for (const app of result.running) {
      rememberWindows((app.windows || []).map(window => ({ ...window, bundleId: app.bundleId, pid: app.pid })));
    }
  } else if (Array.isArray(result)) {
    for (const app of result) {
      rememberWindows(app?.windows);
    }
  }
  return successText(result);
});

registerTool('launch_app', IS_MAC
  ? 'Open an app, or bring it forward if it is already running, and return its windows. Accepts an English or localized app name (for example "Notes" or "备忘录"), a bundle id, or an .app path.'
  : 'Launch a desktop app by id, name, bundle path, or executable path.', IS_MAC
  ? {
      app: z.string().min(1).describe('App name, bundle id, or .app path.'),
      activate: z.boolean().optional().describe('Bring the app to the front (default true). Pass false to open it in the background.'),
      wait_ms: z.number().int().nonnegative().optional().describe('How long to wait for the first window (default 8000).'),
    }
  : { app: z.string().min(1) }, async (args) => {
  if (IS_MAC) {
    // Resolve first so the prompt names the real app and unknown names fail without a prompt.
    const resolved = typeof client.resolve_app === 'function'
      ? await client.resolve_app({ app: args.app })
      : null;
    await ensureAppApproved(resolved?.app || args.app, {
      bundleId: resolved?.bundleId,
      displayName: resolved?.app || args.app,
      pid: resolved?.pid,
    });
  }
  const result = await client.launch_app(args);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    if (result.app) {
      approvedApps.add(appKey(result.app));
    }
    if (result.bundleId) {
      approvedApps.add(appKey(result.bundleId));
    }
    rememberWindows(result.windows);
    return successText(result);
  }
  return successText('App launch requested. Call list_windows to find its window.');
});

registerTool('get_window', 'Refresh a window handle returned by list_windows or list_apps.', {
  window: WindowSchema,
}, async ({ window }) => {
  const result = await client.get_window(clientWindow(window));
  rememberWindows([result]);
  return successText(result);
});

registerTool('get_window_state', 'Capture a window: a screenshot (image) and an accessibility outline whose [index] entries can be passed as element_index together with state_id. Call it again after the UI changes.', {
  window: WindowSchema,
  include_screenshot: z.boolean().optional().default(true),
  include_text: z.boolean().optional().default(DEFAULT_INCLUDE_TEXT).describe('Include the accessibility outline, focused element, and readable text.'),
  max_nodes: z.number().int().positive().optional().describe('Maximum outline elements (default 350).'),
  text_limit: z.number().int().positive().optional().describe('Maximum characters of document_text (default 6000).'),
  state_id: z.string().optional(),
}, async ({ window, include_screenshot = true, include_text = DEFAULT_INCLUDE_TEXT, max_nodes, text_limit, state_id }) => {
  const request = {
    window: clientWindow(window),
    include_screenshot,
    include_text,
    state_id,
  };
  if (max_nodes !== undefined) {
    request.max_nodes = max_nodes;
  }
  if (text_limit !== undefined) {
    request.text_limit = text_limit;
  }
  const state = await client.get_window_state(request);
  rememberWindows([state?.window]);
  return { content: stateToContent(state) };
});

registerTool('activate_window', 'Bring a window to the front (restores minimized windows). Most actions do not need this.', {
  window: WindowSchema,
}, async ({ window }) => {
  const result = await client.activate_window({ window: clientWindow(window) });
  return successText(result && typeof result === 'object' ? result : 'Window activated.');
});

registerTool('click', 'Click an element (element_index + state_id: presses buttons/links/menu items/checkboxes, focuses text fields, selects rows - in the background), or click pixel coordinates from a screenshot (x, y + screenshotId).', {
  window: WindowSchema,
  state_id: StateIdSchema,
  element_index: ElementIndexSchema.optional().describe('Element [index] from the latest get_window_state outline.'),
  x: z.number().optional(),
  y: z.number().optional(),
  screenshotId: ScreenshotIdSchema,
  coordinate_space: CoordinateSpaceSchema.optional(),
  delivery: DeliverySchema.optional(),
  mouse_button: z.enum(['left', 'right', 'middle', 'l', 'r', 'm']).optional(),
  click_count: z.number().int().positive().optional().describe('2 for double-click.'),
  expect_text: ExpectTextSchema,
  expect_gone: z.boolean().optional(),
  expect_timeout_ms: z.number().int().positive().optional(),
}, async (args) => {
  if (args.x !== undefined || args.y !== undefined) {
    assertCoordinateContext(args, 'click');
  }
  const result = await client.click(forClient(args));
  return successText(await applyExpectedText(args, result ?? 'Click completed.'));
});

registerTool('press_key', 'Press a key or chord in a window, e.g. "return", "tab", "escape", "delete", "down", "pageup", "f5", "cmd+a", "cmd+shift+t", "alt+left". Menu shortcuts (cmd+...) bring the app to the front on macOS.', {
  window: WindowSchema,
  key: z.string().min(1).describe('Key name, optionally with modifiers joined by +: cmd, ctrl, alt/option, shift, fn.'),
  repeat: z.number().int().positive().max(50).optional().describe('Press the key this many times.'),
  delivery: DeliverySchema.optional(),
  expect_text: ExpectTextSchema,
  expect_gone: z.boolean().optional(),
  expect_timeout_ms: z.number().int().positive().optional(),
}, async (args) => {
  const result = await client.press_key(forClient(args));
  return successText(await applyExpectedText(args, result ?? 'Key press completed.'));
});

registerTool('type_text', 'Type literal text into the focused control of a window (click the field first to focus it). Newlines press Return. Works in the background.', {
  window: WindowSchema,
  text: z.string(),
  delivery: DeliverySchema.optional(),
  expect_text: ExpectTextSchema,
  expect_gone: z.boolean().optional(),
  expect_timeout_ms: z.number().int().positive().optional(),
}, async (args) => {
  const result = await client.type_text(forClient(args));
  return successText(await applyExpectedText(args, result ?? 'Text entry completed.'));
});

registerTool('scroll', 'Scroll a list or view by pixels (positive scrollY scrolls down, positive scrollX scrolls right). Target it with element_index + state_id, or with x, y + screenshotId.', {
  window: WindowSchema,
  state_id: StateIdSchema,
  element_index: ElementIndexSchema.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  scrollX: z.number().optional().default(0),
  scrollY: z.number().optional().default(0),
  screenshotId: ScreenshotIdSchema,
  coordinate_space: CoordinateSpaceSchema.optional(),
  delivery: DeliverySchema.optional(),
}, async (args) => {
  if (args.element_index === undefined && (args.x === undefined || args.y === undefined)) {
    throw new Error('scroll needs element_index (+ state_id) or x and y (+ screenshotId).');
  }
  assertCoordinateContext(args, 'scroll');
  const result = await client.scroll(forClient(args));
  return successText(result && typeof result === 'object' ? result : 'Scroll completed.');
});

registerTool('drag', 'Drag with the mouse between screenshot pixel coordinates (from_x, from_y) -> (to_x, to_y) of the same screenshot. Uses the real pointer briefly on macOS.', {
  window: WindowSchema,
  from_x: z.number(),
  from_y: z.number(),
  to_x: z.number(),
  to_y: z.number(),
  screenshotId: ScreenshotIdSchema,
  coordinate_space: CoordinateSpaceSchema.optional(),
  delivery: DeliverySchema.optional(),
}, async (args) => {
  assertCoordinateContext(args, 'drag');
  const result = await client.drag(forClient(args));
  return successText(result && typeof result === 'object' ? result : 'Drag completed.');
});

registerTool('set_value', 'Replace the value of an editable element (text field, slider, checkbox, ...) by element_index + state_id, in the background.', {
  window: WindowSchema,
  state_id: StateIdSchema,
  element_index: ElementIndexSchema,
  value: z.string(),
  expect_text: ExpectTextSchema,
  expect_gone: z.boolean().optional(),
  expect_timeout_ms: z.number().int().positive().optional(),
}, async (args) => {
  const result = await client.set_value(forClient(args));
  return successText(await applyExpectedText(args, result ?? 'Value set completed.'));
});

registerTool('perform_secondary_action', 'Invoke an accessibility action on an element, e.g. "AXShowMenu", "AXIncrement", "AXDecrement", "AXConfirm", "AXCancel", "AXRaise". The error lists the actions an element supports.', {
  window: WindowSchema,
  state_id: StateIdSchema,
  element_index: ElementIndexSchema,
  action: z.string().min(1),
}, async (args) => {
  return successText(await client.perform_secondary_action(forClient(args)) ?? 'Secondary action completed.');
});

registerTool('wait_for_text', 'Wait until text appears in (or, with gone: true, disappears from) a window\'s accessibility text or title.', {
  window: WindowSchema,
  text: z.string().min(1),
  gone: z.boolean().optional().default(false),
  timeout_ms: z.number().int().positive().optional().describe('Default 3000, maximum 45000.'),
}, async (args) => {
  const result = await waitForText(args);
  if (!result.satisfied) {
    throw new Error(
      'Timed out waiting for text to '
      + (result.gone ? 'disappear' : 'appear')
      + ': ' + args.text,
    );
  }
  return successText(result);
});

process.once('SIGINT', () => {
  void client.close().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void client.close().finally(() => process.exit(0));
});

await server.connect(new StdioServerTransport());
`;
