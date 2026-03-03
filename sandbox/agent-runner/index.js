#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { setTimeout: sleep } = require('timers/promises');
const { z } = require('zod');

const IPC_ROOT = '/workspace/ipc';
const LOG_PATH = '/tmp/agentd.log';
const REQUESTS_DIR = path.join(IPC_ROOT, 'requests');
const RESPONSES_DIR = path.join(IPC_ROOT, 'responses');
const STREAMS_DIR = path.join(IPC_ROOT, 'streams');
const HEARTBEAT_PATH = path.join(IPC_ROOT, 'heartbeat');

const POLL_INTERVAL_MS = 300;
const HEARTBEAT_INTERVAL_MS = 5000;
const CONSOLE_PATHS = ['/dev/console', '/dev/ttyAMA0', '/dev/ttyS0'];

// Virtio-serial device paths (checked in order)
const SERIAL_DEVICE_PATHS = ['/dev/virtio-ports/ipc.0', '/dev/vport0p1'];

// ---------------------------------------------------------------------------
// File sync constants (guest -> host file transfer over virtio-serial)
// ---------------------------------------------------------------------------
const WORKSPACE_PROJECT = '/workspace/project';
const FILE_SYNC_CHUNK_SIZE = 512 * 1024;        // 512 KB per chunk
const FILE_SYNC_MAX_SIZE = 100 * 1024 * 1024;   // 100 MB max file size
const FILE_SYNC_INTERVAL_MS = 1000;              // scan interval
const FILE_SYNC_IGNORE = ['.git', 'node_modules', '__pycache__', '.DS_Store', 'Thumbs.db'];
const TOOL_PATH_SEARCH_IGNORE = new Set(['.git', 'node_modules', '.cowork-temp', '__pycache__']);
const TMP_WORKSPACE_PREFIX = '/tmp/workspace/';
const TMP_WORKSPACE_SKILLS_PREFIX = '/tmp/workspace/skills/';
const SKILLS_MARKER = '/skills/';
const PERMISSION_RESPONSE_TIMEOUT_MS = 60_000;
const DELETE_TOOL_NAMES = new Set(['delete', 'remove', 'unlink', 'rmdir']);
const BLOCKED_BUILTIN_WEB_TOOLS = new Set(['websearch', 'webfetch']);
const TOOL_INPUT_PATH_KEY_RE = /(^|_)(path|paths|file|files|dir|dirs|directory|directories|cwd|target|targets|source|sources|output|outputs|dest|destination)$/i;
const DELETE_COMMAND_RE = /\b(rm|rmdir|unlink|del|erase|remove-item)\b/i;
const FIND_DELETE_COMMAND_RE = /\bfind\b[\s\S]*\s-delete\b/i;
const GIT_CLEAN_COMMAND_RE = /\bgit\s+clean\b/i;
const SAFETY_APPROVAL_ALLOW_OPTION = '允许本次操作';
const SAFETY_APPROVAL_DENY_OPTION = '拒绝本次操作';
const MAX_POLICY_PATHS_IN_PROMPT = 3;
const PATH_SENSITIVE_TOOL_NAMES = new Set([
  'read',
  'write',
  'edit',
  'multiedit',
  'ls',
  'glob',
  'grep',
  'delete',
  'remove',
  'move',
  'copy',
  'rename',
]);

// ---------------------------------------------------------------------------
// IPC mode: 'file' (9p shared fs) or 'serial' (virtio-serial on Windows)
// ---------------------------------------------------------------------------
let ipcMode = 'file';
let serialFd = null;

function appendConsole(message) {
  const line = `[agentd] ${message}\n`;
  for (const consolePath of CONSOLE_PATHS) {
    try {
      fs.appendFileSync(consolePath, line);
      return;
    } catch (error) {
      // Try next console path.
    }
  }
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    console.error('Failed to ensure directory:', dirPath, error);
  }
}

function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (error) {
    // Best-effort logging.
  }
  appendConsole(message);
  if (ipcMode === 'file' && isMounted(IPC_ROOT)) {
    try {
      fs.appendFileSync(path.join(IPC_ROOT, 'agentd.log'), line);
    } catch (error) {
      // Best-effort logging.
    }
  }
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function getClaudeSdkVersion() {
  try {
    return require('@anthropic-ai/claude-agent-sdk/package.json')?.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function buildFallbackMcpServerFactory() {
  try {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    if (typeof McpServer !== 'function') {
      return null;
    }
    return (options) => {
      const server = new McpServer(
        {
          name: options.name,
          version: options.version || '1.0.0',
        },
        {
          capabilities: {
            tools: options.tools ? {} : undefined,
          },
        }
      );
      if (Array.isArray(options.tools)) {
        for (const toolDef of options.tools) {
          server.tool(toolDef.name, toolDef.description, toolDef.inputSchema, toolDef.handler);
        }
      }
      return {
        type: 'sdk',
        name: options.name,
        instance: server,
      };
    };
  } catch {
    return null;
  }
}

function fileExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function shouldTryUploadFallback(filePath) {
  if (typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.startsWith('/tmp/')) return false;
  return !fileExists(filePath);
}

function isDirectory(targetPath) {
  if (!targetPath || !path.isAbsolute(targetPath)) return false;
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function buildPathSearchRoots(cwd, requestEnv) {
  const roots = new Set();
  const pushRoot = (targetPath) => {
    if (!isDirectory(targetPath)) return;
    roots.add(path.resolve(targetPath));
  };

  pushRoot(cwd);
  pushRoot(WORKSPACE_PROJECT);
  pushRoot('/workspace');
  if (requestEnv && typeof requestEnv === 'object') {
    if (typeof requestEnv.SKILLS_ROOT === 'string') {
      pushRoot(requestEnv.SKILLS_ROOT);
    }
    if (typeof requestEnv.LOBSTERAI_SKILLS_ROOT === 'string') {
      pushRoot(requestEnv.LOBSTERAI_SKILLS_ROOT);
    }
  }

  return Array.from(roots);
}

function normalizePathString(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  let normalized = trimmed.replace(/\\/g, '/');
  if (/^file:\/\//i.test(normalized)) {
    try {
      normalized = decodeURIComponent(normalized.replace(/^file:\/\//i, ''));
      if (/^\/[A-Za-z]:/.test(normalized)) {
        normalized = normalized.slice(1);
      }
    } catch {
      return null;
    }
  }
  return normalized;
}

function mapHostWorkspacePathToGuest(filePath, cwd, hostWorkspaceRoot) {
  if (!filePath || !cwd || !hostWorkspaceRoot) return null;
  const normalizedPath = normalizePathString(filePath);
  const normalizedHostRoot = normalizePathString(hostWorkspaceRoot);
  if (!normalizedPath || !normalizedHostRoot) return null;

  const hostRoot = normalizedHostRoot.replace(/\/+$/, '');
  if (!hostRoot) return null;

  if (normalizedPath !== hostRoot && !normalizedPath.startsWith(`${hostRoot}/`)) {
    return null;
  }

  const relative = normalizedPath.slice(hostRoot.length).replace(/^\/+/, '');
  const guestRoot = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!guestRoot) return null;
  if (!relative) return guestRoot;
  return path.posix.join(guestRoot, relative);
}

function findFilesByBaseName(rootDir, baseName, maxMatches = 2) {
  if (!rootDir || !baseName) return [];
  const matches = [];
  const queue = [rootDir];

  while (queue.length > 0 && matches.length < maxMatches) {
    const current = queue.shift();
    if (!current) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (matches.length >= maxMatches) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (TOOL_PATH_SEARCH_IGNORE.has(entry.name)) continue;
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === baseName) {
        matches.push(fullPath);
      }
    }
  }

  return matches;
}

function resolveFallbackPath(filePath, searchRoots, requestEnv) {
  if (!shouldTryUploadFallback(filePath)) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedLower = normalized.toLowerCase();

  if (normalized.startsWith(TMP_WORKSPACE_PREFIX)) {
    const workspaceCandidate = path.posix.join('/workspace', normalized.slice(TMP_WORKSPACE_PREFIX.length));
    if (fileExists(workspaceCandidate)) {
      return workspaceCandidate;
    }
  }

  if (normalizedLower.startsWith(TMP_WORKSPACE_SKILLS_PREFIX) && requestEnv && typeof requestEnv === 'object') {
    const skillsRoot = typeof requestEnv.SKILLS_ROOT === 'string'
      ? requestEnv.SKILLS_ROOT
      : typeof requestEnv.LOBSTERAI_SKILLS_ROOT === 'string'
        ? requestEnv.LOBSTERAI_SKILLS_ROOT
        : null;
    if (skillsRoot && path.isAbsolute(skillsRoot)) {
      const skillsCandidate = path.join(skillsRoot, normalized.slice(TMP_WORKSPACE_SKILLS_PREFIX.length));
      if (fileExists(skillsCandidate)) {
        return skillsCandidate;
      }
    }
  }

  if (!Array.isArray(searchRoots) || searchRoots.length === 0) return null;

  const baseName = path.basename(filePath);
  if (!baseName) return null;

  for (const root of searchRoots) {
    const directPath = path.join(root, baseName);
    if (fileExists(directPath)) {
      return directPath;
    }
  }

  const matches = [];
  for (const root of searchRoots) {
    const remaining = 2 - matches.length;
    if (remaining <= 0) break;
    const rootMatches = findFilesByBaseName(root, baseName, remaining);
    for (const match of rootMatches) {
      if (!matches.includes(match)) {
        matches.push(match);
      }
    }
  }

  if (matches.length === 1 && fileExists(matches[0])) {
    return matches[0];
  }

  return null;
}

function resolveSkillsRootFromEnv(requestEnv) {
  if (!requestEnv || typeof requestEnv !== 'object') return null;
  const skillsRoot = typeof requestEnv.SKILLS_ROOT === 'string'
    ? requestEnv.SKILLS_ROOT
    : typeof requestEnv.LOBSTERAI_SKILLS_ROOT === 'string'
      ? requestEnv.LOBSTERAI_SKILLS_ROOT
      : null;
  if (!skillsRoot || !path.isAbsolute(skillsRoot)) return null;
  return skillsRoot;
}

function resolveHostSkillPath(filePath, requestEnv) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const skillsRoot = resolveSkillsRootFromEnv(requestEnv);
  if (!skillsRoot) return null;

  const normalized = filePath.replace(/\\/g, '/');
  const markerIndex = normalized.toLowerCase().lastIndexOf(SKILLS_MARKER);
  const relative = markerIndex < 0
    ? ''
    : normalized.slice(markerIndex + SKILLS_MARKER.length).replace(/^\/+/, '');
  if (!relative) return null;

  const candidate = path.join(skillsRoot, ...relative.split('/'));
  if (!fileExists(candidate)) return null;
  return candidate;
}

function normalizeToolInputPaths(toolName, toolInput, cwd, requestEnv, hostWorkspaceRoot) {
  if (!toolInput || typeof toolInput !== 'object') return toolInput;

  const input = { ...toolInput };
  const searchRoots = buildPathSearchRoots(cwd, requestEnv);
  const rewriteField = (field) => {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim()) return;
    const mappedWorkspacePath = mapHostWorkspacePathToGuest(value, cwd, hostWorkspaceRoot);
    if (mappedWorkspacePath && mappedWorkspacePath !== value) {
      appendLog(`Rewrote ${toolName}.${field} host workspace path: ${value} -> ${mappedWorkspacePath}`);
      input[field] = mappedWorkspacePath;
      return;
    }
    const skillPath = resolveHostSkillPath(value, requestEnv);
    if (skillPath && skillPath !== value) {
      appendLog(`Rewrote ${toolName}.${field} from host skill path: ${value} -> ${skillPath}`);
      input[field] = skillPath;
      return;
    }
    const fallback = resolveFallbackPath(value, searchRoots, requestEnv);
    if (!fallback) return;
    appendLog(`Rewrote ${toolName}.${field}: ${value} -> ${fallback}`);
    input[field] = fallback;
  };

  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    rewriteField('file_path');
  }

  return input;
}

function isPathWithin(basePath, targetPath) {
  const normalizedBase = path.resolve(basePath);
  const normalizedTarget = path.resolve(targetPath);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function extractToolCommand(toolInput) {
  const commandLike = toolInput.command ?? toolInput.cmd ?? toolInput.script;
  return typeof commandLike === 'string' ? commandLike : '';
}

function tokenizeCommand(command) {
  const matches = command.match(/"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g);
  return matches || [];
}

function extractPathLikeTokensFromCommand(command) {
  if (!command.trim()) return [];
  const tokens = tokenizeCommand(command);
  const pathTokens = [];
  for (const token of tokens) {
    let value = token.trim();
    if (!value) continue;
    value = value.replace(/^['"`]+|['"`]+$/g, '').replace(/[;,]+$/g, '');
    if (!value || value.startsWith('-')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) continue;
    if (/^[a-zA-Z]+:\/\//.test(value)) continue;
    if (value.startsWith('$') || value.startsWith('%')) continue;

    const hasPathHint = (
      value === '.'
      || value === '..'
      || value.startsWith('/')
      || value.startsWith('./')
      || value.startsWith('../')
      || value.startsWith('~/')
      || value.includes('/')
      || value.includes('\\')
      || /^[A-Za-z]:[\\/]/.test(value)
    );
    if (!hasPathHint) continue;
    pathTokens.push(value);
  }
  return pathTokens;
}

function isLikelyPathString(value) {
  if (!value || value.length > 1024) return false;
  if (value.includes('\n')) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[a-zA-Z]+:\/\//.test(trimmed) && !/^file:\/\//i.test(trimmed)) {
    return false;
  }
  return (
    /^file:\/\//i.test(trimmed)
    || trimmed === '.'
    || trimmed === '..'
    || trimmed.startsWith('/')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || trimmed.startsWith('~/')
    || trimmed.includes('/')
    || trimmed.includes('\\')
    || /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}

function collectPathCandidatesFromInput(toolName, value, keyHint, outSet) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (keyHint && TOOL_INPUT_PATH_KEY_RE.test(keyHint)) {
      outSet.add(trimmed);
      return;
    }
    const normalizedToolName = String(toolName || '').toLowerCase();
    if (PATH_SENSITIVE_TOOL_NAMES.has(normalizedToolName) && isLikelyPathString(trimmed)) {
      outSet.add(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathCandidatesFromInput(toolName, item, keyHint, outSet);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    collectPathCandidatesFromInput(toolName, child, key, outSet);
  }
}

function resolvePathCandidate(candidate, cwd) {
  if (!candidate) return null;
  const trimmed = String(candidate).trim();
  if (!trimmed) return null;

  let normalized = trimmed
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[;,]+$/g, '')
    .trim();
  if (!normalized || normalized.startsWith('-')) return null;
  if (/^file:\/\//i.test(normalized)) {
    try {
      normalized = decodeURIComponent(normalized.replace(/^file:\/\//i, ''));
      if (/^\/[A-Za-z]:/.test(normalized)) {
        normalized = normalized.slice(1);
      }
    } catch {
      return null;
    }
  } else if (/^[a-zA-Z]+:\/\//.test(normalized)) {
    return null;
  }
  if (normalized.startsWith('$') || normalized.startsWith('%')) return null;

  if (normalized.startsWith('~/')) {
    const home = process.env.HOME || '/root';
    normalized = path.join(home, normalized.slice(2));
  }

  const resolved = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(cwd, normalized);

  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function getOutsideWorkspacePaths(toolName, toolInput, cwd, workspaceRoot, requestEnv) {
  const candidates = new Set();
  collectPathCandidatesFromInput(toolName, toolInput, null, candidates);
  const skillsRoot = resolveSkillsRootFromEnv(requestEnv);

  if (toolName === 'Bash') {
    const command = extractToolCommand(toolInput);
    for (const token of extractPathLikeTokensFromCommand(command)) {
      candidates.add(token);
    }
  }

  if (candidates.size === 0) return [];

  const outside = new Set();
  for (const candidate of candidates) {
    const resolved = resolvePathCandidate(candidate, cwd);
    if (!resolved) continue;
    const inWorkspace = isPathWithin(workspaceRoot, resolved);
    const inSkillsRoot = Boolean(skillsRoot && isPathWithin(skillsRoot, resolved));
    if (!inWorkspace && !inSkillsRoot) {
      outside.add(resolved);
    }
  }
  return Array.from(outside);
}

function isDeleteOperation(toolName, toolInput) {
  const normalizedName = String(toolName || '').toLowerCase();
  if (DELETE_TOOL_NAMES.has(normalizedName)) {
    return true;
  }

  if (normalizedName !== 'bash') {
    return false;
  }

  const command = extractToolCommand(toolInput);
  if (!command.trim()) {
    return false;
  }
  return DELETE_COMMAND_RE.test(command)
    || FIND_DELETE_COMMAND_RE.test(command)
    || GIT_CLEAN_COMMAND_RE.test(command);
}

function isBlockedBuiltinWebTool(toolName) {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) return false;

  const compact = normalized.replace(/[^a-z0-9]/g, '');
  if (BLOCKED_BUILTIN_WEB_TOOLS.has(compact)) {
    return true;
  }

  const segments = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (segments.length >= 2) {
    const tail = `${segments[segments.length - 2]}${segments[segments.length - 1]}`;
    if (BLOCKED_BUILTIN_WEB_TOOLS.has(tail)) {
      return true;
    }
  }

  return false;
}

function truncateCommandPreview(command, maxLength = 120) {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

function buildSafetyQuestionInput(question, requestedToolName, requestedToolInput) {
  return {
    questions: [
      {
        header: '安全确认',
        question,
        options: [
          {
            label: SAFETY_APPROVAL_ALLOW_OPTION,
            description: '仅允许当前这一次操作继续执行。',
          },
          {
            label: SAFETY_APPROVAL_DENY_OPTION,
            description: '拒绝当前操作，保持文件安全边界。',
          },
        ],
      },
    ],
    answers: {},
    context: {
      requestedToolName,
      requestedToolInput,
    },
  };
}

function isSafetyApproval(result, question) {
  if (!result || result.behavior === 'deny') {
    return false;
  }
  if (!result.updatedInput || typeof result.updatedInput !== 'object') {
    return false;
  }
  const answers = result.updatedInput.answers;
  if (!answers || typeof answers !== 'object') {
    return false;
  }
  const rawAnswer = answers[question];
  if (typeof rawAnswer !== 'string') {
    return false;
  }
  return rawAnswer
    .split('|||')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(SAFETY_APPROVAL_ALLOW_OPTION);
}

async function requestSafetyApproval({
  emit,
  signal,
  question,
  requestedToolName,
  requestedToolInput,
}) {
  const permissionRequestId = randomUUID();
  const questionInput = buildSafetyQuestionInput(question, requestedToolName, requestedToolInput);
  emit({
    type: 'permission_request',
    requestId: permissionRequestId,
    toolName: 'AskUserQuestion',
    toolInput: questionInput,
  });

  const result = await waitForPermissionResponse(permissionRequestId, signal);
  if (signal?.aborted) {
    return false;
  }
  return isSafetyApproval(result, question);
}

async function enforceToolSafetyPolicy({
  emit,
  signal,
  toolName,
  toolInput,
  cwd,
  workspaceRoot,
  requestEnv,
}) {
  if (isDeleteOperation(toolName, toolInput)) {
    const commandPreview = toolName === 'Bash'
      ? truncateCommandPreview(extractToolCommand(toolInput))
      : '';
    const deleteDetail = commandPreview ? ` 命令: ${commandPreview}` : '';
    const deleteQuestion = `工具 "${toolName}" 将执行删除操作。根据安全策略，删除必须人工确认。是否允许本次操作？${deleteDetail}`;
    const approved = await requestSafetyApproval({
      emit,
      signal,
      question: deleteQuestion,
      requestedToolName: toolName,
      requestedToolInput: toolInput,
    });
    if (!approved) {
      return { behavior: 'deny', message: 'Delete operation denied by user.' };
    }
  }

  const outsidePaths = getOutsideWorkspacePaths(toolName, toolInput, cwd, workspaceRoot, requestEnv);
  if (outsidePaths.length === 0) {
    return null;
  }

  const preview = outsidePaths.slice(0, MAX_POLICY_PATHS_IN_PROMPT).join('、');
  const suffix = outsidePaths.length > MAX_POLICY_PATHS_IN_PROMPT
    ? ` 等 ${outsidePaths.length} 个路径`
    : '';
  const question = `工具 "${toolName}" 正在访问所选文件夹外的路径（${preview}${suffix}）。是否允许本次越界操作？`;
  const approved = await requestSafetyApproval({
    emit,
    signal,
    question,
    requestedToolName: toolName,
    requestedToolInput: toolInput,
  });
  if (!approved) {
    return { behavior: 'deny', message: 'Operation outside selected folder denied by user.' };
  }

  return null;
}

function isMounted(targetPath) {
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    return mounts.split('\n').some((line) => {
      const parts = line.split(' ');
      return parts.length >= 2 && parts[1] === targetPath;
    });
  } catch (error) {
    console.error('Failed to read /proc/mounts:', error);
    return false;
  }
}

function isPathWritable(targetPath) {
  if (!targetPath || !path.isAbsolute(targetPath)) return false;
  const probePath = path.join(
    targetPath,
    `.lobsterai-mount-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  try {
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
    return true;
  } catch (error) {
    appendLog(`Workspace write probe failed at ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
    try {
      if (fs.existsSync(probePath)) {
        fs.unlinkSync(probePath);
      }
    } catch {
      // Best effort cleanup.
    }
    return false;
  }
}

function ensureMount(tag, guestPath) {
  const mountState = {
    tag,
    guestPath,
    mounted: false,
    error: null,
  };
  if (!tag || !guestPath) {
    mountState.error = 'Invalid mount config';
    return mountState;
  }
  ensureDir(guestPath);
  if (isMounted(guestPath)) {
    appendLog(`${guestPath} already mounted`);
    mountState.mounted = true;
    return mountState;
  }

  tryModprobe(['9p', '9pnet', '9pnet_virtio']);

  appendLog(`Mounting ${tag} -> ${guestPath}`);
  const mountResult = spawnSync(
    'mount',
    ['-t', '9p', '-o', 'trans=virtio,version=9p2000.L,msize=65536', tag, guestPath],
    { stdio: 'pipe' }
  );
  if (mountResult.status !== 0) {
    const message = mountResult.stderr?.toString() || mountResult.stdout?.toString() || 'Unknown mount error';
    console.error(`Failed to mount ${tag} -> ${guestPath}:`, message.trim());
    appendLog(`Failed to mount ${tag} -> ${guestPath}: ${message.trim()}`);
    mountState.error = message.trim();
  } else {
    const mounted = isMounted(guestPath);
    if (!mounted) {
      const message = `Mount command for ${tag} reported success but ${guestPath} is not mounted`;
      appendLog(message);
      mountState.error = message;
    } else {
      appendLog(`Successfully mounted ${tag} -> ${guestPath}`);
      mountState.mounted = true;
    }
  }
  return mountState;
}

function tryModprobe(modules) {
  if (!Array.isArray(modules)) return;
  for (const name of modules) {
    if (!name) continue;
    const result = spawnSync('modprobe', [name], { stdio: 'ignore' });
    if (result.status === 0) {
      appendLog(`Loaded kernel module: ${name}`);
    }
  }
}

function ensureMounts(mounts) {
  const results = [];
  if (!mounts || typeof mounts !== 'object') return results;
  for (const mount of Object.values(mounts)) {
    if (!mount || typeof mount !== 'object') continue;
    const tag = mount.tag;
    const guestPath = mount.guestPath;
    if (typeof tag === 'string' && typeof guestPath === 'string') {
      results.push(ensureMount(tag, guestPath));
    }
  }
  return results;
}

function validateWorkspaceMount(requestMounts, mountResults, requestCwd, workspaceRoot) {
  if (ipcMode !== 'file') return;
  if (!requestMounts || typeof requestMounts !== 'object') return;

  const mounts = Object.values(requestMounts)
    .filter((mount) => mount && typeof mount === 'object')
    .map((mount) => ({
      tag: typeof mount.tag === 'string' ? mount.tag : '',
      guestPath: typeof mount.guestPath === 'string' ? mount.guestPath : '',
    }))
    .filter((mount) => mount.tag && mount.guestPath);

  if (mounts.length === 0) return;

  const workspaceMount = mounts.find((mount) =>
    mount.tag === 'work' || mount.guestPath === workspaceRoot || mount.guestPath === requestCwd
  );
  if (!workspaceMount) return;

  const matchedResult = Array.isArray(mountResults)
    ? mountResults.find((item) => item.tag === workspaceMount.tag && item.guestPath === workspaceMount.guestPath)
    : null;
  const mounted = matchedResult ? matchedResult.mounted : isMounted(workspaceMount.guestPath);
  if (!mounted) {
    throw new Error(
      `Sandbox workspace mount unavailable (${workspaceMount.tag} -> ${workspaceMount.guestPath}). `
      + 'Files would be written inside the VM and not persist to the selected folder.'
    );
  }

  if (!isPathWritable(requestCwd)) {
    throw new Error(
      `Sandbox workspace path is not writable: ${requestCwd}. `
      + 'Files would not persist to the selected folder.'
    );
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------
function updateHeartbeat() {
  const data = {
    timestamp: Date.now(),
    pid: process.pid,
    uptime: process.uptime(),
    ipcMounted: ipcMode === 'file' ? isMounted(IPC_ROOT) : true,
  };

  if (ipcMode === 'serial') {
    serialWrite({ type: 'heartbeat', ...data });
    appendLog(`Heartbeat (serial): ${JSON.stringify(data)}`);
  } else {
    try {
      fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify(data));
      appendLog(`Heartbeat updated: ${JSON.stringify(data)}`);
    } catch (error) {
      appendLog(`Failed to update heartbeat: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Stream writers – file mode vs serial mode
// ---------------------------------------------------------------------------
function createStreamWriter(requestId) {
  if (ipcMode === 'serial') {
    return {
      stream: null,
      streamPath: null,
      emit: (payload) => {
        serialWrite({ type: 'stream', requestId, line: JSON.stringify(payload) });
      },
      close: () => {},
    };
  }

  ensureDir(STREAMS_DIR);
  const streamPath = path.join(STREAMS_DIR, `${requestId}.log`);
  try {
    fs.closeSync(fs.openSync(streamPath, 'a'));
  } catch (error) {
    console.error('Failed to touch stream file:', streamPath, error);
  }
  const stream = fs.createWriteStream(streamPath, { flags: 'a' });
  return {
    stream,
    streamPath,
    emit: (payload) => {
      try {
        stream.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        console.error('Failed to write stream payload:', error);
      }
    },
    close: () => stream.end(),
  };
}

function buildEnv(requestEnv) {
  const env = { ...process.env };
  if (requestEnv && typeof requestEnv === 'object') {
    for (const [key, value] of Object.entries(requestEnv)) {
      if (value === undefined || value === null) continue;
      env[key] = String(value);
    }
  }
  if (!env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
  }
  if (!env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_API_KEY;
  }
  env.HOME = env.HOME || '/root';
  env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME || '/root/.config';
  env.TMPDIR = '/tmp';
  env.TMP = '/tmp';
  env.TEMP = '/tmp';
  // Claude CLI requires bash
  env.SHELL = env.SHELL || '/bin/bash';
  env.PATH = env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  // Ensure USER is set
  env.USER = env.USER || 'root';
  env.LOGNAME = env.LOGNAME || 'root';
  return env;
}

// ---------------------------------------------------------------------------
// Permission response – file mode vs serial mode
// ---------------------------------------------------------------------------

// Pending serial permission responses: requestId → { resolve }
const pendingSerialPermissions = new Map();
const pendingSerialHostToolResponses = new Map();

function waitForPermissionResponse(requestId, signal) {
  if (ipcMode === 'serial') {
    return waitForSerialPermissionResponse(requestId, signal);
  }
  return waitForFilePermissionResponse(requestId, signal);
}

async function waitForFilePermissionResponse(requestId, signal) {
  ensureDir(RESPONSES_DIR);
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
  const startAt = Date.now();
  while (true) {
    if (signal?.aborted) {
      return { behavior: 'deny', message: 'Session aborted' };
    }
    if (Date.now() - startAt >= PERMISSION_RESPONSE_TIMEOUT_MS) {
      return { behavior: 'deny', message: 'Permission request timed out after 60s' };
    }
    if (fs.existsSync(responsePath)) {
      const payload = safeReadJson(responsePath);
      if (payload) {
        try {
          fs.unlinkSync(responsePath);
        } catch (error) {
          console.error('Failed to delete permission response:', error);
        }
        return payload;
      }
    }
    await sleep(200);
  }
}

function waitForSerialPermissionResponse(requestId, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    let onAbort = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      pendingSerialPermissions.delete(requestId);
    };

    const finalize = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    onAbort = () => {
      finalize({ behavior: 'deny', message: 'Session aborted' });
    };

    if (signal?.aborted) {
      finalize({ behavior: 'deny', message: 'Session aborted' });
      return;
    }
    pendingSerialPermissions.set(requestId, { resolve: finalize });

    timeoutId = setTimeout(() => {
      finalize({ behavior: 'deny', message: 'Permission request timed out after 60s' });
    }, PERMISSION_RESPONSE_TIMEOUT_MS);

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function waitForHostToolResponse(requestId, signal) {
  if (ipcMode === 'serial') {
    return waitForSerialHostToolResponse(requestId, signal);
  }
  return waitForFileHostToolResponse(requestId, signal);
}

async function waitForFileHostToolResponse(requestId, signal) {
  ensureDir(RESPONSES_DIR);
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.host-tool.json`);
  const startAt = Date.now();
  while (true) {
    if (signal?.aborted) {
      return { success: false, error: 'Session aborted' };
    }
    if (Date.now() - startAt >= PERMISSION_RESPONSE_TIMEOUT_MS) {
      return { success: false, error: 'Host tool request timed out after 60s' };
    }
    if (fs.existsSync(responsePath)) {
      const payload = safeReadJson(responsePath);
      if (payload) {
        try {
          fs.unlinkSync(responsePath);
        } catch (error) {
          console.error('Failed to delete host tool response:', error);
        }
        return payload;
      }
    }
    await sleep(200);
  }
}

function waitForSerialHostToolResponse(requestId, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    let onAbort = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      pendingSerialHostToolResponses.delete(requestId);
    };

    const finalize = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    onAbort = () => {
      finalize({ success: false, error: 'Session aborted' });
    };

    if (signal?.aborted) {
      finalize({ success: false, error: 'Session aborted' });
      return;
    }

    pendingSerialHostToolResponses.set(requestId, { resolve: finalize });

    timeoutId = setTimeout(() => {
      finalize({ success: false, error: 'Host tool request timed out after 60s' });
    }, PERMISSION_RESPONSE_TIMEOUT_MS);

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Request handler (shared by both modes)
// ---------------------------------------------------------------------------
async function handleRequest(requestId, request, requestPath) {
  const writer = createStreamWriter(requestId);
  const emit = writer.emit;
  const requestCwd = request.cwd || '/workspace';
  const confirmationMode = request.confirmationMode === 'text' ? 'text' : 'modal';
  const hostWorkspaceRoot = typeof request.hostWorkspaceRoot === 'string'
    ? request.hostWorkspaceRoot.trim()
    : '';
  const workspaceRoot = (() => {
    const rawRoot = typeof request.workspaceRoot === 'string' && request.workspaceRoot.trim()
      ? request.workspaceRoot
      : requestCwd;
    const resolvedRoot = path.resolve(rawRoot);
    try {
      return fs.realpathSync(resolvedRoot);
    } catch {
      return resolvedRoot;
    }
  })();

  const callHostTool = async (toolName, toolInput, signal) => {
    const hostRequestId = randomUUID();
    emit({
      type: 'host_tool_request',
      requestId: hostRequestId,
      toolName,
      toolInput,
    });
    return waitForHostToolResponse(hostRequestId, signal);
  };

  try {
    appendLog(`Handling request ${requestId}`);
    const mountResults = ensureMounts(request.mounts);
    validateWorkspaceMount(request.mounts, mountResults, requestCwd, workspaceRoot);

    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const sdkVersion = getClaudeSdkVersion();
    const query = sdk.query;
    if (typeof query !== 'function') {
      throw new Error('Claude Agent SDK query function not available');
    }
    appendLog(`Loaded Claude SDK version: ${sdkVersion}`);

    const options = {
      cwd: requestCwd,
      env: buildEnv(request.env),
      pathToClaudeCodeExecutable: require.resolve('@anthropic-ai/claude-agent-sdk/cli.js'),
      includePartialMessages: true,
      permissionMode: 'default',
      stderr: (data) => {
        const line = typeof data === 'string' ? data.trim() : '';
        if (line) {
          appendLog(`claude stderr: ${line}`);
        }
      },
      canUseTool: async (toolName, toolInput, { signal }) => {
        if (signal?.aborted) {
          return { behavior: 'deny', message: 'Session aborted' };
        }

        const resolvedName = String(toolName ?? 'unknown');
        const resolvedInput =
          toolInput && typeof toolInput === 'object'
            ? toolInput
            : { value: toolInput };
        const normalizedInput = normalizeToolInputPaths(
          resolvedName,
          resolvedInput,
          requestCwd,
          request.env,
          hostWorkspaceRoot
        );

        if (isBlockedBuiltinWebTool(resolvedName)) {
          appendLog(`Blocked tool by policy: ${resolvedName}`);
          return {
            behavior: 'deny',
            message: 'Tool blocked by app policy: WebSearch/WebFetch are disabled in this environment.',
          };
        }

        if (request.autoApprove) {
          return { behavior: 'allow', updatedInput: normalizedInput };
        }

        const policyResult = await enforceToolSafetyPolicy({
          emit,
          signal,
          toolName: resolvedName,
          toolInput: normalizedInput,
          cwd: requestCwd,
          workspaceRoot,
          requestEnv: request.env,
        });
        if (policyResult) {
          return policyResult;
        }

        if (resolvedName !== 'AskUserQuestion') {
          return { behavior: 'allow', updatedInput: normalizedInput };
        }

        const permissionRequestId = randomUUID();
        emit({
          type: 'permission_request',
          requestId: permissionRequestId,
          toolName: resolvedName,
          toolInput: normalizedInput,
        });

        const result = await waitForPermissionResponse(permissionRequestId, signal);
        if (signal?.aborted) {
          return { behavior: 'deny', message: 'Session aborted' };
        }

        if (result.behavior === 'deny') {
          return result.message ? result : { behavior: 'deny', message: 'Permission denied' };
        }

        const updatedInput = result.updatedInput ?? normalizedInput;
        const hasAnswers = updatedInput && typeof updatedInput === 'object' && 'answers' in updatedInput;
        if (!hasAnswers) {
          return { behavior: 'deny', message: 'No answers provided' };
        }

        return { behavior: 'allow', updatedInput };
      },
    };

    const tool = typeof sdk.tool === 'function'
      ? sdk.tool
      : (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler });
    let createSdkMcpServer = typeof sdk.createSdkMcpServer === 'function'
      ? sdk.createSdkMcpServer
      : null;
    if (!createSdkMcpServer) {
      createSdkMcpServer = buildFallbackMcpServerFactory();
      if (createSdkMcpServer) {
        appendLog(
          `Claude SDK is missing createSdkMcpServer export (version=${sdkVersion}). `
          + 'Using fallback MCP server factory from @modelcontextprotocol/sdk.'
        );
      }
    }

    if (typeof sdk.tool !== 'function') {
      appendLog(
        `Claude SDK is missing tool export (version=${sdkVersion}). `
        + 'Using fallback tool definition wrapper.'
      );
    }

    if (
      typeof createSdkMcpServer === 'function'
      && typeof tool === 'function'
    ) {
      const memoryServerName = `host-memory-${requestId.slice(0, 8)}`;
      const memoryTools = [
        tool(
          'conversation_search',
          'Search prior conversations by query and return Claude-style <chat> blocks.',
          {
            query: z.string().min(1),
            max_results: z.number().int().min(1).max(10).optional(),
            before: z.string().optional(),
            after: z.string().optional(),
          },
          async (args, { signal }) => {
            const response = await callHostTool('conversation_search', args, signal);
            const text = typeof response?.text === 'string'
              ? response.text
              : typeof response?.error === 'string'
                ? response.error
                : '';
            return {
              content: [{ type: 'text', text }],
              isError: response?.success === false,
            };
          }
        ),
        tool(
          'recent_chats',
          'List recent chats and return Claude-style <chat> blocks.',
          {
            n: z.number().int().min(1).max(20).optional(),
            sort_order: z.enum(['asc', 'desc']).optional(),
            before: z.string().optional(),
            after: z.string().optional(),
          },
          async (args, { signal }) => {
            const response = await callHostTool('recent_chats', args, signal);
            const text = typeof response?.text === 'string'
              ? response.text
              : typeof response?.error === 'string'
                ? response.error
                : '';
            return {
              content: [{ type: 'text', text }],
              isError: response?.success === false,
            };
          }
        ),
      ];
      if (request.memoryEnabled !== false) {
        memoryTools.push(
          tool(
            'memory_user_edits',
            'Manage user memories. action=list|add|update|delete.',
            {
              action: z.enum(['list', 'add', 'update', 'delete']),
              id: z.string().optional(),
              text: z.string().optional(),
              confidence: z.number().min(0).max(1).optional(),
              status: z.enum(['created', 'stale', 'deleted']).optional(),
              is_explicit: z.boolean().optional(),
              limit: z.number().int().min(1).max(200).optional(),
              query: z.string().optional(),
            },
            async (args, { signal }) => {
              const response = await callHostTool('memory_user_edits', args, signal);
              const text = typeof response?.text === 'string'
                ? response.text
                : typeof response?.error === 'string'
                  ? response.error
                  : '';
              return {
                content: [{ type: 'text', text }],
                isError: response?.success === false,
              };
            }
          )
        );
      }
      options.mcpServers = {
        ...(options.mcpServers || {}),
        [memoryServerName]: createSdkMcpServer({
          name: memoryServerName,
          tools: memoryTools,
        }),
      };
    } else {
      appendLog(
        `Host memory/history tools are disabled because MCP helper is unavailable `
        + `(sdkVersion=${sdkVersion}, exports=${Object.keys(sdk || {}).sort().join(',')}).`
      );
    }

    if (request.sessionId) {
      options.resume = request.sessionId;
    }
    if (request.systemPrompt) {
      options.systemPrompt = request.systemPrompt;
    }

    // Build prompt: if we have image attachments, use SDKUserMessage with content blocks
    // instead of a plain string prompt, so the model can see the images.
    let queryPrompt;
    const imageAttachments = request.imageAttachments;
    if (Array.isArray(imageAttachments) && imageAttachments.length > 0) {
      const contentBlocks = [];
      const promptText = request.prompt || '';
      if (promptText.trim()) {
        contentBlocks.push({ type: 'text', text: promptText });
      }
      for (const img of imageAttachments) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType,
            data: img.base64Data,
          },
        });
      }
      const userMessage = {
        type: 'user',
        message: { role: 'user', content: contentBlocks },
        parent_tool_use_id: null,
        session_id: '',
      };
      queryPrompt = (async function* () { yield userMessage; })();
      appendLog(`Request ${requestId}: sending prompt with ${imageAttachments.length} image attachment(s)`);
    } else {
      queryPrompt = request.prompt || '';
    }

    const result = await query({ prompt: queryPrompt, options });
    for await (const event of result) {
      emit({ type: 'sdk_event', event });
    }

    // After SDK query completes, force sync all files to host (serial mode only)
    forceFullSync();
  } catch (error) {
    appendLog(`Request ${requestId} failed: ${error instanceof Error ? error.message : String(error)}`);
    emit({
      type: 'sdk_event',
      event: {
        type: 'result',
        subtype: 'error',
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    writer.close();
    if (requestPath) {
      try {
        fs.unlinkSync(requestPath);
      } catch (error) {
        console.error('Failed to delete request file:', error);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// File-based IPC (9p) — original polling loop
// ---------------------------------------------------------------------------
async function pollRequests() {
  ensureDir('/workspace');
  ensureMount('ipc', IPC_ROOT);
  ensureDir(REQUESTS_DIR);
  ensureDir(STREAMS_DIR);
  ensureDir(RESPONSES_DIR);

  // Write initial heartbeat and start heartbeat interval
  appendLog('Agent runner started, polling for requests...');
  updateHeartbeat();
  setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);

  const inflight = new Set();

  while (true) {
    let files = [];
    try {
      files = fs.readdirSync(REQUESTS_DIR).filter((file) => file.endsWith('.json'));
    } catch (error) {
      console.error('Failed to read requests directory:', error);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    files.sort();

    for (const file of files) {
      if (inflight.has(file)) continue;
      inflight.add(file);
      const requestPath = path.join(REQUESTS_DIR, file);
      const requestId = path.basename(file, '.json');
      const request = safeReadJson(requestPath);
      if (request) {
        await handleRequest(requestId, request, requestPath);
      }
      inflight.delete(file);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Serial IPC (virtio-serial) — used on Windows host
// ---------------------------------------------------------------------------
function serialWrite(data) {
  if (serialFd === null) return;
  try {
    const line = JSON.stringify(data) + '\n';
    fs.writeSync(serialFd, line);
  } catch (error) {
    appendLog(`Serial write error: ${error.message}`);
  }
}

function findSerialDevice() {
  for (const devPath of SERIAL_DEVICE_PATHS) {
    try {
      if (fs.existsSync(devPath)) {
        return devPath;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// File sync — guest -> host file transfer over virtio-serial
// ---------------------------------------------------------------------------

// Track known file states for change detection: relativePath -> { mtimeMs, size }
const fileSyncKnown = new Map();

function shouldIgnorePath(filePath) {
  const relative = path.relative(WORKSPACE_PROJECT, filePath);
  const parts = relative.split(path.sep);
  return parts.some((part) => FILE_SYNC_IGNORE.includes(part));
}

function syncFile(absPath) {
  if (shouldIgnorePath(absPath)) return;

  const relativePath = path.relative(WORKSPACE_PROJECT, absPath);

  // Security: reject paths that escape the workspace
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    appendLog(`File sync: rejected path outside workspace: ${relativePath}`);
    return;
  }

  // Resolve symlinks and verify real path stays within workspace
  try {
    const realPath = fs.realpathSync(absPath);
    if (!realPath.startsWith(WORKSPACE_PROJECT)) {
      appendLog(`File sync: skipping symlink outside workspace: ${absPath} -> ${realPath}`);
      return;
    }
  } catch { /* proceed with original path if realpath fails */ }

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return; // file may have been deleted between detection and read
  }

  if (stat.isDirectory()) return; // directories are created implicitly

  if (stat.size > FILE_SYNC_MAX_SIZE) {
    appendLog(`File sync: skipping oversized file (${stat.size} bytes): ${relativePath}`);
    return;
  }

  // Use forward slashes for cross-platform path consistency
  const syncPath = relativePath.split(path.sep).join('/');

  if (stat.size <= FILE_SYNC_CHUNK_SIZE) {
    // Single-message transfer
    try {
      const data = fs.readFileSync(absPath);
      serialWrite({
        type: 'file_sync',
        path: syncPath,
        data: data.toString('base64'),
        size: stat.size,
      });
    } catch (error) {
      appendLog(`File sync: failed to read ${relativePath}: ${error.message}`);
    }
  } else {
    // Chunked transfer for large files
    const transferId = randomUUID();
    const totalChunks = Math.ceil(stat.size / FILE_SYNC_CHUNK_SIZE);
    let fd;
    try {
      fd = fs.openSync(absPath, 'r');
      for (let i = 0; i < totalChunks; i++) {
        const chunkSize = Math.min(FILE_SYNC_CHUNK_SIZE, stat.size - i * FILE_SYNC_CHUNK_SIZE);
        const buf = Buffer.alloc(chunkSize);
        fs.readSync(fd, buf, 0, chunkSize, i * FILE_SYNC_CHUNK_SIZE);
        serialWrite({
          type: 'file_sync_chunk',
          transferId,
          path: syncPath,
          chunkIndex: i,
          totalChunks,
          data: buf.toString('base64'),
        });
      }
    } catch (error) {
      appendLog(`File sync: chunked transfer failed for ${relativePath}: ${error.message}`);
      return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    serialWrite({
      type: 'file_sync_complete',
      transferId,
      path: syncPath,
      totalChunks,
    });
  }

  appendLog(`File sync: sent ${relativePath} (${stat.size} bytes)`);
}

function scanAndSyncDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (shouldIgnorePath(fullPath)) continue;
    if (entry.isDirectory()) {
      scanAndSyncDir(fullPath);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        const relativePath = path.relative(WORKSPACE_PROJECT, fullPath);
        const known = fileSyncKnown.get(relativePath);
        if (!known || known.mtimeMs < stat.mtimeMs || known.size !== stat.size) {
          fileSyncKnown.set(relativePath, { mtimeMs: stat.mtimeMs, size: stat.size });
          syncFile(fullPath);
        }
      } catch { /* file may have disappeared */ }
    }
  }
}

function startFileSyncWatcher() {
  if (ipcMode !== 'serial') return;
  ensureDir(WORKSPACE_PROJECT);
  appendLog('File sync: starting periodic watcher');
  setInterval(() => {
    if (fs.existsSync(WORKSPACE_PROJECT)) {
      scanAndSyncDir(WORKSPACE_PROJECT);
    }
  }, FILE_SYNC_INTERVAL_MS);
}

/**
 * Force a full sync of all files in /workspace/project/.
 * Called after each request completes to ensure nothing is missed.
 */
function forceFullSync() {
  if (ipcMode !== 'serial') return;
  if (!fs.existsSync(WORKSPACE_PROJECT)) return;
  appendLog('File sync: running forced full scan');
  // Clear known files to force re-sync of everything
  fileSyncKnown.clear();
  scanAndSyncDir(WORKSPACE_PROJECT);
}

// ---------------------------------------------------------------------------
// Host → guest file push (skill files transfer for Windows sandbox)
// ---------------------------------------------------------------------------
const pendingPushTransfers = new Map();

function handlePushFile(basePath, relativePath, base64Data) {
  const fullPath = path.join(basePath, relativePath);
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, Buffer.from(base64Data, 'base64'));
    // Mark file as executable if it looks like a script
    if (/\.(sh|bash)$/.test(relativePath)) {
      try { fs.chmodSync(fullPath, 0o755); } catch { /* best effort */ }
    }
    appendLog(`Push file received: ${relativePath} -> ${fullPath}`);
  } catch (error) {
    appendLog(`Push file error for ${relativePath}: ${error.message}`);
  }
}

function handlePushFileChunk(msg) {
  const transferId = String(msg.transferId ?? '');
  const relativePath = String(msg.path ?? '');
  const chunkIndex = Number(msg.chunkIndex ?? 0);
  const totalChunks = Number(msg.totalChunks ?? 0);
  const data = String(msg.data ?? '');
  const basePath = String(msg.basePath ?? '');

  if (!transferId || !relativePath || !data || !basePath) return;

  if (!pendingPushTransfers.has(transferId)) {
    pendingPushTransfers.set(transferId, {
      chunks: new Map(),
      totalChunks,
      path: relativePath,
      basePath,
    });
  }

  const transfer = pendingPushTransfers.get(transferId);
  transfer.chunks.set(chunkIndex, Buffer.from(data, 'base64'));

  if (transfer.chunks.size === transfer.totalChunks) {
    assemblePushFile(transferId);
  }
}

function handlePushFileComplete(msg) {
  const transferId = String(msg.transferId ?? '');
  if (!transferId) return;

  const transfer = pendingPushTransfers.get(transferId);
  if (transfer && transfer.chunks.size === transfer.totalChunks) {
    assemblePushFile(transferId);
  }

  // Clean up incomplete transfers after timeout
  setTimeout(() => {
    if (pendingPushTransfers.has(transferId)) {
      appendLog(`Push file: cleaning up incomplete transfer ${transferId}`);
      pendingPushTransfers.delete(transferId);
    }
  }, 30000);
}

function assemblePushFile(transferId) {
  const transfer = pendingPushTransfers.get(transferId);
  if (!transfer) return;

  const fullPath = path.join(transfer.basePath, transfer.path);
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const buffers = [];
    for (let i = 0; i < transfer.totalChunks; i++) {
      const chunk = transfer.chunks.get(i);
      if (!chunk) {
        appendLog(`Push file: missing chunk ${i} for transfer ${transferId}`);
        pendingPushTransfers.delete(transferId);
        return;
      }
      buffers.push(chunk);
    }

    fs.writeFileSync(fullPath, Buffer.concat(buffers));
    if (/\.(sh|bash)$/.test(transfer.path)) {
      try { fs.chmodSync(fullPath, 0o755); } catch { /* best effort */ }
    }
    appendLog(`Push file (chunked) received: ${transfer.path} -> ${fullPath}`);
  } catch (error) {
    appendLog(`Push file (chunked) error for ${transfer.path}: ${error.message}`);
  } finally {
    pendingPushTransfers.delete(transferId);
  }
}

async function serialIpcMode(serialPath) {
  appendLog(`Using virtio-serial IPC: ${serialPath}`);
  ipcMode = 'serial';
  serialFd = fs.openSync(serialPath, 'r+');

  // Start heartbeat
  updateHeartbeat();
  setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);

  // Start file sync watcher for guest -> host file transfer
  startFileSyncWatcher();

  // Read incoming messages (requests, permission responses) from host
  const readStream = fs.createReadStream(null, { fd: serialFd, autoClose: false });
  const rl = readline.createInterface({ input: readStream });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line.trim());
    } catch {
      return;
    }

    if (msg.type === 'request' && msg.requestId && msg.data) {
      appendLog(`Serial request received: ${msg.requestId}`);
      handleRequest(msg.requestId, msg.data, null).catch((err) => {
        appendLog(`Serial request ${msg.requestId} failed: ${err.message}`);
      });
    }

    if (msg.type === 'permission_response' && msg.requestId) {
      const pending = pendingSerialPermissions.get(msg.requestId);
      if (pending) {
        pendingSerialPermissions.delete(msg.requestId);
        pending.resolve(msg.result || { behavior: 'deny', message: 'Empty response' });
      }
    }

    if (msg.type === 'host_tool_response' && msg.requestId) {
      const pending = pendingSerialHostToolResponses.get(msg.requestId);
      if (pending) {
        pendingSerialHostToolResponses.delete(msg.requestId);
        pending.resolve(msg);
      }
    }

    // Host → guest file push (used to transfer skill files on Windows)
    if (msg.type === 'push_file' && msg.basePath && msg.path && msg.data) {
      handlePushFile(msg.basePath, msg.path, msg.data);
    }

    if (msg.type === 'push_file_chunk') {
      handlePushFileChunk(msg);
    }

    if (msg.type === 'push_file_complete') {
      handlePushFileComplete(msg);
    }
  });

  rl.on('close', () => {
    appendLog('Serial readline closed');
  });

  // Keep the process running
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function main() {
  ensureDir('/workspace');

  // Try 9p mount first
  ensureMount('ipc', IPC_ROOT);

  if (isMounted(IPC_ROOT)) {
    appendLog('IPC mounted via 9p, using file-based IPC');
    await pollRequests();
    return;
  }

  // 9p not available — check for virtio-serial device
  appendLog('9p mount failed, checking for virtio-serial device...');
  tryModprobe(['virtio_console']);

  // Wait briefly for the device to appear after module load
  for (let i = 0; i < 10; i++) {
    const serialPath = findSerialDevice();
    if (serialPath) {
      await serialIpcMode(serialPath);
      return;
    }
    await sleep(500);
  }

  // Neither IPC mechanism available — fall back to file polling anyway
  // (the heartbeat will report ipcMounted=false)
  appendLog('No virtio-serial device found, falling back to file-based IPC');
  await pollRequests();
}

main().catch((error) => {
  console.error('Agent runner crashed:', error);
  process.exit(1);
});
