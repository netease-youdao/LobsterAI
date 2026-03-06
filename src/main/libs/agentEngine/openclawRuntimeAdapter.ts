import { randomUUID } from 'crypto';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { pathToFileURL } from 'url';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { CoworkMessage, CoworkStore } from '../../coworkStore';
import {
  OpenClawEngineManager,
  type OpenClawGatewayConnectionInfo,
} from '../openclawEngineManager';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
  PermissionRequest,
} from './types';

const OPENCLAW_SESSION_PREFIX = 'lobsterai:';
const OPENCLAW_GATEWAY_TOOL_EVENTS_CAP = 'tool-events';
const BRIDGE_MAX_MESSAGES = 20;
const BRIDGE_MAX_MESSAGE_CHARS = 1200;
const GATEWAY_READY_TIMEOUT_MS = 15_000;
const FINAL_HISTORY_SYNC_LIMIT = 24;

type GatewayEventFrame = {
  event: string;
  seq?: number;
  payload?: unknown;
};

type GatewayClientLike = {
  start: () => void;
  stop: () => void;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

type GatewayClientCtor = new (options: Record<string, unknown>) => GatewayClientLike;

type ChatEventState = 'delta' | 'final' | 'aborted' | 'error';

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: ChatEventState;
  message?: unknown;
  errorMessage?: string;
  stopReason?: string;
};

type AgentEventPayload = {
  seq?: number;
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: unknown;
};

type ExecApprovalRequestedPayload = {
  id?: string;
  request?: {
    command?: string;
    cwd?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
    agentId?: string | null;
  };
};

type ExecApprovalResolvedPayload = {
  id?: string;
};

type TextStreamMode = 'unknown' | 'snapshot' | 'delta';

type ActiveTurn = {
  sessionId: string;
  sessionKey: string;
  runId: string;
  knownRunIds: Set<string>;
  assistantMessageId: string | null;
  committedAssistantText: string;
  currentAssistantSegmentText: string;
  currentText: string;
  currentContentText: string;
  currentContentBlocks: string[];
  sawNonTextContentBlocks: boolean;
  textStreamMode: TextStreamMode;
  toolUseMessageIdByToolCallId: Map<string, string>;
  toolResultMessageIdByToolCallId: Map<string, string>;
  toolResultTextByToolCallId: Map<string, string>;
  stopRequested: boolean;
};

type PendingApprovalEntry = {
  requestId: string;
  sessionId: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
};

const extractMessageText = (message: unknown): string => {
  if (typeof message === 'string') {
    return message;
  }
  if (!isRecord(message)) {
    return '';
  }

  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        chunks.push(item.text);
      }
    }
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }
  if (typeof message.text === 'string') {
    return message.text;
  }
  return '';
};

const extractTextBlocksAndSignals = (
  message: unknown,
): { textBlocks: string[]; sawNonTextContentBlocks: boolean } => {
  if (!isRecord(message)) {
    return {
      textBlocks: [],
      sawNonTextContentBlocks: false,
    };
  }

  const content = message.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return {
      textBlocks: text ? [text] : [],
      sawNonTextContentBlocks: false,
    };
  }
  if (!Array.isArray(content)) {
    return {
      textBlocks: [],
      sawNonTextContentBlocks: false,
    };
  }

  const textBlocks: string[] = [];
  let sawNonTextContentBlocks = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) {
        textBlocks.push(text);
      }
      continue;
    }
    if (typeof block.type === 'string' && block.type !== 'thinking') {
      sawNonTextContentBlocks = true;
    }
  }

  return {
    textBlocks,
    sawNonTextContentBlocks,
  };
};

const isDroppedBoundaryTextBlockSubset = (streamedTextBlocks: string[], finalTextBlocks: string[]): boolean => {
  if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) {
    return false;
  }
  if (finalTextBlocks.every((block, index) => streamedTextBlocks[index] === block)) {
    return true;
  }
  const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
  return finalTextBlocks.every((block, index) => streamedTextBlocks[suffixStart + index] === block);
};

const extractToolText = (payload: unknown): string => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (Array.isArray(payload)) {
    const lines = payload
      .map((item) => extractToolText(item).trim())
      .filter(Boolean);
    if (lines.length > 0) {
      return lines.join('\n');
    }
  }

  if (!isRecord(payload)) {
    if (payload === undefined || payload === null) return '';
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }

  if (typeof payload.text === 'string' && payload.text.trim()) {
    return payload.text;
  }
  if (typeof payload.output === 'string' && payload.output.trim()) {
    return payload.output;
  }
  if (typeof payload.stdout === 'string' || typeof payload.stderr === 'string') {
    const chunks = [
      typeof payload.stdout === 'string' ? payload.stdout : '',
      typeof payload.stderr === 'string' ? payload.stderr : '',
    ].filter(Boolean);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  const content = payload.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (typeof item === 'string' && item.trim()) {
        chunks.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      if (typeof item.text === 'string' && item.text.trim()) {
        chunks.push(item.text);
        continue;
      }
      if (typeof item.content === 'string' && item.content.trim()) {
        chunks.push(item.content);
      }
    }
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

const toToolInputRecord = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return {};
  }
  return { value };
};

const computeSuffixPrefixOverlap = (left: string, right: string): number => {
  const leftProbe = left.slice(-256);
  const rightProbe = right.slice(0, 256);
  const maxOverlap = Math.min(leftProbe.length, rightProbe.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (leftProbe.slice(-size) === rightProbe.slice(0, size)) {
      return size;
    }
  }
  return 0;
};

const mergeStreamingText = (
  previousText: string,
  incomingText: string,
  mode: TextStreamMode,
): { text: string; mode: TextStreamMode } => {
  if (!incomingText) {
    return { text: previousText, mode };
  }
  if (!previousText) {
    return { text: incomingText, mode };
  }
  if (incomingText === previousText) {
    return { text: previousText, mode };
  }

  if (mode === 'snapshot') {
    if (previousText.startsWith(incomingText) && incomingText.length < previousText.length) {
      return { text: previousText, mode };
    }
    return { text: incomingText, mode };
  }

  if (mode === 'delta') {
    if (incomingText.startsWith(previousText)) {
      return { text: incomingText, mode: 'snapshot' };
    }
    const overlap = computeSuffixPrefixOverlap(previousText, incomingText);
    return { text: previousText + incomingText.slice(overlap), mode };
  }

  if (incomingText.startsWith(previousText)) {
    return { text: incomingText, mode: 'snapshot' };
  }
  if (previousText.startsWith(incomingText)) {
    return { text: previousText, mode: 'snapshot' };
  }
  if (incomingText.includes(previousText) && incomingText.length > previousText.length) {
    return { text: incomingText, mode: 'snapshot' };
  }

  const overlap = computeSuffixPrefixOverlap(previousText, incomingText);
  if (overlap > 0) {
    return { text: previousText + incomingText.slice(overlap), mode: 'delta' };
  }

  return { text: previousText + incomingText, mode: 'delta' };
};

const waitWithTimeout = async (promise: Promise<void>, timeoutMs: number): Promise<void> => {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<void>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`OpenClaw gateway client connect timeout after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export class OpenClawRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly store: CoworkStore;
  private readonly engineManager: OpenClawEngineManager;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly sessionIdBySessionKey = new Map<string, string>();
  private readonly sessionIdByRunId = new Map<string, string>();
  private readonly pendingAgentEventsByRunId = new Map<string, AgentEventPayload[]>();
  private readonly lastChatSeqByRunId = new Map<string, number>();
  private readonly lastAgentSeqByRunId = new Map<string, number>();
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  private readonly pendingTurns = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly confirmationModeBySession = new Map<string, 'modal' | 'text'>();
  private readonly bridgedSessions = new Set<string>();
  private readonly lastSystemPromptBySession = new Map<string, string>();

  private gatewayClient: GatewayClientLike | null = null;
  private gatewayClientVersion: string | null = null;
  private gatewayClientEntryPath: string | null = null;
  private gatewayReadyPromise: Promise<void> | null = null;
  private browserPrewarmAttempted = false;

  constructor(store: CoworkStore, engineManager: OpenClawEngineManager) {
    super();
    this.store = store;
    this.engineManager = engineManager;
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(sessionId: string, prompt: string, options: CoworkStartOptions = {}): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: options.skipInitialUserMessage,
      skillIds: options.skillIds,
      systemPrompt: options.systemPrompt,
      confirmationMode: options.confirmationMode,
      imageAttachments: options.imageAttachments,
    });
  }

  async continueSession(sessionId: string, prompt: string, options: CoworkContinueOptions = {}): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: false,
      systemPrompt: options.systemPrompt,
      skillIds: options.skillIds,
      imageAttachments: options.imageAttachments,
    });
  }

  stopSession(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      turn.stopRequested = true;
      const client = this.gatewayClient;
      if (client) {
        void client.request('chat.abort', {
          sessionKey: turn.sessionKey,
          runId: turn.runId,
        }).catch((error) => {
          console.warn('[OpenClawRuntime] Failed to abort chat run:', error);
        });
      }
    }

    this.cleanupSessionTurn(sessionId);
    this.clearPendingApprovalsBySession(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.resolveTurn(sessionId);
  }

  stopAllSessions(): void {
    const activeSessionIds = Array.from(this.activeTurns.keys());
    activeSessionIds.forEach((sessionId) => {
      this.stopSession(sessionId);
    });
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    const decision = result.behavior === 'allow' ? 'allow-once' : 'deny';
    const client = this.gatewayClient;
    if (!client) {
      this.pendingApprovals.delete(requestId);
      return;
    }

    void client.request('exec.approval.resolve', {
      id: requestId,
      decision,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', pending.sessionId, `Failed to resolve OpenClaw approval: ${message}`);
    }).finally(() => {
      this.pendingApprovals.delete(requestId);
    });
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.confirmationModeBySession.get(sessionId) ?? null;
  }

  private async runTurn(
    sessionId: string,
    prompt: string,
    options: {
      skipInitialUserMessage?: boolean;
      systemPrompt?: string;
      skillIds?: string[];
      confirmationMode?: 'modal' | 'text';
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
    },
  ): Promise<void> {
    if (!prompt.trim()) {
      throw new Error('Prompt is required.');
    }
    if (this.activeTurns.has(sessionId)) {
      throw new Error(`Session ${sessionId} is still running.`);
    }

    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const confirmationMode = options.confirmationMode
      ?? this.confirmationModeBySession.get(sessionId)
      ?? 'modal';
    this.confirmationModeBySession.set(sessionId, confirmationMode);

    if (!options.skipInitialUserMessage) {
      const metadata = (options.skillIds?.length || options.imageAttachments?.length)
        ? {
          ...(options.skillIds?.length ? { skillIds: options.skillIds } : {}),
          ...(options.imageAttachments?.length ? { imageAttachments: options.imageAttachments } : {}),
        }
        : undefined;
      const userMessage = this.store.addMessage(sessionId, {
        type: 'user',
        content: prompt,
        metadata,
      });
      this.emit('message', sessionId, userMessage);
    }

    const sessionKey = this.toSessionKey(sessionId);
    this.sessionIdBySessionKey.set(sessionKey, sessionId);

    this.store.updateSession(sessionId, { status: 'running' });
    await this.ensureGatewayClientReady();

    const runId = randomUUID();
    const outboundMessage = await this.buildOutboundPrompt(
      sessionId,
      prompt,
      options.systemPrompt ?? session.systemPrompt,
    );
    const completionPromise = new Promise<void>((resolve, reject) => {
      this.pendingTurns.set(sessionId, { resolve, reject });
    });
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId,
      knownRunIds: new Set([runId]),
      assistantMessageId: null,
      committedAssistantText: '',
      currentAssistantSegmentText: '',
      currentText: '',
      currentContentText: '',
      currentContentBlocks: [],
      sawNonTextContentBlocks: false,
      textStreamMode: 'unknown',
      toolUseMessageIdByToolCallId: new Map(),
      toolResultMessageIdByToolCallId: new Map(),
      toolResultTextByToolCallId: new Map(),
      stopRequested: false,
    });
    this.sessionIdByRunId.set(runId, sessionId);

    const client = this.requireGatewayClient();
    try {
      const sendResult = await client.request<Record<string, unknown>>('chat.send', {
        sessionKey,
        message: outboundMessage,
        deliver: false,
        idempotencyKey: runId,
      });
      const returnedRunId = typeof sendResult?.runId === 'string' ? sendResult.runId.trim() : '';
      if (returnedRunId) {
        this.bindRunIdToTurn(sessionId, returnedRunId);
      }
    } catch (error) {
      this.cleanupSessionTurn(sessionId);
      this.store.updateSession(sessionId, { status: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', sessionId, message);
      this.rejectTurn(sessionId, new Error(message));
      throw error;
    }

    await completionPromise;
  }

  private async buildOutboundPrompt(
    sessionId: string,
    prompt: string,
    systemPrompt?: string,
  ): Promise<string> {
    const normalizedSystemPrompt = (systemPrompt ?? '').trim();
    const previousSystemPrompt = this.lastSystemPromptBySession.get(sessionId) ?? '';
    const shouldInjectSystemPrompt = Boolean(
      normalizedSystemPrompt
      && normalizedSystemPrompt !== previousSystemPrompt,
    );

    if (normalizedSystemPrompt) {
      this.lastSystemPromptBySession.set(sessionId, normalizedSystemPrompt);
    } else {
      this.lastSystemPromptBySession.delete(sessionId);
    }

    const sections: string[] = [];
    if (shouldInjectSystemPrompt) {
      sections.push(this.buildSystemPromptPrefix(normalizedSystemPrompt));
    }

    if (this.bridgedSessions.has(sessionId)) {
      if (sections.length === 0) {
        return prompt;
      }
      sections.push(`[Current user request]\n${prompt}`);
      return sections.join('\n\n');
    }

    const client = this.requireGatewayClient();
    const sessionKey = this.toSessionKey(sessionId);
    let hasHistory = false;
    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: 1,
      });
      hasHistory = Array.isArray(history?.messages) && history.messages.length > 0;
    } catch (error) {
      console.warn('[OpenClawRuntime] chat.history check failed, continuing without history guard:', error);
    }

    this.bridgedSessions.add(sessionId);

    if (!hasHistory) {
      const session = this.store.getSession(sessionId);
      if (session) {
        const bridgePrefix = this.buildBridgePrefix(session.messages, prompt);
        if (bridgePrefix) {
          sections.push(bridgePrefix);
        }
      }
    }

    if (sections.length === 0) {
      return prompt;
    }

    sections.push(`[Current user request]\n${prompt}`);
    return sections.join('\n\n');
  }

  private buildSystemPromptPrefix(systemPrompt: string): string {
    return [
      '[LobsterAI system instructions]',
      'Apply the instructions below as the highest-priority guidance for this session.',
      'If earlier LobsterAI system instructions exist, replace them with this version.',
      systemPrompt,
    ].join('\n');
  }

  private buildBridgePrefix(messages: CoworkMessage[], currentPrompt: string): string {
    const normalizedCurrentPrompt = currentPrompt.trim();
    if (!normalizedCurrentPrompt) return '';

    const source = messages
      .filter((message) => {
        if (message.type !== 'user' && message.type !== 'assistant') {
          return false;
        }
        if (!message.content.trim()) {
          return false;
        }
        if (message.metadata?.isThinking) {
          return false;
        }
        return true;
      })
      .map((message) => ({
        type: message.type,
        content: message.content.trim(),
      }));

    if (source.length === 0) {
      return '';
    }

    if (source[source.length - 1]?.type === 'user'
      && source[source.length - 1]?.content === normalizedCurrentPrompt) {
      source.pop();
    }

    const recent = source.slice(-BRIDGE_MAX_MESSAGES);
    if (recent.length === 0) {
      return '';
    }

    const lines = recent.map((entry) => {
      const role = entry.type === 'user' ? 'User' : 'Assistant';
      return `${role}: ${truncate(entry.content, BRIDGE_MAX_MESSAGE_CHARS)}`;
    });

    return [
      '[Context bridge from previous LobsterAI conversation]',
      'Use this prior context for continuity. Focus your final answer on the current request.',
      ...lines,
    ].join('\n');
  }

  private async ensureGatewayClientReady(): Promise<void> {
    const engineStatus = await this.engineManager.startGateway();
    if (engineStatus.phase !== 'running') {
      const message = engineStatus.message || 'OpenClaw engine is not running.';
      throw new Error(message);
    }

    const connection = this.engineManager.getGatewayConnectionInfo();
    const missing: string[] = [];
    if (!connection.url) missing.push('url');
    if (!connection.token) missing.push('token');
    if (!connection.version) missing.push('version');
    if (!connection.clientEntryPath) missing.push('clientEntryPath');
    if (missing.length > 0) {
      throw new Error(`OpenClaw gateway connection info is incomplete (missing: ${missing.join(', ')})`);
    }

    const needsNewClient = !this.gatewayClient
      || this.gatewayClientVersion !== connection.version
      || this.gatewayClientEntryPath !== connection.clientEntryPath;
    if (!needsNewClient && this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
      return;
    }

    this.stopGatewayClient();
    await this.createGatewayClient(connection);
    if (this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
    }

    // Fire-and-forget: pre-warm the browser so Chrome is already running
    // before the AI agent calls the browser tool (avoids 15s startup timeout).
    this.prewarmBrowserIfNeeded(connection);
  }

  private async createGatewayClient(connection: OpenClawGatewayConnectionInfo): Promise<void> {
    const GatewayClient = await this.loadGatewayClientCtor(connection.clientEntryPath);

    let resolveReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    let settled = false;

    this.gatewayReadyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolveReady?.();
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectReady?.(error);
    };

    const client = new GatewayClient({
      url: connection.url,
      token: connection.token,
      clientDisplayName: 'LobsterAI',
      clientVersion: app.getVersion(),
      mode: 'backend',
      caps: [OPENCLAW_GATEWAY_TOOL_EVENTS_CAP],
      role: 'operator',
      scopes: ['operator.admin'],
      onHelloOk: () => {
        settleResolve();
      },
      onConnectError: (error: Error) => {
        settleReject(error);
      },
      onClose: (_code: number, reason: string) => {
        if (!settled) {
          settleReject(new Error(reason || 'OpenClaw gateway disconnected before handshake'));
          return;
        }

        const disconnectedError = new Error(reason || 'OpenClaw gateway client disconnected');
        const activeSessionIds = Array.from(this.activeTurns.keys());
        activeSessionIds.forEach((sessionId) => {
          this.store.updateSession(sessionId, { status: 'error' });
          this.emit('error', sessionId, disconnectedError.message);
          this.cleanupSessionTurn(sessionId);
          this.rejectTurn(sessionId, disconnectedError);
        });
        this.stopGatewayClient();
        this.gatewayReadyPromise = Promise.reject(disconnectedError);
        this.gatewayReadyPromise.catch(() => {
          // suppress unhandled rejection noise; caller will re-establish on next run
        });
      },
      onEvent: (event: GatewayEventFrame) => {
        this.handleGatewayEvent(event);
      },
    });

    this.gatewayClient = client;
    this.gatewayClientVersion = connection.version;
    this.gatewayClientEntryPath = connection.clientEntryPath;
    client.start();
  }

  private stopGatewayClient(): void {
    try {
      this.gatewayClient?.stop();
    } catch (error) {
      console.warn('[OpenClawRuntime] Failed to stop gateway client:', error);
    }
    this.gatewayClient = null;
    this.gatewayClientVersion = null;
    this.gatewayClientEntryPath = null;
    this.gatewayReadyPromise = null;
    this.browserPrewarmAttempted = false;
  }

  private prewarmBrowserIfNeeded(connection: OpenClawGatewayConnectionInfo): void {
    if (this.browserPrewarmAttempted) return;
    if (!connection.port || !connection.token) return;
    this.browserPrewarmAttempted = true;

    const browserControlPort = connection.port + 2;
    const token = connection.token;
    console.log(`[OpenClawRuntime] browser pre-warm: gatewayPort=${connection.port}, browserControlPort=${browserControlPort}`);
    void this.prewarmBrowserWithRetry(browserControlPort, token);
  }

  private probeBrowserControlService(toolCallId: string, phase: string): void {
    const connection = this.engineManager.getGatewayConnectionInfo();
    if (!connection.port || !connection.token) {
      console.log(`[OpenClawRuntime] browser probe (${toolCallId}/${phase}): no gateway connection info`);
      return;
    }
    const browserControlPort = connection.port + 2;
    const token = connection.token;
    const probeStartTime = Date.now();
    console.log(`[OpenClawRuntime] browser probe (${toolCallId}/${phase}): checking port ${browserControlPort} ...`);

    // Probe multiple endpoints to diagnose reachability
    const endpoints = [`http://127.0.0.1:${browserControlPort}/status`, `http://127.0.0.1:${browserControlPort}/`];
    for (const probeUrl of endpoints) {
      fetch(probeUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })
        .then(async (response) => {
          const body = await response.text().catch(() => '');
          console.log(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → HTTP ${response.status} (${Date.now() - probeStartTime}ms) body=${body.slice(0, 500)}`,
          );
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → FAILED (${Date.now() - probeStartTime}ms) error=${message}`,
          );
        });
    }
  }

  private async prewarmBrowserWithRetry(
    port: number,
    token: string,
    maxRetries = 5,
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}/start?profile=openclaw`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      console.log(
        `[OpenClawRuntime] browser pre-warm attempt ${attempt}/${maxRetries} → POST http://127.0.0.1:${port}/start?profile=openclaw`,
      );

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(90_000),
        });
        const body = await response.text();
        if (response.ok) {
          console.log(
            `[OpenClawRuntime] browser pre-warm succeeded (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
          );
          return;
        }
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} returned HTTP ${response.status} (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} failed (${Date.now() - startTime}ms): ${message}`,
        );
      }

      if (attempt < maxRetries) {
        const delayMs = Math.min(5000, 2000 * attempt);
        console.log(`[OpenClawRuntime] browser pre-warm retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    console.warn('[OpenClawRuntime] browser pre-warm exhausted all retries (non-fatal, browser will start on first tool use)');
  }

  private async loadGatewayClientCtor(clientEntryPath: string): Promise<GatewayClientCtor> {
    const modulePath = pathToFileURL(clientEntryPath).href;
    const loaded = await import(modulePath) as Record<string, unknown>;
    const direct = loaded.GatewayClient;
    if (typeof direct === 'function') {
      return direct as GatewayClientCtor;
    }

    const exportedValues = Object.values(loaded);
    for (const candidate of exportedValues) {
      if (typeof candidate !== 'function') {
        continue;
      }
      const maybeCtor = candidate as {
        name?: string;
        prototype?: {
          start?: unknown;
          stop?: unknown;
          request?: unknown;
        };
      };
      if (maybeCtor.name === 'GatewayClient') {
        return candidate as GatewayClientCtor;
      }
      const proto = maybeCtor.prototype;
      if (proto
        && typeof proto.start === 'function'
        && typeof proto.stop === 'function'
        && typeof proto.request === 'function') {
        return candidate as GatewayClientCtor;
      }
    }

    const exportKeysPreview = Object.keys(loaded).slice(0, 20).join(', ');
    throw new Error(
      `Invalid OpenClaw gateway client module: ${clientEntryPath} (exports: ${exportKeysPreview || 'none'})`,
    );
  }

  private handleGatewayEvent(event: GatewayEventFrame): void {
    if (event.event === 'chat') {
      this.handleChatEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'agent') {
      this.handleAgentEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'exec.approval.requested') {
      this.handleApprovalRequested(event.payload);
      return;
    }

    if (event.event === 'exec.approval.resolved') {
      this.handleApprovalResolved(event.payload);
    }
  }

  private handleAgentEvent(payload: unknown, seq?: number): void {
    if (!isRecord(payload)) return;
    const agentPayload = payload as AgentEventPayload;
    const runId = typeof agentPayload.runId === 'string' ? agentPayload.runId.trim() : '';
    const sessionKey = typeof agentPayload.sessionKey === 'string' ? agentPayload.sessionKey.trim() : '';
    if (typeof seq === 'number' && Number.isFinite(seq) && runId) {
      const lastSeq = this.lastAgentSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.lastAgentSeqByRunId.set(runId, seq);
    }

    const sessionIdByRunId = runId ? this.sessionIdByRunId.get(runId) : undefined;
    const sessionIdBySessionKey = sessionKey ? this.sessionIdBySessionKey.get(sessionKey) : undefined;
    const sessionId = sessionIdByRunId ?? sessionIdBySessionKey;
    if (!sessionId) {
      if (runId) {
        this.enqueuePendingAgentEvent(runId, agentPayload, seq);
      }
      return;
    }
    if (sessionIdByRunId && sessionIdBySessionKey && sessionIdByRunId !== sessionIdBySessionKey) return;

    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    if (sessionKey && !runId && turn.sessionKey !== sessionKey) return;

    if (runId) {
      const mappedSessionId = this.sessionIdByRunId.get(runId);
      if (mappedSessionId && mappedSessionId !== sessionId) return;
      this.bindRunIdToTurn(sessionId, runId);
    }

    this.dispatchAgentEvent(sessionId, turn, {
      ...agentPayload,
      ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq } : {}),
    });
  }

  private dispatchAgentEvent(sessionId: string, turn: ActiveTurn, agentPayload: AgentEventPayload): void {
    const stream = typeof agentPayload.stream === 'string' ? agentPayload.stream.trim() : '';
    const hasToolShape = isRecord(agentPayload.data) && typeof agentPayload.data.toolCallId === 'string';
    if (stream === 'tool' || stream === 'tools' || (!stream && hasToolShape)) {
      if (Array.isArray(agentPayload.data)) {
        for (const entry of agentPayload.data) {
          this.handleAgentToolEvent(sessionId, turn, entry);
        }
      } else {
        this.handleAgentToolEvent(sessionId, turn, agentPayload.data);
      }
      return;
    }
    if (stream === 'lifecycle') {
      this.handleAgentLifecycleEvent(sessionId, agentPayload.data);
    }
  }

  private enqueuePendingAgentEvent(runId: string, payload: AgentEventPayload, seq?: number): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;

    const stream = typeof payload.stream === 'string' ? payload.stream.trim() : '';
    const hasToolShape = isRecord(payload.data) && typeof payload.data.toolCallId === 'string';
    const isSupportedStream = stream === 'tool'
      || stream === 'tools'
      || stream === 'lifecycle'
      || (!stream && hasToolShape);
    if (!isSupportedStream) return;

    const queued = this.pendingAgentEventsByRunId.get(normalizedRunId) ?? [];
    queued.push({
      runId: normalizedRunId,
      sessionKey: payload.sessionKey,
      stream: payload.stream,
      data: payload.data,
      ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq } : {}),
    });
    if (queued.length > 240) {
      queued.shift();
    }
    this.pendingAgentEventsByRunId.set(normalizedRunId, queued);

    if (this.pendingAgentEventsByRunId.size > 400) {
      const oldestRunId = this.pendingAgentEventsByRunId.keys().next().value as string | undefined;
      if (oldestRunId) {
        this.pendingAgentEventsByRunId.delete(oldestRunId);
      }
    }
  }

  private flushPendingAgentEvents(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;

    const queued = this.pendingAgentEventsByRunId.get(normalizedRunId);
    if (!queued || queued.length === 0) return;
    this.pendingAgentEventsByRunId.delete(normalizedRunId);

    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    for (const event of queued) {
      this.dispatchAgentEvent(sessionId, turn, event);
    }
  }

  private handleAgentLifecycleEvent(sessionId: string, data: unknown): void {
    if (!isRecord(data)) return;
    const phase = typeof data.phase === 'string' ? data.phase.trim() : '';
    if (phase === 'start') {
      this.store.updateSession(sessionId, { status: 'running' });
    }
  }

  private handleAgentToolEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    if (!isRecord(data)) return;

    const rawPhase = typeof data.phase === 'string' ? data.phase.trim() : '';
    const phase = rawPhase === 'end' ? 'result' : rawPhase;
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId.trim() : '';
    if (!toolCallId) return;
    if (phase !== 'start' && phase !== 'update' && phase !== 'result') return;

    const toolNameRaw = typeof data.name === 'string' ? data.name.trim() : '';
    const toolName = toolNameRaw || 'Tool';

    if (toolNameRaw.toLowerCase() === 'browser') {
      const isError = Boolean(data.isError);
      // Log full data keys and values for diagnosis
      const dataKeys = Object.keys(data);
      const resultType = data.result === undefined ? 'undefined'
        : data.result === null ? 'null'
          : typeof data.result === 'string' ? `string(len=${data.result.length})`
            : Array.isArray(data.result) ? `array(len=${data.result.length})`
              : `object(keys=${Object.keys(data.result as Record<string, unknown>).join(',')})`;
      console.log(
        `[OpenClawRuntime] browser tool event: phase=${phase} toolCallId=${toolCallId}`
        + ` dataKeys=[${dataKeys.join(',')}] resultType=${resultType}`
        + (phase === 'start' ? ` args=${JSON.stringify(data.args ?? {}).slice(0, 500)}` : '')
        + (phase === 'result' ? ` isError=${isError}` : ''),
      );
      if (phase === 'result') {
        // Log full result for browser events (may contain error details)
        try {
          const fullResult = JSON.stringify(data.result, null, 2);
          console.log(`[OpenClawRuntime] browser tool result (${toolCallId}): ${fullResult?.slice(0, 2000) ?? '(null)'}`);
        } catch {
          console.log(`[OpenClawRuntime] browser tool result (${toolCallId}): [unstringifiable] ${String(data.result).slice(0, 500)}`);
        }
        if (isError) {
          // Log any additional error-related fields
          const errorFields: Record<string, unknown> = {};
          for (const key of dataKeys) {
            if (/error|reason|message|detail|status/i.test(key)) {
              errorFields[key] = data[key];
            }
          }
          if (Object.keys(errorFields).length > 0) {
            console.log(`[OpenClawRuntime] browser tool error fields (${toolCallId}): ${JSON.stringify(errorFields).slice(0, 1000)}`);
          }
        }
      }
      // Probe browser control service reachability from Electron main process
      this.probeBrowserControlService(toolCallId, phase);
    }

    if (phase === 'start') {
      this.splitAssistantSegmentBeforeTool(turn);
    }

    if (!turn.toolUseMessageIdByToolCallId.has(toolCallId)) {
      const toolUseMessage = this.store.addMessage(sessionId, {
        type: 'tool_use',
        content: `Using tool: ${toolName}`,
        metadata: {
          toolName,
          toolInput: toToolInputRecord(data.args),
          toolUseId: toolCallId,
        },
      });
      turn.toolUseMessageIdByToolCallId.set(toolCallId, toolUseMessage.id);
      this.emit('message', sessionId, toolUseMessage);
    }

    if (phase === 'update') {
      const incoming = extractToolText(data.partialResult);
      if (!incoming.trim()) return;

      const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
      const merged = mergeStreamingText(previous, incoming, 'unknown').text;

      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);
      if (!existingResultMessageId) {
        const resultMessage = this.store.addMessage(sessionId, {
          type: 'tool_result',
          content: merged,
          metadata: {
            toolResult: merged,
            toolUseId: toolCallId,
            isError: false,
            isStreaming: true,
            isFinal: false,
          },
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.emit('message', sessionId, resultMessage);
        return;
      }

      if (merged !== previous) {
        this.store.updateMessage(sessionId, existingResultMessageId, {
          content: merged,
          metadata: {
            toolResult: merged,
            toolUseId: toolCallId,
            isError: false,
            isStreaming: true,
            isFinal: false,
          },
        });
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.emit('messageUpdate', sessionId, existingResultMessageId, merged);
      }
      return;
    }

    if (phase === 'result') {
      const incoming = extractToolText(data.result);
      const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
      const isError = Boolean(data.isError);
      const finalContent = incoming.trim() ? incoming : previous;
      const finalError = isError ? (finalContent || 'Tool execution failed') : undefined;
      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);

      if (existingResultMessageId) {
        this.store.updateMessage(sessionId, existingResultMessageId, {
          content: finalContent,
          metadata: {
            toolResult: finalContent,
            toolUseId: toolCallId,
            error: finalError,
            isError,
            isStreaming: false,
            isFinal: true,
          },
        });
        this.emit('messageUpdate', sessionId, existingResultMessageId, finalContent);
      } else {
        const resultMessage = this.store.addMessage(sessionId, {
          type: 'tool_result',
          content: finalContent,
          metadata: {
            toolResult: finalContent,
            toolUseId: toolCallId,
            error: finalError,
            isError,
            isStreaming: false,
            isFinal: true,
          },
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        this.emit('message', sessionId, resultMessage);
      }
      turn.toolResultTextByToolCallId.set(toolCallId, finalContent);
    }
  }

  private handleChatEvent(payload: unknown, seq?: number): void {
    if (!isRecord(payload)) return;
    const chatPayload = payload as ChatEventPayload;
    const state = chatPayload.state;
    if (!state) return;

    const sessionId = this.resolveSessionIdFromChatPayload(chatPayload);
    if (!sessionId) return;

    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    const runId = typeof chatPayload.runId === 'string' ? chatPayload.runId.trim() : '';
    if (typeof seq === 'number' && Number.isFinite(seq) && runId) {
      const lastSeq = this.lastChatSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.lastChatSeqByRunId.set(runId, seq);
    }

    if (state === 'delta') {
      this.handleChatDelta(sessionId, turn, chatPayload);
      return;
    }

    if (state === 'final') {
      this.handleChatFinal(sessionId, turn, chatPayload);
      return;
    }

    if (state === 'aborted') {
      this.handleChatAborted(sessionId, turn);
      return;
    }

    if (state === 'error') {
      this.handleChatError(sessionId, turn, chatPayload);
    }
  }

  private updateTurnTextState(
    turn: ActiveTurn,
    message: unknown,
    options: { protectBoundaryDrops?: boolean; forceReplace?: boolean } = {},
  ): void {
    const contentText = extractMessageText(message).trim();
    const { textBlocks, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);

    if (contentText) {
      const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
      const shouldProtectBoundaryDrop = Boolean(
        options.protectBoundaryDrops
        && (turn.sawNonTextContentBlocks || sawNonTextContentBlocks)
        && isDroppedBoundaryTextBlockSubset(turn.currentContentBlocks, nextContentBlocks),
      );
      if (!shouldProtectBoundaryDrop) {
        if (options.forceReplace) {
          turn.currentContentText = contentText;
          turn.currentContentBlocks = nextContentBlocks;
          turn.textStreamMode = 'snapshot';
        } else {
          const merged = mergeStreamingText(turn.currentContentText, contentText, turn.textStreamMode);
          turn.currentContentText = merged.text;
          turn.textStreamMode = merged.mode;
          if (merged.mode === 'snapshot') {
            turn.currentContentBlocks = nextContentBlocks;
          } else {
            const mergedText = merged.text.trim();
            if (mergedText) {
              turn.currentContentBlocks = [mergedText];
            }
          }
        }
      }
    }

    if (sawNonTextContentBlocks) {
      turn.sawNonTextContentBlocks = true;
    }
    turn.currentText = turn.currentContentText.trim();
  }

  private resolveFinalTurnText(turn: ActiveTurn, message: unknown): string {
    const streamedText = turn.currentText.trim();
    const streamedTextBlocks = [...turn.currentContentBlocks];
    const streamedSawNonTextContentBlocks = turn.sawNonTextContentBlocks;

    this.updateTurnTextState(turn, message, { forceReplace: true });
    const finalText = turn.currentText.trim();

    if (!finalText) {
      return streamedText;
    }

    const shouldFallbackToStreamedText = streamedSawNonTextContentBlocks
      && isDroppedBoundaryTextBlockSubset(streamedTextBlocks, turn.currentContentBlocks);
    if (shouldFallbackToStreamedText && streamedText) {
      turn.currentContentText = streamedText;
      turn.currentContentBlocks = streamedTextBlocks;
      turn.currentText = streamedText;
      return streamedText;
    }

    return finalText;
  }

  private resolveAssistantSegmentText(turn: ActiveTurn, fullText: string): string {
    const normalizedFullText = fullText.trim();
    const committed = turn.committedAssistantText;
    if (!normalizedFullText) {
      return '';
    }
    if (!committed) {
      return normalizedFullText;
    }
    if (normalizedFullText.startsWith(committed)) {
      return normalizedFullText.slice(committed.length).trimStart();
    }
    return normalizedFullText;
  }

  private splitAssistantSegmentBeforeTool(turn: ActiveTurn): void {
    if (!turn.assistantMessageId) {
      return;
    }

    const segmentText = turn.currentAssistantSegmentText.trim();
    if (segmentText) {
      const committedCandidate = `${turn.committedAssistantText}${segmentText}`;
      const fullText = turn.currentText.trim();
      if (fullText && fullText.startsWith(committedCandidate)) {
        turn.committedAssistantText = committedCandidate;
      } else {
        turn.committedAssistantText = committedCandidate;
      }
    } else {
      const fullText = turn.currentText.trim();
      if (fullText && fullText.length > turn.committedAssistantText.length) {
        turn.committedAssistantText = fullText;
      }
    }

    turn.assistantMessageId = null;
    turn.currentAssistantSegmentText = '';
  }

  private handleChatDelta(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    const previousText = turn.currentText;
    const previousContentText = turn.currentContentText;
    const previousContentBlocks = [...turn.currentContentBlocks];
    const previousSawNonTextContentBlocks = turn.sawNonTextContentBlocks;
    const previousTextStreamMode = turn.textStreamMode;
    const previousSegmentText = turn.currentAssistantSegmentText;

    this.updateTurnTextState(turn, payload.message, { protectBoundaryDrops: true });
    const streamedText = turn.currentText;
    if (previousText && streamedText && streamedText.length < previousText.length) {
      turn.currentText = previousText;
      turn.currentContentText = previousContentText;
      turn.currentContentBlocks = previousContentBlocks;
      turn.sawNonTextContentBlocks = previousSawNonTextContentBlocks;
      turn.textStreamMode = previousTextStreamMode;
      return;
    }

    if (!streamedText) return;
    const segmentText = this.resolveAssistantSegmentText(turn, streamedText);
    if (!segmentText) return;
    if (segmentText === previousSegmentText && streamedText === previousText) return;

    if (!turn.assistantMessageId) {
      const assistantMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: segmentText,
        metadata: {
          isStreaming: true,
          isFinal: false,
        },
      });
      turn.assistantMessageId = assistantMessage.id;
      turn.currentAssistantSegmentText = segmentText;
      this.emit('message', sessionId, assistantMessage);
      return;
    }

    if (turn.assistantMessageId && segmentText !== previousSegmentText) {
      this.store.updateMessage(sessionId, turn.assistantMessageId, {
        content: segmentText,
        metadata: {
          isStreaming: true,
          isFinal: false,
        },
      });
      turn.currentAssistantSegmentText = segmentText;
      this.emit('messageUpdate', sessionId, turn.assistantMessageId, segmentText);
    }
  }

  private handleChatFinal(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    const previousText = turn.currentText;
    const previousSegmentText = turn.currentAssistantSegmentText;
    const finalText = this.resolveFinalTurnText(turn, payload.message);
    turn.currentText = finalText;
    if (finalText && turn.currentContentBlocks.length === 0) {
      turn.currentContentText = finalText;
      turn.currentContentBlocks = [finalText];
    }
    const finalSegmentText = this.resolveAssistantSegmentText(turn, finalText);
    turn.currentAssistantSegmentText = finalSegmentText;

    if (turn.assistantMessageId) {
      const persistedSegmentText = finalSegmentText || previousSegmentText;
      if (persistedSegmentText) {
        this.store.updateMessage(sessionId, turn.assistantMessageId, {
          content: persistedSegmentText,
          metadata: {
            isStreaming: false,
            isFinal: true,
          },
        });
        if (persistedSegmentText !== previousSegmentText) {
          this.emit('messageUpdate', sessionId, turn.assistantMessageId, persistedSegmentText);
        }
      }
    } else if (finalSegmentText) {
      const assistantMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: finalSegmentText,
        metadata: {
          isStreaming: false,
          isFinal: true,
        },
      });
      turn.assistantMessageId = assistantMessage.id;
      this.emit('message', sessionId, assistantMessage);
    }

    const messageRecord = isRecord(payload.message) ? payload.message : null;
    const stopReason = payload.stopReason
      ?? (messageRecord && typeof messageRecord.stopReason === 'string' ? messageRecord.stopReason : undefined);
    const errorMessageFromMessage = messageRecord && typeof messageRecord.errorMessage === 'string'
      ? messageRecord.errorMessage
      : undefined;
    const stoppedByError = stopReason === 'error';
    if (stoppedByError) {
      const errorMessage = payload.errorMessage?.trim() || errorMessageFromMessage?.trim() || 'OpenClaw run failed';
      this.store.updateSession(sessionId, { status: 'error' });
      this.emit('error', sessionId, errorMessage);
      this.cleanupSessionTurn(sessionId);
      this.rejectTurn(sessionId, new Error(errorMessage));
      return;
    }

    // Align final assistant text with persisted gateway history to reduce mid-stream drift.
    void this.syncFinalAssistantWithHistory(sessionId, turn);

    this.store.updateSession(sessionId, { status: 'completed' });
    this.emit('complete', sessionId, payload.runId ?? turn.runId);
    this.cleanupSessionTurn(sessionId);
    this.resolveTurn(sessionId);
  }

  private handleChatAborted(sessionId: string, turn: ActiveTurn): void {
    this.store.updateSession(sessionId, { status: 'idle' });
    if (!turn.stopRequested) {
      this.emit('complete', sessionId, turn.runId);
    }
    this.cleanupSessionTurn(sessionId);
    this.resolveTurn(sessionId);
  }

  private handleChatError(sessionId: string, _turn: ActiveTurn, payload: ChatEventPayload): void {
    const errorMessage = payload.errorMessage?.trim() || 'OpenClaw run failed';
    this.store.updateSession(sessionId, { status: 'error' });
    this.emit('error', sessionId, errorMessage);
    this.cleanupSessionTurn(sessionId);
    this.rejectTurn(sessionId, new Error(errorMessage));
  }

  private handleApprovalRequested(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalRequestedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    if (!typedPayload.request || !isRecord(typedPayload.request)) return;

    const request = typedPayload.request;
    const sessionKey = typeof request.sessionKey === 'string' ? request.sessionKey.trim() : '';
    const sessionId = sessionKey ? this.sessionIdBySessionKey.get(sessionKey) : undefined;
    if (!sessionId) {
      return;
    }

    this.pendingApprovals.set(requestId, { requestId, sessionId });

    const permissionRequest: PermissionRequest = {
      requestId,
      toolName: 'Bash',
      toolInput: {
        command: typeof request.command === 'string' ? request.command : '',
        cwd: request.cwd ?? null,
        host: request.host ?? null,
        security: request.security ?? null,
        ask: request.ask ?? null,
        resolvedPath: request.resolvedPath ?? null,
        sessionKey: request.sessionKey ?? null,
        agentId: request.agentId ?? null,
      },
      toolUseId: requestId,
    };

    this.emit('permissionRequest', sessionId, permissionRequest);
  }

  private handleApprovalResolved(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalResolvedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    this.pendingApprovals.delete(requestId);
  }

  private resolveSessionIdFromChatPayload(payload: ChatEventPayload): string | null {
    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
    if (runId && this.sessionIdByRunId.has(runId)) {
      return this.sessionIdByRunId.get(runId) ?? null;
    }

    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    if (sessionKey && this.sessionIdBySessionKey.has(sessionKey)) {
      const sessionId = this.sessionIdBySessionKey.get(sessionKey) ?? null;
      if (sessionId && runId) {
        this.bindRunIdToTurn(sessionId, runId);
      }
      return sessionId;
    }
    return null;
  }

  private async syncFinalAssistantWithHistory(sessionId: string, turn: ActiveTurn): Promise<void> {
    const client = this.gatewayClient;
    if (!client) {
      return;
    }

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey: turn.sessionKey,
        limit: FINAL_HISTORY_SYNC_LIMIT,
      });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        return;
      }

      let canonicalText = '';
      for (let index = history.messages.length - 1; index >= 0; index -= 1) {
        const message = history.messages[index];
        if (!isRecord(message)) continue;
        const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
        if (role !== 'assistant') continue;
        canonicalText = extractMessageText(message).trim();
        if (canonicalText) {
          break;
        }
      }
      if (!canonicalText) {
        return;
      }

      const canonicalSegmentText = this.resolveAssistantSegmentText(turn, canonicalText);
      turn.currentText = canonicalText;
      turn.currentAssistantSegmentText = canonicalSegmentText;

      if (!canonicalSegmentText) {
        return;
      }

      if (!turn.assistantMessageId) {
        const assistantMessage = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: canonicalSegmentText,
          metadata: {
            isStreaming: false,
            isFinal: true,
          },
        });
        turn.assistantMessageId = assistantMessage.id;
        this.emit('message', sessionId, assistantMessage);
        return;
      }

      const session = this.store.getSession(sessionId);
      const currentMessage = session?.messages.find((message) => message.id === turn.assistantMessageId);
      const currentText = currentMessage?.content.trim() ?? '';
      if (canonicalSegmentText === currentText) {
        return;
      }

      this.store.updateMessage(sessionId, turn.assistantMessageId, {
        content: canonicalSegmentText,
        metadata: {
          isStreaming: false,
          isFinal: true,
        },
      });
      this.emit('messageUpdate', sessionId, turn.assistantMessageId, canonicalSegmentText);
    } catch (error) {
      console.warn('[OpenClawRuntime] chat.history sync after final failed:', error);
    }
  }

  private clearPendingApprovalsBySession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(requestId);
      }
    }
  }

  private cleanupSessionTurn(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      turn.knownRunIds.forEach((knownRunId) => {
        this.sessionIdByRunId.delete(knownRunId);
        this.pendingAgentEventsByRunId.delete(knownRunId);
        this.lastChatSeqByRunId.delete(knownRunId);
        this.lastAgentSeqByRunId.delete(knownRunId);
      });
    }
    this.activeTurns.delete(sessionId);
    this.lastSystemPromptBySession.delete(sessionId);
  }

  private bindRunIdToTurn(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    turn.knownRunIds.add(normalizedRunId);
    this.sessionIdByRunId.set(normalizedRunId, sessionId);
    this.flushPendingAgentEvents(sessionId, normalizedRunId);
  }

  private resolveTurn(sessionId: string): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.resolve();
  }

  private rejectTurn(sessionId: string, error: Error): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.reject(error);
  }

  private toSessionKey(sessionId: string): string {
    return `${OPENCLAW_SESSION_PREFIX}${sessionId}`;
  }

  private requireGatewayClient(): GatewayClientLike {
    if (!this.gatewayClient) {
      throw new Error('OpenClaw gateway client is unavailable.');
    }
    return this.gatewayClient;
  }
}
