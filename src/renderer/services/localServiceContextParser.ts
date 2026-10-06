import {
  CoworkSystemMessageKind,
  isInternalCompactionSystemText,
} from '../../common/coworkSystemMessages';
import {
  ShareDeploymentCandidateSource,
  type ShareDeploymentProjectCandidate,
} from '../../shared/shareDeployment/constants';
import { type Artifact, ArtifactTypeValue } from '../types/artifact';
import type { CoworkMessage } from '../types/cowork';
import {
  collectProjectDirectoryCandidatesFromText,
  getLocalServicePortIdentityKey,
  normalizeProjectDirectoryForDedup,
  parseLocalServiceUrlsFromText,
} from './artifactParser';

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'exec',
  'execcommand',
  'shell',
]);
const BROWSER_TOOL_NAME_PART = 'browser';
const BROWSER_URL_ACTIONS = new Set(['goto', 'navigate', 'open']);
const TOOL_COMMAND_KEYS = ['command', 'cmd', 'script'] as const;
const TOOL_WORKING_DIRECTORY_KEYS = [
  'cwd',
  'workdir',
  'workingDirectory',
  'working_directory',
  'projectDirectory',
  'project_directory',
] as const;
const TOOL_URL_KEYS = ['url', 'targetUrl', 'target_url', 'href'] as const;
const ANSI_ESCAPE_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const EXPLICIT_WORKING_DIRECTORY_COMMAND_RE = /^\s*(?:(?:cd(?:\s+\/d)?\s+(?:"[^"]+"|'[^']+'|`[^`]+`|[^\s;&|]+))\s*(?:&&|;)\s*)?(?:pwd|get-location)\s*$/i;
const SERVICE_START_COMMAND_RE = /(?:^|[\n;]|&&|\|\|)\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|(?:npx|pnpx|bunx)\s+(?:vite|next|nuxt|serve|http-server)\b|(?:vite|next|nuxt)\s+(?:dev|start|preview)\b|python(?:3)?\s+-m\s+http\.server\b|(?:uvicorn|gunicorn)\b|flask\s+run\b|rails\s+(?:server|s)\b|php\s+-S\b|cargo\s+run\b|go\s+run\b|node\s+[^\s;&|]+|\.\/[\w.-]*(?:start|serve)[\w.-]*\b|make\s+(?:start|serve|dev)\b)/i;
const ABSOLUTE_DIRECTORY_LINE_RE = /^(?:\/(?!\/).+|[A-Za-z]:[\\/].+|\\\\[^\\/]+[\\/][^\\/]+.*)$/;
const MAX_TOOL_CONTEXT_TEXT_LENGTH = 32_000;

type DirectoryEvidenceKind = 'text' | 'tool';
type ServiceEvidenceKind = 'assistant' | 'browser';

interface DirectoryEvidence {
  kind: DirectoryEvidenceKind;
  order: number;
  candidates: ShareDeploymentProjectCandidate[];
  ports: Set<number>;
  explicitPortBindings: Set<number>;
  isServiceStart: boolean;
}

interface ServiceEvidence {
  kind: ServiceEvidenceKind;
  order: number;
  artifact: Artifact;
}

interface ShellToolContext {
  commands: string[];
  ports: Set<number>;
  explicitPortBindings: Set<number>;
  isServiceStart: boolean;
}

interface AggregatedLocalService {
  artifact: Artifact;
  candidates: ShareDeploymentProjectCandidate[];
}

export interface LocalServiceContextParserOptions {
  workingDirectory?: string;
}

function normalizeToolName(toolName: string | undefined): string {
  return (toolName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isShellTool(toolName: string | undefined): boolean {
  const normalized = normalizeToolName(toolName);
  if (SHELL_TOOL_NAMES.has(normalized)) return true;
  return normalized.endsWith('execcommand');
}

function isBrowserTool(toolName: string | undefined): boolean {
  return normalizeToolName(toolName).includes(BROWSER_TOOL_NAME_PART);
}

function getStringValues(
  input: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      values.push(value.trim());
    }
  }
  return values;
}

function getToolCommands(input: Record<string, unknown>): string[] {
  const commands = getStringValues(input, TOOL_COMMAND_KEYS);
  const commandList = input.commands;
  if (Array.isArray(commandList)) {
    for (const command of commandList) {
      if (typeof command === 'string' && command.trim()) {
        commands.push(command.trim());
      }
    }
  } else if (typeof commandList === 'string' && commandList.trim()) {
    commands.push(commandList.trim());
  }
  return commands.map(command => command.slice(0, MAX_TOOL_CONTEXT_TEXT_LENGTH));
}

function getPortFromLocalServiceUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function collectPortsFromText(value: string): Set<number> {
  const ports = new Set<number>();
  const patterns = [
    /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]):(\d{1,5})\b/gi,
    /(?:^|[^\d])(?:--port(?:=|\s+)|-p\s+|PORT\s*=\s*|:)(\d{2,5})(?!\d)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        ports.add(port);
      }
    }
  }
  return ports;
}

function collectExplicitPortBindings(value: string): Set<number> {
  const ports = new Set<number>();
  const patterns = [
    /(?:^|[\s;&|])--port(?:=|\s+)(\d{1,5})(?!\d)/gi,
    /(?:^|[\s;&|])-p(?:=|\s+)(\d{1,5})(?!\d)/g,
    /(?:^|[\s;&|])PORT\s*=\s*(\d{1,5})(?!\d)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        ports.add(port);
      }
    }
  }
  return ports;
}

function mergePorts(target: Set<number>, source: Set<number>): void {
  for (const port of source) target.add(port);
}

function sanitizeDirectoryValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const quote = trimmed[0];
  if ((quote === '"' || quote === '\'' || quote === '`') && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function createToolDirectoryCandidate(
  directory: string,
  source: ShareDeploymentProjectCandidate['source'],
  confidence: number,
  messageId: string,
  fallbackProjectDirectory: string | undefined,
  reason: string,
  evidence?: string,
): ShareDeploymentProjectCandidate | null {
  const sanitized = sanitizeDirectoryValue(directory);
  if (!sanitized || /\$\(|\$\{|%[^%]+%/.test(sanitized)) return null;
  const parsed = collectProjectDirectoryCandidatesFromText(
    `project directory: ${sanitized}`,
    fallbackProjectDirectory,
    messageId,
  ).find(candidate => candidate.source === ShareDeploymentCandidateSource.TextLabeledPath);
  if (!parsed) return null;
  return {
    ...parsed,
    source,
    confidence,
    reason,
    ...(evidence ? { evidence } : {}),
  };
}

function mergeCandidates(
  ...candidateGroups: Array<readonly ShareDeploymentProjectCandidate[] | undefined>
): ShareDeploymentProjectCandidate[] {
  const result: ShareDeploymentProjectCandidate[] = [];
  const indexByDirectory = new Map<string, number>();
  for (const candidates of candidateGroups) {
    for (const candidate of candidates ?? []) {
      const key = normalizeProjectDirectoryForDedup(candidate.directory);
      if (!key) continue;
      const existingIndex = indexByDirectory.get(key);
      if (existingIndex === undefined) {
        indexByDirectory.set(key, result.length);
        result.push(candidate);
        continue;
      }
      if (candidate.confidence > result[existingIndex].confidence) {
        result[existingIndex] = candidate;
      }
    }
  }
  return result;
}

function getShellDirectoryEvidence(
  message: CoworkMessage,
  workingDirectory?: string,
): { evidence?: DirectoryEvidence; context: ShellToolContext } {
  const input = message.metadata?.toolInput ?? {};
  const commands = getToolCommands(input);
  const workingDirectories = getStringValues(input, TOOL_WORKING_DIRECTORY_KEYS);
  const fallbackDirectory = workingDirectories[workingDirectories.length - 1] || workingDirectory;
  const isServiceStart = commands.some(command => SERVICE_START_COMMAND_RE.test(command));
  const cdCandidates: ShareDeploymentProjectCandidate[] = [];

  for (const command of commands) {
    const commandCandidates = collectProjectDirectoryCandidatesFromText(
      command,
      fallbackDirectory,
      message.id,
    ).filter(candidate => candidate.source === ShareDeploymentCandidateSource.TextCdCommand);
    cdCandidates.push(...commandCandidates);
  }

  const orderedCdCandidates = cdCandidates.reverse().map((candidate, index) => ({
    ...candidate,
    source: ShareDeploymentCandidateSource.ToolCdCommand,
    confidence: Math.max(90, 94 - index),
    reason: 'Matched the effective directory from a shell tool command.',
  }));
  const cwdCandidates = workingDirectories
    .slice()
    .reverse()
    .map((directory, index) => createToolDirectoryCandidate(
      directory,
      ShareDeploymentCandidateSource.ToolWorkingDirectory,
      Math.max(88, 92 - index),
      message.id,
      workingDirectory,
      'Matched the working directory supplied to a shell tool.',
      directory,
    ))
    .filter((candidate): candidate is ShareDeploymentProjectCandidate => Boolean(candidate));
  const candidates = mergeCandidates(orderedCdCandidates, cwdCandidates);
  const ports = new Set<number>();
  const explicitPortBindings = new Set<number>();
  for (const command of commands) {
    mergePorts(ports, collectPortsFromText(command));
    mergePorts(explicitPortBindings, collectExplicitPortBindings(command));
  }

  return {
    ...(candidates.length
      ? {
          evidence: {
            kind: 'tool' as const,
            order: 0,
            candidates,
            ports,
            explicitPortBindings,
            isServiceStart,
          },
        }
      : {}),
    context: { commands, ports, explicitPortBindings, isServiceStart },
  };
}

function extractPwdResultCandidate(
  message: CoworkMessage,
  shellContext: ShellToolContext,
  workingDirectory?: string,
): ShareDeploymentProjectCandidate | null {
  if (
    message.metadata?.isError ||
    shellContext.commands.length !== 1 ||
    !EXPLICIT_WORKING_DIRECTORY_COMMAND_RE.test(shellContext.commands[0])
  ) {
    return null;
  }
  const resultText = (message.content || message.metadata?.toolResult || '')
    .slice(0, MAX_TOOL_CONTEXT_TEXT_LENGTH)
    .replace(ANSI_ESCAPE_RE, '');
  for (const rawLine of resultText.split(/\r?\n/)) {
    const line = sanitizeDirectoryValue(rawLine);
    if (!ABSOLUTE_DIRECTORY_LINE_RE.test(line)) continue;
    const candidate = createToolDirectoryCandidate(
      line,
      ShareDeploymentCandidateSource.ToolPwdResult,
      95,
      message.id,
      workingDirectory,
      'Matched an explicit working directory returned by a shell tool.',
      rawLine,
    );
    if (candidate) return candidate;
  }
  return null;
}

function getBrowserLocalServiceArtifacts(
  message: CoworkMessage,
  sessionId: string,
): Artifact[] {
  if (!isBrowserTool(message.metadata?.toolName)) return [];
  const input = message.metadata?.toolInput ?? {};
  const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : '';
  if (action && !BROWSER_URL_ACTIONS.has(action)) return [];

  const artifacts: Artifact[] = [];
  for (const url of getStringValues(input, TOOL_URL_KEYS)) {
    artifacts.push(...parseLocalServiceUrlsFromText(url, message.id, sessionId));
  }
  return artifacts.map(artifact => ({ ...artifact, createdAt: message.timestamp || artifact.createdAt }));
}

function getClosestEvidence(
  evidence: DirectoryEvidence[],
  event: ServiceEvidence,
  kind: DirectoryEvidenceKind,
  requireServiceStart = false,
): DirectoryEvidence | undefined {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const item = evidence[index];
    if (
      item.order <= event.order &&
      item.kind === kind &&
      (!requireServiceStart || item.isServiceStart)
    ) {
      return item;
    }
  }
  return undefined;
}

function getClosestExplicitToolEvidence(
  evidence: DirectoryEvidence[],
  event: ServiceEvidence,
): DirectoryEvidence | undefined {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const item = evidence[index];
    if (item.order > event.order || item.kind !== 'tool') continue;
    if (item.candidates.some(candidate =>
      candidate.source === ShareDeploymentCandidateSource.ToolCdCommand ||
      candidate.source === ShareDeploymentCandidateSource.ToolPwdResult
    )) {
      return item;
    }
  }
  return undefined;
}

function getCandidatesForServiceEvidence(
  event: ServiceEvidence,
  directoryEvidence: DirectoryEvidence[],
): ShareDeploymentProjectCandidate[] {
  const port = getPortFromLocalServiceUrl(event.artifact.url || event.artifact.content);
  const matchingToolEvidence = port
    ? directoryEvidence
        .filter(item =>
          item.kind === 'tool' &&
          item.order <= event.order &&
          (
            (item.isServiceStart && item.ports.has(port)) ||
            item.explicitPortBindings.has(port)
          )
        )
        .sort((left, right) => right.order - left.order)
    : [];
  const closestStartEvidence = getClosestEvidence(directoryEvidence, event, 'tool', true);
  const closestExplicitToolEvidence = getClosestExplicitToolEvidence(directoryEvidence, event);
  const closestToolEvidence = getClosestEvidence(directoryEvidence, event, 'tool');
  const closestTextEvidence = getClosestEvidence(directoryEvidence, event, 'text');
  return mergeCandidates(
    ...matchingToolEvidence.map(item => item.candidates),
    closestStartEvidence?.candidates,
    event.artifact.localService?.projectCandidates,
    closestExplicitToolEvidence?.candidates,
    closestTextEvidence?.candidates,
    closestToolEvidence?.candidates,
  );
}

function parseLocalServiceArtifactsFromTurn(
  messages: CoworkMessage[],
  sessionId: string,
  options: LocalServiceContextParserOptions,
): Artifact[] {
  const directoryEvidence: DirectoryEvidence[] = [];
  const serviceEvidence: ServiceEvidence[] = [];
  const shellContextByToolUseId = new Map<string, ShellToolContext>();
  let adjacentShellContext: ShellToolContext | null = null;

  messages.forEach((message, order) => {
    if (message.type === 'assistant') {
      adjacentShellContext = null;
      if (message.metadata?.isThinking || !message.content) return;
      const candidates = collectProjectDirectoryCandidatesFromText(
        message.content,
        options.workingDirectory,
        message.id,
      );
      if (candidates.length) {
        directoryEvidence.push({
          kind: 'text',
          order,
          candidates,
          ports: collectPortsFromText(message.content),
          explicitPortBindings: new Set<number>(),
          isServiceStart: false,
        });
      }
      const artifacts = parseLocalServiceUrlsFromText(
        message.content,
        message.id,
        sessionId,
        { projectDirectory: options.workingDirectory },
      );
      for (const artifact of artifacts) {
        serviceEvidence.push({
          kind: 'assistant',
          order,
          artifact: { ...artifact, createdAt: message.timestamp || artifact.createdAt },
        });
      }
      return;
    }

    if (message.type === 'tool_use') {
      if (isShellTool(message.metadata?.toolName)) {
        const shell = getShellDirectoryEvidence(message, options.workingDirectory);
        if (shell.evidence) directoryEvidence.push({ ...shell.evidence, order });
        const toolUseId = message.metadata?.toolUseId;
        if (toolUseId) shellContextByToolUseId.set(toolUseId, shell.context);
        adjacentShellContext = shell.context;
      } else {
        adjacentShellContext = null;
      }
      for (const artifact of getBrowserLocalServiceArtifacts(message, sessionId)) {
        serviceEvidence.push({ kind: 'browser', order, artifact });
      }
      return;
    }

    if (message.type === 'tool_result') {
      const toolUseId = message.metadata?.toolUseId;
      const shellContext = toolUseId
        ? shellContextByToolUseId.get(toolUseId)
        : adjacentShellContext;
      adjacentShellContext = null;
      if (!shellContext) return;
      const candidate = extractPwdResultCandidate(message, shellContext, options.workingDirectory);
      if (!candidate) return;
      directoryEvidence.push({
        kind: 'tool',
        order,
        candidates: [candidate],
        ports: shellContext.ports,
        explicitPortBindings: shellContext.explicitPortBindings,
        isServiceStart: shellContext.isServiceStart,
      });
      return;
    }

    adjacentShellContext = null;
  });

  const servicesByIdentity = new Map<string, AggregatedLocalService>();
  for (const event of serviceEvidence) {
    const identity = getLocalServicePortIdentityKey(event.artifact.url || event.artifact.content);
    if (!identity) continue;
    const candidates = getCandidatesForServiceEvidence(event, directoryEvidence);
    const existing = servicesByIdentity.get(identity);
    if (!existing) {
      servicesByIdentity.set(identity, {
        artifact: event.artifact,
        candidates,
      });
      continue;
    }
    existing.candidates = event.kind === 'browser'
      ? mergeCandidates(candidates, existing.candidates)
      : mergeCandidates(existing.candidates, candidates);
    if (event.kind === 'assistant') {
      existing.artifact = event.artifact;
    }
  }

  return Array.from(servicesByIdentity.values()).map(({ artifact, candidates }) => ({
    ...artifact,
    type: ArtifactTypeValue.LocalService,
    localService: {
      url: artifact.url || artifact.content,
      origin: artifact.localService?.origin || '',
      ...(candidates[0]?.directory ? { projectDirectory: candidates[0].directory } : {}),
      ...(candidates.length ? { projectCandidates: candidates } : {}),
    },
  }));
}

function isConversationBoundary(message: CoworkMessage): boolean {
  if (message.type === 'user') return true;
  if (message.type !== 'system') return false;
  const kind = message.metadata?.kind;
  return kind === CoworkSystemMessageKind.ContextCompaction
    || kind === CoworkSystemMessageKind.ForkCompactionSummary
    || (!kind && isInternalCompactionSystemText(message.content));
}

export function parseLocalServiceArtifactsFromMessages(
  messages: CoworkMessage[],
  sessionId: string,
  options: LocalServiceContextParserOptions = {},
): Artifact[] {
  const artifacts: Artifact[] = [];
  let turnMessages: CoworkMessage[] = [];
  const flushTurn = () => {
    if (!turnMessages.length) return;
    artifacts.push(...parseLocalServiceArtifactsFromTurn(turnMessages, sessionId, options));
    turnMessages = [];
  };

  for (const message of messages) {
    if (isConversationBoundary(message)) {
      flushTurn();
      continue;
    }
    turnMessages.push(message);
  }
  flushTurn();
  return artifacts;
}
