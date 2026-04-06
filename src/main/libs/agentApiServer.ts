import http from 'http';
import fs from 'fs';
import path from 'path';
import { session } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import type { AgentBridgeBinding, AgentBridgeFileBinding, AgentBridgeSessionMode } from './agentBridgeSessionStore';
import { AgentBridgeSessionStore } from './agentBridgeSessionStore';
import { resolveRawApiConfig } from './claudeSettings';

const AGENT_API_PORT = 19888;
const AGENT_API_HOST = '127.0.0.1';
const BRIDGE_PERMISSION_TTL_MS = 60_000;
const BRIDGE_UPLOADS_DIRNAME = '.lobster-bridge-files';
type AgentBridgeRequestMode = 'auto' | 'agent' | 'text-fast';
type AgentBridgeInputFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  path: string;
};

type AgentChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url?: { url?: string } | string };

interface AgentChatRequest {
  messages: { role: string; content: string | AgentChatContentPart[] }[];
  model?: string;
  stream?: boolean;
  skillIds?: string[];
}

interface AgentBridgeBindRequest {
  airiSessionId: string;
}

interface AgentBridgeChatRequest extends AgentChatRequest {
  airiSessionId: string;
  fileIds?: string[];
  clientTurnId?: string;
  systemPrompt?: string;
  sessionMode?: AgentBridgeRequestMode;
}

interface AgentBridgePermissionRequest {
  airiSessionId: string;
  requestId: string;
  capabilityToken: string;
  decision: 'allow' | 'deny';
}

type BridgeQuestionOption = {
  label?: string;
};

type BridgeQuestion = {
  question?: string;
  header?: string;
  options?: BridgeQuestionOption[];
};

interface AgentBridgePermissionStatusRequest {
  airiSessionId: string;
  requestId: string;
}

interface AgentBridgePermissionListRequest {
  airiSessionId: string;
}

interface AgentUploadFileRequest {
  airiSessionId: string;
  name: string;
  mimeType?: string;
  base64Data: string;
  clientTurnId?: string;
}

interface AgentReattachFilesRequest {
  airiSessionId: string;
  clientTurnId?: string;
  historyFileIds: string[];
}

interface AgentChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: string; content: string };
    finish_reason: string | null;
  }[];
}

type AgentAnimationState = 'idle' | 'think' | 'tool_use' | 'ask_user' | 'success' | 'error';
type AgentAnimationEmotion = 'neutral' | 'think' | 'happy' | 'question' | 'sad' | 'awkward' | 'surprised' | 'angry';

interface AgentStateChangedEvent {
  version: '1.0';
  sessionId: string;
  turnId: string;
  timestamp: number;
  state: AgentAnimationState;
  emotion: AgentAnimationEmotion;
  durationMs: number;
  priority: number;
  source: 'lobster-main';
  taskType: 'general' | 'search' | 'doc' | 'code' | 'schedule';
  toolName?: string;
  reason?: string;
  fallbackEmotion: AgentAnimationEmotion;
}

type AgentBridgeEvent =
  | {
      type: 'session.bound';
      sessionId: string;
      turnId: string;
      seq: number;
      createdAt: number;
      lobsterSessionId: string;
      sessionMode?: AgentBridgeSessionMode;
    }
  | {
      type: 'state.changed';
      sessionId: string;
      turnId: string;
      seq: number;
      createdAt: number;
      state: AgentAnimationState;
      emotion: AgentAnimationEmotion;
      toolName?: string;
      reason?: string;
    }
  | {
      type: 'assistant.delta' | 'assistant.final' | 'reasoning.delta' | 'reasoning.final';
      sessionId: string;
      turnId: string;
      seq: number;
      createdAt: number;
      text: string;
    }
  | {
      type: 'tool.call';
      sessionId: string;
      turnId: string;
      seq: number;
      createdAt: number;
      toolCallId: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'tool.result';
      sessionId: string;
      turnId: string;
      seq: number;
      createdAt: number;
      toolCallId: string;
      result: string;
      isError?: boolean;
    }
  | {
      type: 'permission.request';
      sessionId: string;
      turnId: string;
      seq: number;
      createdAt: number;
      requestId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      capabilityToken: string;
      expiresAt: number;
    }
  | {
      type: 'done';
      sessionId: string;
      turnId: string;
      seq: number;
      createdAt: number;
    }
  | {
      type: 'error';
      sessionId: string;
      turnId: string;
      seq: number;
      createdAt: number;
      message: string;
    };

function buildActSpecialToken(emotion: AgentAnimationEmotion): string {
  return `<|ACT:${JSON.stringify({ emotion: { name: emotion, intensity: 1 } })}|>`;
}

function createSSEEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function buildAttachmentName(mimeType: string, index: number): string {
  const extensionMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
  };
  const extension = extensionMap[mimeType] || 'bin';
  return `image-${index + 1}.${extension}`;
}

function parseDataImageUrl(
  value: string,
  index: number,
): { name: string; mimeType: string; base64Data: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const base64Data = match[2];
  if (!base64Data) return null;
  return {
    name: buildAttachmentName(mimeType, index),
    mimeType,
    base64Data,
  };
}

function parsePromptAndAttachments(
  messages: AgentChatRequest['messages'],
): { prompt: string; imageAttachments: Array<{ name: string; mimeType: string; base64Data: string }> } {
  const lastMessage = messages[messages.length - 1];
  const content = lastMessage.content;
  if (typeof content === 'string') {
    return { prompt: content, imageAttachments: [] };
  }
  const textParts: string[] = [];
  const imageAttachments: Array<{ name: string; mimeType: string; base64Data: string }> = [];
  for (const part of content) {
    if (part?.type === 'text') {
      if (typeof part.text === 'string' && part.text.trim()) {
        textParts.push(part.text);
      }
      continue;
    }
    if (part?.type === 'image_url') {
      const rawUrl = typeof part.image_url === 'string'
        ? part.image_url
        : part.image_url?.url;
      if (typeof rawUrl !== 'string') continue;
      const attachment = parseDataImageUrl(rawUrl, imageAttachments.length);
      if (attachment) {
        imageAttachments.push(attachment);
      }
    }
  }
  const prompt = textParts.join('\n').trim() || (imageAttachments.length > 0 ? '请结合图片内容进行回答。' : '');
  return { prompt, imageAttachments };
}

function isRateLimitErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('429')
    || normalized.includes('rate limit')
    || normalized.includes('rate_limit')
    || normalized.includes('tpd')
    || normalized.includes('rpm')
    || normalized.includes('concurrency');
}

const ASSISTANT_META_LINE_PATTERNS = [
  /^用户(?:要求|问|询问|提问)/,
  /^根据(?:系统提示|角色设定|要求)/,
  /^角色设定(?:要点)?[:：]?$/,
  /^关键要点[:：]?$/,
  /^内容要点[:：]?$/,
  /^回复策略[:：]?$/,
  /^结构(?:示例)?[:：]?$/,
  /^格式要求[:：]?$/,
  /^检查(?:要求)?[:：]?$/,
  /^情绪选择[:：]?$/,
  /^我(?:需要|应该|会|先|要)/,
  /^让我(?:构建|组织|生成|回答)/,
  /^必须(?:以|用|从)/,
  /^可以(?:使用|自由)/,
  /^保持角色设定[:：]?$/,
  /^可用情绪[:：]?$/,
  /^ACT\s*标签格式[:：]?$/,
  /^所有ACT标签内的内容必须/,
  /^- /,
  /^\d+[.)、]\s+/,
];

function sanitizeAssistantVisibleText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  const withoutControlTokens = normalized
    .replace(/<\|ACT:[\s\S]*?\|>/gi, ' ')
    .replace(/<\|DELAY:\d+\|>/gi, ' ')
    .replace(/\|ACT:\s*\{[\s\S]*?\}\|?/gi, ' ')
    .replace(/\|DELAY:\s*\d+\|?/gi, ' ')
    .replace(/lACT:\s*\{[\s\S]*?\}\|?/gi, ' ')
    .trim();

  const lines = withoutControlTokens
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const visibleLines = lines.filter((line) => {
    return !ASSISTANT_META_LINE_PATTERNS.some(pattern => pattern.test(line));
  });

  if (visibleLines.length > 0) {
    return visibleLines.join('\n').trim();
  }

  return withoutControlTokens;
}

function stripAssistantControlTokens(text: string): string {
  return text
    .replace(/<\|ACT:[\s\S]*?\|>/gi, '')
    .replace(/<\|DELAY:\d+\|>/gi, '')
    .replace(/\|ACT:\s*\{[\s\S]*?\}\|?/gi, '')
    .replace(/\|DELAY:\s*\d+\|?/gi, '')
    .replace(/lACT:\s*\{[\s\S]*?\}\|?/gi, '')
    .trimStart();
}

function parseSSEPacket(packet: string): string {
  return packet
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
}

function findSSEPacketBoundary(buffer: string): { index: number; separatorLength: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match || typeof match.index !== 'number') {
    return null;
  }

  return {
    index: match.index,
    separatorLength: match[0].length,
  };
}

async function requestDirectProviderChat(
  messages: AgentChatRequest['messages'],
  onDelta?: (delta: string) => void | Promise<void>,
): Promise<{ model: string; content: string }> {
  const resolution = resolveRawApiConfig();
  const apiConfig = resolution.config;
  if (!apiConfig?.baseURL || !apiConfig?.apiKey || !apiConfig?.model) {
    throw new Error('Direct provider fallback is unavailable because API configuration is incomplete.');
  }

  const response = await session.defaultSession.fetch(`${apiConfig.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: apiConfig.model,
      stream: Boolean(onDelta),
      messages,
    }),
  });

  if (onDelta) {
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`Direct provider fallback failed: ${response.status} ${raw}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Direct provider fallback returned no readable stream.');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let model = apiConfig.model;
    let fullContent = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = findSSEPacketBoundary(buffer);
        if (!boundary) {
          break;
        }

        const packet = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.separatorLength);
        const payload = parseSSEPacket(packet);
        if (!payload || payload === '[DONE]') {
          continue;
        }

        const parsed = JSON.parse(payload) as {
          model?: string
          choices?: Array<{
            delta?: {
              content?: string
            }
          }>
        };

        model = parsed.model || model;
        const rawDelta = typeof parsed.choices?.[0]?.delta?.content === 'string'
          ? parsed.choices[0].delta.content
          : '';
        const delta = stripAssistantControlTokens(rawDelta);
        if (!delta) {
          continue;
        }

        fullContent += delta;
        await onDelta(delta);
      }
    }

    const content = sanitizeAssistantVisibleText(fullContent);
    if (!content.trim()) {
      throw new Error('Direct provider fallback returned no visible response.');
    }

    return {
      model,
      content,
    };
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Direct provider fallback failed: ${response.status} ${raw}`);
  }

  const parsed = JSON.parse(raw) as {
    model?: string
    choices?: Array<{
      message?: {
        content?: string
        reasoning_content?: string
      }
    }>
  };

  const choice = parsed.choices?.[0]?.message;
  const visibleContent = sanitizeAssistantVisibleText(typeof choice?.content === 'string' ? choice.content : '');
  const visibleReasoningFallback = sanitizeAssistantVisibleText(typeof choice?.reasoning_content === 'string' ? choice.reasoning_content : '');
  const content = visibleContent || visibleReasoningFallback;

  if (!content.trim()) {
    throw new Error('Direct provider fallback returned no visible response.');
  }

  return {
    model: parsed.model || apiConfig.model,
    content,
  };
}

function parseAuthHeader(req: http.IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim();
  }
  const apiKey = req.headers['api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) {
    return apiKey.trim();
  }
  return null;
}

function sendError(res: http.ServerResponse, code: number, message: string, errorCode?: string): void {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', code: errorCode } }));
}

function writeSSEHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Connection': 'keep-alive',
  });
}

function sendSSEDone(res: http.ServerResponse): void {
  res.write('data: [DONE]\n\n');
  res.end();
}

export class AgentApiServer {
  private server: http.Server | null = null;
  private apiKey: string = '';
  private getCoworkRunner: () => any | null = () => null;
  private getSkillManager: () => any | null = () => null;
  private publishStateChanged: (event: AgentStateChangedEvent) => void = () => {};
  private bridgeSessions = new AgentBridgeSessionStore();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  setCoworkRunnerGetter(getter: () => any | null): void {
    this.getCoworkRunner = getter;
  }

  setStateChangedPublisher(publisher: (event: AgentStateChangedEvent) => void): void {
    this.publishStateChanged = publisher;
  }

  setSkillManagerGetter(getter: () => any | null): void {
    this.getSkillManager = getter;
  }

  private getStateDefaults(state: AgentAnimationState): {
    emotion: AgentAnimationEmotion;
    durationMs: number;
    priority: number;
    fallbackEmotion: AgentAnimationEmotion;
  } {
    if (state === 'think') {
      return { emotion: 'think', durationMs: 1200, priority: 30, fallbackEmotion: 'neutral' };
    }
    if (state === 'tool_use') {
      return { emotion: 'awkward', durationMs: 1400, priority: 40, fallbackEmotion: 'think' };
    }
    if (state === 'ask_user') {
      return { emotion: 'question', durationMs: 1500, priority: 60, fallbackEmotion: 'neutral' };
    }
    if (state === 'success') {
      return { emotion: 'happy', durationMs: 1100, priority: 20, fallbackEmotion: 'neutral' };
    }
    if (state === 'error') {
      return { emotion: 'sad', durationMs: 1500, priority: 90, fallbackEmotion: 'awkward' };
    }
    return { emotion: 'neutral', durationMs: 1000, priority: 10, fallbackEmotion: 'neutral' };
  }

  private emitStateChanged(
    sessionId: string,
    turnId: string,
    state: AgentAnimationState,
    options?: { toolName?: string; reason?: string; taskType?: AgentStateChangedEvent['taskType'] }
  ): void {
    const defaults = this.getStateDefaults(state);
    this.publishStateChanged({
      version: '1.0',
      sessionId,
      turnId,
      timestamp: Date.now(),
      state,
      emotion: defaults.emotion,
      durationMs: defaults.durationMs,
      priority: defaults.priority,
      source: 'lobster-main',
      taskType: options?.taskType ?? 'general',
      toolName: options?.toolName,
      reason: options?.reason,
      fallbackEmotion: defaults.fallbackEmotion,
    });
  }

  private emitActTokenToStream(
    res: http.ServerResponse,
    sessionId: string,
    emotion: AgentAnimationEmotion
  ): void {
    res.write(createSSEEvent({
      id: `chat-${sessionId}`,
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'claude-agent',
      choices: [{ index: 0, delta: { content: buildActSpecialToken(emotion) }, finish_reason: null }],
    }));
  }

  async start(): Promise<number> {
    if (this.server) {
      return this.getPort();
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        console.error('[AgentApiServer] Server error:', err);
        reject(err);
      });

      this.server.listen(AGENT_API_PORT, AGENT_API_HOST, () => {
        const port = this.getPort();
        console.log(`[AgentApiServer] Started on http://${AGENT_API_HOST}:${port}`);
        resolve(port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[AgentApiServer] Stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    const addr = this.server?.address();
    if (!addr || typeof addr === 'string') return AGENT_API_PORT;
    return addr.port;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '';
    const pathname = url.split('?')[0];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    if ([
      '/api/agent/chat',
      '/api/agent/chat/completions',
      '/api/agent/v1/chat/completions',
      '/v1/chat/completions',
      '/chat/completions',
    ].includes(pathname) && req.method === 'POST') {
      await this.handleChat(req, res);
      return;
    }

    if ([
      '/api/agent/models',
      '/api/agent/v1/models',
      '/v1/models',
      '/models',
    ].includes(pathname) && req.method === 'GET') {
      this.handleModels(req, res);
      return;
    }

    if (pathname === '/api/agent/health' && req.method === 'GET') {
      this.handleHealth(req, res);
      return;
    }

    if (pathname === '/api/agent/skills' && req.method === 'GET') {
      this.handleSkills(req, res);
      return;
    }

    if (pathname === '/api/agent/bridge/bind' && req.method === 'POST') {
      await this.handleBridgeBind(req, res);
      return;
    }

    if (pathname === '/api/agent/bridge/chat' && req.method === 'POST') {
      await this.handleBridgeChat(req, res);
      return;
    }

    if (pathname === '/api/agent/bridge/permission' && req.method === 'POST') {
      await this.handleBridgePermission(req, res);
      return;
    }

    if (pathname === '/api/agent/bridge/permission/status' && req.method === 'POST') {
      await this.handleBridgePermissionStatus(req, res);
      return;
    }

    if (pathname === '/api/agent/bridge/permission/list' && req.method === 'POST') {
      await this.handleBridgePermissionList(req, res);
      return;
    }

    if (pathname === '/api/agent/skills/set-enabled' && req.method === 'POST') {
      await this.handleSetSkillEnabled(req, res);
      return;
    }

    if (pathname === '/api/agent/skills/get-config' && req.method === 'POST') {
      await this.handleGetSkillConfig(req, res);
      return;
    }

    if (pathname === '/api/agent/skills/set-config' && req.method === 'POST') {
      await this.handleSetSkillConfig(req, res);
      return;
    }

    if (pathname === '/api/agent/skills/download' && req.method === 'POST') {
      await this.handleDownloadSkill(req, res);
      return;
    }

    if (pathname === '/api/agent/skills/confirm-install' && req.method === 'POST') {
      await this.handleConfirmInstall(req, res);
      return;
    }

    if (pathname === '/api/agent/files/upload' && req.method === 'POST') {
      await this.handleUploadFile(req, res);
      return;
    }

    if (pathname === '/api/agent/files/reattach' && req.method === 'POST') {
      await this.handleReattachFiles(req, res);
      return;
    }

    sendError(res, 404, 'Not found');
  }

  private verifyAuth(req: http.IncomingMessage): boolean {
    const providedKey = parseAuthHeader(req);
    if (!providedKey) {
      return false;
    }
    return providedKey === this.apiKey;
  }

  private createRunnerSession(runner: any): string {
    const store = runner?.store;
    if (store && typeof store.createSession === 'function') {
      const session = store.createSession('Agent API Session', process.cwd());
      return session.id;
    }
    return uuidv4();
  }

  private hasRunnerSession(runner: any, sessionId: string): boolean {
    const store = runner?.store;
    if (store && typeof store.getSession === 'function') {
      return Boolean(store.getSession(sessionId));
    }
    return true;
  }

  private async startRunnerSession(
    runner: any,
    sessionId: string,
    prompt: string,
    imageAttachments: Array<{ name: string; mimeType: string; base64Data: string }> = [],
    skillIds: string[] = [],
    systemPrompt?: string,
    inputFiles: AgentBridgeInputFile[] = [],
  ): Promise<void> {
    const normalizedSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    const store = runner?.store;
    if (normalizedSystemPrompt && store && typeof store.updateSession === 'function') {
      store.updateSession(sessionId, { systemPrompt: normalizedSystemPrompt });
    }
    if (typeof runner?.startCoworkSession === 'function') {
      await runner.startCoworkSession(sessionId, prompt, { imageAttachments, skillIds, systemPrompt: normalizedSystemPrompt || undefined, inputFiles });
      return;
    }
    if (typeof runner?.startSession === 'function') {
      await runner.startSession(sessionId, prompt, { confirmationMode: 'text', imageAttachments, skillIds, systemPrompt: normalizedSystemPrompt || undefined, inputFiles });
      return;
    }
    throw new Error('CoworkRunner start method not available');
  }

  private async continueRunnerSession(
    runner: any,
    sessionId: string,
    prompt: string,
    imageAttachments: Array<{ name: string; mimeType: string; base64Data: string }> = [],
    skillIds: string[] = [],
    systemPrompt?: string,
    inputFiles: AgentBridgeInputFile[] = [],
  ): Promise<void> {
    const normalizedSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    const store = runner?.store;
    if (normalizedSystemPrompt && store && typeof store.updateSession === 'function') {
      store.updateSession(sessionId, { systemPrompt: normalizedSystemPrompt });
    }
    if (typeof runner?.continueSession === 'function') {
      await runner.continueSession(sessionId, prompt, { imageAttachments, skillIds, systemPrompt: normalizedSystemPrompt || undefined, inputFiles });
      return;
    }
    await this.startRunnerSession(runner, sessionId, prompt, imageAttachments, skillIds, normalizedSystemPrompt || undefined, inputFiles);
  }

  private async readRequestBody(req: http.IncomingMessage): Promise<any | null> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  private handleSkills(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const manager = this.getSkillManager();
    if (!manager || typeof manager.listSkills !== 'function') {
      sendError(res, 503, 'SkillManager not available');
      return;
    }
    const skills = manager.listSkills();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({ skills }));
  }

  private createBridgeEvent<T extends Omit<AgentBridgeEvent, 'seq' | 'createdAt'>>(event: T): AgentBridgeEvent {
    return {
      ...event,
      seq: this.bridgeSessions.nextSeq(event.sessionId),
      createdAt: Date.now(),
    } as AgentBridgeEvent;
  }

  private writeBridgeEvent(res: http.ServerResponse, event: AgentBridgeEvent): void {
    res.write(createSSEEvent(event));
  }

  private emitBridgeStateChanged(
    res: http.ServerResponse,
    sessionId: string,
    turnId: string,
    state: AgentAnimationState,
    options?: { toolName?: string; reason?: string }
  ): void {
    const defaults = this.getStateDefaults(state);
    this.writeBridgeEvent(res, this.createBridgeEvent({
      type: 'state.changed',
      sessionId,
      turnId,
      state,
      emotion: defaults.emotion,
      toolName: options?.toolName,
      reason: options?.reason,
    }));
  }

  private logBridgeMetrics(options: {
    airiSessionId: string;
    turnId: string;
    mode: AgentBridgeSessionMode;
    startedAt: number;
    firstStateAt?: number | null;
    firstAssistantDeltaAt?: number | null;
    completedAt?: number;
    outcome: 'success' | 'error';
    assistantChars: number;
    skillCount: number;
    fileCount: number;
    imageCount: number;
    errorCode?: string;
  }): void {
    const completedAt = options.completedAt ?? Date.now();
    console.info('[AgentApiServer][bridge-metrics]', JSON.stringify({
      airiSessionId: options.airiSessionId,
      turnId: options.turnId,
      mode: options.mode,
      outcome: options.outcome,
      totalMs: completedAt - options.startedAt,
      firstStateMs: typeof options.firstStateAt === 'number' ? options.firstStateAt - options.startedAt : null,
      ttftMs: typeof options.firstAssistantDeltaAt === 'number' ? options.firstAssistantDeltaAt - options.startedAt : null,
      assistantChars: options.assistantChars,
      skillCount: options.skillCount,
      fileCount: options.fileCount,
      imageCount: options.imageCount,
      errorCode: options.errorCode,
    }));
  }

  private redactSensitiveBridgeString(value: string): string {
    return value
      .replace(/[A-Za-z]:\\[^\s"'`]+/g, '[redacted-path]')
      .replace(/\/(?:[^/\s"'`]+\/)*[^/\s"'`]+/g, (match) => {
        if (match.startsWith('//')) {
          return match;
        }
        return '[redacted-path]';
      });
  }

  private sanitizeBridgePayload(value: unknown, contextKey?: string): unknown {
    if (typeof value === 'string') {
      if (contextKey && ['cwd', 'path', 'filePath', 'resolvedPath', 'sessionKey'].includes(contextKey)) {
        return '[redacted]';
      }
      return this.redactSensitiveBridgeString(value);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.sanitizeBridgePayload(item, contextKey));
    }
    if (value && typeof value === 'object') {
      const sanitizedEntries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
        if (['cwd', 'path', 'filePath', 'resolvedPath', 'sessionKey'].includes(key)) {
          return [key, '[redacted]'];
        }
        return [key, this.sanitizeBridgePayload(entryValue, key)];
      });
      return Object.fromEntries(sanitizedEntries);
    }
    return value;
  }

  private sanitizeBridgePayloadString(value: unknown): string {
    try {
      return JSON.stringify(this.sanitizeBridgePayload(value), null, 2);
    } catch {
      return '';
    }
  }

  private getEffectiveBridgeSessionMode(binding: AgentBridgeBinding | null): AgentBridgeSessionMode | null {
    if (!binding) {
      return null;
    }
    if (binding.sessionMode) {
      return binding.sessionMode;
    }
    return binding.lobsterSessionId.startsWith('text-fast:')
      ? 'text-fast'
      : 'agent';
  }

  private resolveBridgeMode(
    airiSessionId: string,
    options: {
      requestedMode?: AgentBridgeRequestMode;
      skillIds?: string[];
      fileIds?: string[];
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
    },
  ): { mode?: AgentBridgeSessionMode; error?: { status: number; message: string; code: string } } {
    const requestedMode = options.requestedMode ?? 'auto';
    const binding = this.bridgeSessions.get(airiSessionId);
    const lockedMode = this.getEffectiveBridgeSessionMode(binding);
    const hasAdvancedCapabilities = Boolean(
      options.skillIds?.length
      || options.fileIds?.length
      || options.imageAttachments?.length
      || this.listPendingPermissions(airiSessionId).length,
    );

    const desiredMode: AgentBridgeSessionMode = requestedMode === 'auto'
      ? (hasAdvancedCapabilities ? 'agent' : 'text-fast')
      : requestedMode;

    if (desiredMode === 'text-fast' && hasAdvancedCapabilities) {
      return {
        error: {
          status: 409,
          message: 'Current request requires bridge agent mode because it uses files, images, skills, or pending permissions.',
          code: 'bridge_capability_required',
        },
      };
    }

    if (lockedMode === 'text-fast' && desiredMode === 'agent') {
      return { mode: 'agent' };
    }

    if (lockedMode === 'agent' && desiredMode === 'text-fast') {
      return { mode: 'agent' };
    }

    if (lockedMode && lockedMode !== desiredMode) {
      return {
        error: {
          status: 409,
          message: `Bridge session is locked to ${lockedMode} mode. Start a new chat session to switch modes.`,
          code: 'bridge_mode_locked',
        },
      };
    }

    return { mode: lockedMode ?? desiredMode };
  }

  private buildAgentUpgradePrompt(airiSessionId: string, userPrompt: string): string {
    const transcript = this.bridgeSessions.listTextMessages(airiSessionId);
    if (transcript.length === 0) {
      return userPrompt;
    }
    const history = transcript
      .map(message => `${message.role === 'assistant' ? '助手' : '用户'}: ${message.content}`)
      .join('\n');
    return [
      '以下是当前会话在纯文本快速模式下的历史对话，请将这些内容视为同一会话上下文继续处理。',
      '<conversation_history>',
      history,
      '</conversation_history>',
      '',
      '当前用户请求：',
      userPrompt,
    ].join('\n');
  }

  private buildPermissionResult(
    permission: {
      toolName: string;
      toolInput: Record<string, unknown>;
    },
    decision: 'allow' | 'deny',
  ): PermissionResult {
    if (decision === 'deny') {
      return {
        behavior: 'deny',
        message: 'Permission denied by user',
      };
    }

    if (permission.toolName !== 'AskUserQuestion') {
      return {
        behavior: 'allow',
        updatedInput: permission.toolInput,
      };
    }

    const rawQuestions = Array.isArray(permission.toolInput?.questions)
      ? permission.toolInput.questions as BridgeQuestion[]
      : [];
    const answers: Record<string, string> = {};

    for (const question of rawQuestions) {
      const questionKey = typeof question?.question === 'string' && question.question.trim()
        ? question.question.trim()
        : typeof question?.header === 'string' && question.header.trim()
          ? question.header.trim()
          : '';
      if (!questionKey) {
        continue;
      }
      const options = Array.isArray(question?.options) ? question.options : [];
      const preferredOption = options.find(option => option?.label === '允许本次操作')
        || options[0];
      if (typeof preferredOption?.label === 'string' && preferredOption.label.trim()) {
        answers[questionKey] = preferredOption.label.trim();
      }
    }

    return {
      behavior: 'allow',
      updatedInput: {
        ...(permission.toolInput || {}),
        answers,
      },
    };
  }

  private getOrCreateTextFastBinding(airiSessionId: string): AgentBridgeBinding {
    const existing = this.bridgeSessions.get(airiSessionId);
    if (existing) {
      this.bridgeSessions.bind(airiSessionId, existing.lobsterSessionId, 'text-fast');
      this.bridgeSessions.touch(airiSessionId);
      return this.bridgeSessions.get(airiSessionId)!;
    }
    return this.bridgeSessions.bind(airiSessionId, `text-fast:${airiSessionId}`, 'text-fast');
  }

  private getBridgeRunnerSessionCwd(lobsterSessionId: string): string {
    const runner = this.getCoworkRunner();
    const store = runner?.store;
    if (store && typeof store.getSession === 'function') {
      const session = store.getSession(lobsterSessionId);
      if (session?.cwd && typeof session.cwd === 'string') {
        return path.resolve(session.cwd);
      }
    }
    return path.resolve(process.cwd());
  }

  private getBridgeUploadTargetPath(airiSessionId: string, fileId: string, safeName: string, lobsterSessionId: string): string {
    const sessionCwd = this.getBridgeRunnerSessionCwd(lobsterSessionId);
    const uploadDir = path.join(sessionCwd, BRIDGE_UPLOADS_DIRNAME, airiSessionId, fileId);
    fs.mkdirSync(uploadDir, { recursive: true });
    return path.join(uploadDir, safeName);
  }

  private serializeBridgeFile(file: AgentBridgeInputFile, sourceFileId?: string): Record<string, unknown> {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size ?? 0,
      sourceFileId,
    };
  }

  private issueReattachedBridgeFile(sourceFile: AgentBridgeFileBinding, clientTurnId: string): AgentBridgeInputFile {
    const reattachedFileId = uuidv4();
    this.bridgeSessions.bindFile({
      ...sourceFile,
      id: reattachedFileId,
      clientTurnId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return {
      id: reattachedFileId,
      name: sourceFile.name,
      mimeType: sourceFile.mimeType,
      size: sourceFile.size,
      path: sourceFile.path,
    };
  }

  private resolveBridgeInputFiles(
    airiSessionId: string,
    lobsterSessionId: string,
    clientTurnId: string | undefined,
    fileIds: string[] = [],
  ): { files: AgentBridgeInputFile[]; missingFileIds: string[] } {
    const files: AgentBridgeInputFile[] = [];
    const missingFileIds: string[] = [];

    for (const fileId of fileIds) {
      const file = this.bridgeSessions.getFile(fileId);
      if (
        !file
        || file.airiSessionId !== airiSessionId
        || file.lobsterSessionId !== lobsterSessionId
        || (clientTurnId && file.clientTurnId && file.clientTurnId !== clientTurnId)
        || !fs.existsSync(file.path)
      ) {
        missingFileIds.push(fileId);
        continue;
      }
      files.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        path: file.path,
      });
    }

    return { files, missingFileIds };
  }

  private buildTextFastMessages(
    airiSessionId: string,
    userPrompt: string,
    systemPrompt?: string,
  ): AgentChatRequest['messages'] {
    const messages: AgentChatRequest['messages'] = [];
    const normalizedSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    if (normalizedSystemPrompt) {
      messages.push({ role: 'system', content: normalizedSystemPrompt });
    }
    for (const message of this.bridgeSessions.listTextMessages(airiSessionId)) {
      messages.push({
        role: message.role,
        content: message.content,
      });
    }
    messages.push({ role: 'user', content: userPrompt });
    return messages;
  }

  private getOrCreateBridgeBinding(runner: any, airiSessionId: string): { lobsterSessionId: string; isNew: boolean; upgradedFromTextFast: boolean } {
    const existing = this.bridgeSessions.get(airiSessionId);
    if (existing) {
      if (!this.hasRunnerSession(runner, existing.lobsterSessionId)) {
        const lobsterSessionId = this.createRunnerSession(runner);
        const upgradedFromTextFast = existing.sessionMode === 'text-fast';
        this.bridgeSessions.bind(airiSessionId, lobsterSessionId, 'agent', { replaceSessionMode: upgradedFromTextFast });
        return { lobsterSessionId, isNew: true, upgradedFromTextFast };
      }
      this.bridgeSessions.bind(airiSessionId, existing.lobsterSessionId, 'agent');
      this.bridgeSessions.touch(airiSessionId);
      return { lobsterSessionId: existing.lobsterSessionId, isNew: false, upgradedFromTextFast: false };
    }
    const lobsterSessionId = this.createRunnerSession(runner);
    this.bridgeSessions.bind(airiSessionId, lobsterSessionId, 'agent');
    return { lobsterSessionId, isNew: true, upgradedFromTextFast: false };
  }

  private resolvePermissionStatus(airiSessionId: string, requestId: string): { status: 'pending' | 'expired' | 'not_found'; capabilityToken?: string; expiresAt?: number } {
    const permission = this.bridgeSessions.getPermission(requestId);
    if (!permission || permission.airiSessionId !== airiSessionId) {
      return { status: 'not_found' };
    }
    const expiresAt = permission.createdAt + BRIDGE_PERMISSION_TTL_MS;
    if (Date.now() > expiresAt) {
      this.bridgeSessions.deletePermission(requestId);
      return { status: 'expired', expiresAt };
    }
    return { status: 'pending', capabilityToken: permission.capabilityToken, expiresAt };
  }

  private listPendingPermissions(airiSessionId: string): Array<{
    requestId: string;
    capabilityToken: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    createdAt: number;
    expiresAt: number;
    turnId: string;
  }> {
    const permissions = this.bridgeSessions.listPermissions(airiSessionId);
    const now = Date.now();
    const pending: Array<{
      requestId: string;
      capabilityToken: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      createdAt: number;
      expiresAt: number;
      turnId: string;
    }> = [];
    for (const permission of permissions) {
      const expiresAt = permission.createdAt + BRIDGE_PERMISSION_TTL_MS;
      if (now > expiresAt) {
        this.bridgeSessions.deletePermission(permission.requestId);
        continue;
      }
      pending.push({
        requestId: permission.requestId,
        capabilityToken: permission.capabilityToken,
        toolName: permission.toolName,
        toolInput: this.sanitizeBridgePayload(permission.toolInput) as Record<string, unknown>,
        createdAt: permission.createdAt,
        expiresAt,
        turnId: permission.turnId,
      });
    }
    return pending;
  }

  private async handleBridgeBind(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const parsed = await this.readRequestBody(req) as AgentBridgeBindRequest | null;
    if (!parsed?.airiSessionId?.trim()) {
      sendError(res, 400, 'Missing airiSessionId');
      return;
    }
    const runner = this.getCoworkRunner();
    if (!runner) {
      sendError(res, 503, 'CoworkRunner not available');
      return;
    }
    const binding = this.getOrCreateBridgeBinding(runner, parsed.airiSessionId.trim());
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({
      session: {
        airiSessionId: parsed.airiSessionId.trim(),
        lobsterSessionId: binding.lobsterSessionId,
        sessionMode: this.getEffectiveBridgeSessionMode(this.bridgeSessions.get(parsed.airiSessionId.trim())),
      },
    }));
  }

  private async handleSetSkillEnabled(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const manager = this.getSkillManager();
    if (!manager || typeof manager.setSkillEnabled !== 'function') {
      sendError(res, 503, 'SkillManager not available');
      return;
    }
    const parsed = await this.readRequestBody(req);
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.enabled !== 'boolean') {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    try {
      const skills = manager.setSkillEnabled(parsed.id, parsed.enabled);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      });
      res.end(JSON.stringify({ skills }));
    } catch (error) {
      sendError(res, 400, String(error));
    }
  }

  private async handleGetSkillConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const manager = this.getSkillManager();
    if (!manager || typeof manager.getSkillConfig !== 'function') {
      sendError(res, 503, 'SkillManager not available');
      return;
    }
    const parsed = await this.readRequestBody(req);
    if (!parsed || typeof parsed.id !== 'string' || !parsed.id.trim()) {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    const result = manager.getSkillConfig(parsed.id.trim());
    if (!result?.success) {
      sendError(res, 400, String(result?.error || 'Get config failed'));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({ config: result.config || {} }));
  }

  private async handleSetSkillConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const manager = this.getSkillManager();
    if (!manager || typeof manager.setSkillConfig !== 'function') {
      sendError(res, 503, 'SkillManager not available');
      return;
    }
    const parsed = await this.readRequestBody(req);
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.config !== 'object' || !parsed.config) {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    const config = Object.fromEntries(
      Object.entries(parsed.config as Record<string, unknown>)
        .filter(([key, value]) => typeof key === 'string' && typeof value === 'string'),
    ) as Record<string, string>;
    const result = manager.setSkillConfig(parsed.id.trim(), config);
    if (!result?.success) {
      sendError(res, 400, String(result?.error || 'Set config failed'));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({ success: true }));
  }

  private async handleDownloadSkill(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const manager = this.getSkillManager();
    if (!manager || typeof manager.downloadSkill !== 'function') {
      sendError(res, 503, 'SkillManager not available');
      return;
    }
    const parsed = await this.readRequestBody(req);
    if (!parsed || typeof parsed.source !== 'string' || !parsed.source.trim()) {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    const result = await manager.downloadSkill(parsed.source.trim());
    if (!result?.success) {
      sendError(res, 400, String(result?.error || 'Download skill failed'));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify(result));
  }

  private async handleConfirmInstall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const manager = this.getSkillManager();
    if (!manager || typeof manager.confirmPendingInstall !== 'function') {
      sendError(res, 503, 'SkillManager not available');
      return;
    }
    const parsed = await this.readRequestBody(req);
    if (!parsed || typeof parsed.pendingInstallId !== 'string' || typeof parsed.action !== 'string') {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    const action = parsed.action;
    if (!['install', 'installDisabled', 'cancel'].includes(action)) {
      sendError(res, 400, 'Invalid install action');
      return;
    }
    const result = manager.confirmPendingInstall(parsed.pendingInstallId.trim(), action);
    if (!result?.success) {
      sendError(res, 400, String(result?.error || 'Confirm install failed'));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify(result));
  }

  private async handleUploadFile(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const parsed = await this.readRequestBody(req) as AgentUploadFileRequest | null;
    if (!parsed || typeof parsed.airiSessionId !== 'string' || typeof parsed.name !== 'string' || typeof parsed.base64Data !== 'string') {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    const airiSessionId = parsed.airiSessionId.trim();
    let binding = this.bridgeSessions.get(airiSessionId);
    if (!airiSessionId || !binding) {
      sendError(res, 400, 'Unknown bridge session');
      return;
    }
    if (this.getEffectiveBridgeSessionMode(binding) === 'text-fast') {
      const runner = this.getCoworkRunner();
      if (!runner) {
        sendError(res, 503, 'CoworkRunner not available');
        return;
      }
      const upgradedBinding = this.getOrCreateBridgeBinding(runner, airiSessionId);
      binding = this.bridgeSessions.get(airiSessionId);
      if (!binding || upgradedBinding.lobsterSessionId !== binding.lobsterSessionId) {
        sendError(res, 500, 'Failed to upgrade bridge session for file upload');
        return;
      }
    }
    const safeName = path.basename(parsed.name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file.bin';
    const base64Data = parsed.base64Data.trim();
    if (!base64Data) {
      sendError(res, 400, 'Empty file data');
      return;
    }
    const buffer = Buffer.from(base64Data, 'base64');
    if (!buffer.length) {
      sendError(res, 400, 'Invalid base64 data');
      return;
    }
    if (buffer.length > 25 * 1024 * 1024) {
      sendError(res, 413, 'File too large');
      return;
    }
    const fileId = uuidv4();
    const fullPath = this.getBridgeUploadTargetPath(airiSessionId, fileId, safeName, binding.lobsterSessionId);
    fs.writeFileSync(fullPath, buffer);
    this.bridgeSessions.bindFile({
      id: fileId,
      airiSessionId,
      lobsterSessionId: binding.lobsterSessionId,
      clientTurnId: typeof parsed.clientTurnId === 'string' && parsed.clientTurnId.trim() ? parsed.clientTurnId.trim() : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      name: safeName,
      mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : 'application/octet-stream',
      path: fullPath,
      size: buffer.length,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({
      file: {
        id: fileId,
        name: safeName,
        mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : 'application/octet-stream',
        size: buffer.length,
      },
    }));
  }

  private async handleReattachFiles(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const parsed = await this.readRequestBody(req) as AgentReattachFilesRequest | null;
    if (!parsed || typeof parsed.airiSessionId !== 'string' || !Array.isArray(parsed.historyFileIds) || parsed.historyFileIds.length === 0) {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    const airiSessionId = parsed.airiSessionId.trim();
    const clientTurnId = typeof parsed.clientTurnId === 'string' && parsed.clientTurnId.trim()
      ? parsed.clientTurnId.trim()
      : '';
    let binding = this.bridgeSessions.get(airiSessionId);
    if (!airiSessionId || !binding) {
      sendError(res, 400, 'Unknown bridge session');
      return;
    }
    if (!clientTurnId) {
      sendError(res, 400, 'Missing clientTurnId');
      return;
    }
    if (this.getEffectiveBridgeSessionMode(binding) === 'text-fast') {
      const runner = this.getCoworkRunner();
      if (!runner) {
        sendError(res, 503, 'CoworkRunner not available');
        return;
      }
      const upgradedBinding = this.getOrCreateBridgeBinding(runner, airiSessionId);
      binding = this.bridgeSessions.get(airiSessionId);
      if (!binding || upgradedBinding.lobsterSessionId !== binding.lobsterSessionId) {
        sendError(res, 500, 'Failed to upgrade bridge session for file reattach');
        return;
      }
    }
    const reattachedFiles: AgentBridgeInputFile[] = [];
    for (const rawHistoryFileId of parsed.historyFileIds) {
      const historyFileId = typeof rawHistoryFileId === 'string' ? rawHistoryFileId.trim() : '';
      const sourceFile = this.bridgeSessions.getFile(historyFileId);
      if (!historyFileId || !sourceFile || sourceFile.airiSessionId !== airiSessionId || sourceFile.lobsterSessionId !== binding.lobsterSessionId || !fs.existsSync(sourceFile.path)) {
        sendError(res, 409, `Missing or invalid bridge file references: ${historyFileId || rawHistoryFileId}`, 'bridge_file_missing');
        return;
      }
      reattachedFiles.push(this.issueReattachedBridgeFile(sourceFile, clientTurnId));
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({
      files: reattachedFiles.map((file, index) => this.serializeBridgeFile(file, parsed.historyFileIds[index])),
    }));
  }

  private async handleBridgePermission(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const parsed = await this.readRequestBody(req) as AgentBridgePermissionRequest | null;
    if (!parsed?.airiSessionId?.trim() || !parsed?.requestId?.trim() || !parsed?.capabilityToken?.trim() || !parsed?.decision) {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    const airiSessionId = parsed.airiSessionId.trim();
    const requestId = parsed.requestId.trim();
    const permissionStatus = this.resolvePermissionStatus(airiSessionId, requestId);
    if (permissionStatus.status === 'expired') {
      sendError(res, 410, 'Permission request expired');
      return;
    }
    const permission = this.bridgeSessions.consumePermission(requestId, airiSessionId, parsed.capabilityToken.trim());
    if (!permission) {
      sendError(res, 404, 'Permission request not found');
      return;
    }
    const runner = this.getCoworkRunner();
    if (!runner || typeof runner.respondToPermission !== 'function') {
      sendError(res, 503, 'CoworkRunner not available');
      return;
    }
    runner.respondToPermission(requestId, this.buildPermissionResult(permission, parsed.decision === 'allow' ? 'allow' : 'deny'));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleBridgePermissionStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const parsed = await this.readRequestBody(req) as AgentBridgePermissionStatusRequest | null;
    if (!parsed?.airiSessionId?.trim() || !parsed?.requestId?.trim()) {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    const status = this.resolvePermissionStatus(parsed.airiSessionId.trim(), parsed.requestId.trim());
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify(status));
  }

  private async handleBridgePermissionList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const parsed = await this.readRequestBody(req) as AgentBridgePermissionListRequest | null;
    if (!parsed?.airiSessionId?.trim()) {
      sendError(res, 400, 'Invalid payload');
      return;
    }
    const permissions = this.listPendingPermissions(parsed.airiSessionId.trim());
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({ permissions }));
  }

  private async handleBridgeChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }

    const parsed = await this.readRequestBody(req) as AgentBridgeChatRequest | null;
    if (!parsed?.airiSessionId?.trim()) {
      sendError(res, 400, 'Missing airiSessionId');
      return;
    }
    const { messages, skillIds = [], fileIds = [], systemPrompt, sessionMode, clientTurnId } = parsed;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      sendError(res, 400, 'Missing messages');
      return;
    }
    const { prompt: rawUserPrompt, imageAttachments } = parsePromptAndAttachments(messages);
    if (!rawUserPrompt && imageAttachments.length === 0 && fileIds.length === 0) {
      sendError(res, 400, 'Missing message content');
      return;
    }

    const airiSessionId = parsed.airiSessionId.trim();
    const turnId = uuidv4();
    const requestStartedAt = Date.now();
    const resolvedMode = this.resolveBridgeMode(airiSessionId, {
      requestedMode: sessionMode,
      skillIds,
      fileIds,
      imageAttachments,
    });
    if (resolvedMode.error) {
      sendError(res, resolvedMode.error.status, resolvedMode.error.message, resolvedMode.error.code);
      return;
    }

    if (resolvedMode.mode === 'text-fast') {
      writeSSEHeaders(res);
      const binding = this.getOrCreateTextFastBinding(airiSessionId);
      let firstStateAt: number | null = null;
      let firstAssistantDeltaAt: number | null = null;

      this.writeBridgeEvent(res, this.createBridgeEvent({
        type: 'session.bound',
        sessionId: airiSessionId,
        turnId,
        lobsterSessionId: binding.lobsterSessionId,
        sessionMode: 'text-fast',
      }));
      this.emitBridgeStateChanged(res, airiSessionId, turnId, 'think');
      firstStateAt = Date.now();

      try {
        const directMessages = this.buildTextFastMessages(airiSessionId, rawUserPrompt, systemPrompt);
        const response = await requestDirectProviderChat(directMessages, async (delta) => {
          if (firstAssistantDeltaAt === null) {
            firstAssistantDeltaAt = Date.now();
          }
          this.writeBridgeEvent(res, this.createBridgeEvent({
            type: 'assistant.delta',
            sessionId: airiSessionId,
            turnId,
            text: delta,
          }));
        });

        this.bridgeSessions.appendTextMessage(airiSessionId, {
          role: 'user',
          content: rawUserPrompt,
        });
        this.bridgeSessions.appendTextMessage(airiSessionId, {
          role: 'assistant',
          content: response.content,
        });

        this.emitBridgeStateChanged(res, airiSessionId, turnId, 'success');
        this.writeBridgeEvent(res, this.createBridgeEvent({
          type: 'assistant.final',
          sessionId: airiSessionId,
          turnId,
          text: response.content,
        }));
        this.writeBridgeEvent(res, this.createBridgeEvent({
          type: 'done',
          sessionId: airiSessionId,
          turnId,
        }));
        this.logBridgeMetrics({
          airiSessionId,
          turnId,
          mode: 'text-fast',
          startedAt: requestStartedAt,
          firstStateAt,
          firstAssistantDeltaAt: firstAssistantDeltaAt ?? Date.now(),
          completedAt: Date.now(),
          outcome: 'success',
          assistantChars: response.content.length,
          skillCount: skillIds.length,
          fileCount: fileIds.length,
          imageCount: imageAttachments.length,
        });
        sendSSEDone(res);
        return;
      } catch (error) {
        const message = String(error);
        this.emitBridgeStateChanged(res, airiSessionId, turnId, 'error', { reason: message });
        this.writeBridgeEvent(res, this.createBridgeEvent({
          type: 'error',
          sessionId: airiSessionId,
          turnId,
          message,
          code: 'bridge_text_fast_failed',
        }));
        this.logBridgeMetrics({
          airiSessionId,
          turnId,
          mode: 'text-fast',
          startedAt: requestStartedAt,
          firstStateAt,
          firstAssistantDeltaAt,
          completedAt: Date.now(),
          outcome: 'error',
          assistantChars: 0,
          skillCount: skillIds.length,
          fileCount: fileIds.length,
          imageCount: imageAttachments.length,
          errorCode: 'bridge_text_fast_failed',
        });
        sendSSEDone(res);
        return;
      }
    }

    const runner = this.getCoworkRunner();
    if (!runner) {
      sendError(res, 503, 'CoworkRunner not available');
      return;
    }

    const binding = this.getOrCreateBridgeBinding(runner, airiSessionId);
    const lobsterSessionId = binding.lobsterSessionId;
    const normalizedClientTurnId = typeof clientTurnId === 'string' && clientTurnId.trim() ? clientTurnId.trim() : undefined;
    const resolvedBridgeFiles = this.resolveBridgeInputFiles(airiSessionId, lobsterSessionId, normalizedClientTurnId, fileIds);
    if (resolvedBridgeFiles.missingFileIds.length > 0) {
      sendError(res, 409, `Missing or invalid bridge file references: ${resolvedBridgeFiles.missingFileIds.join(', ')}`, 'bridge_file_missing');
      return;
    }
    const userPrompt = rawUserPrompt || (resolvedBridgeFiles.files.length > 0 ? '请先查看我上传的输入文件并回答问题。' : rawUserPrompt);
    const effectiveUserPrompt = binding.upgradedFromTextFast
      ? this.buildAgentUpgradePrompt(airiSessionId, userPrompt)
      : userPrompt;
    const assistantMessageIds = new Set<string>();
    const thinkingMessageIds = new Set<string>();
    const messageOffsets = new Map<string, number>();
    let fullAssistantText = '';
    let fullThinkingText = '';
    let hasError = false;
    let isCompleted = false;
    let firstStateAt: number | null = null;
    let firstAssistantDeltaAt: number | null = null;
    let bridgeErrorCode: string | undefined;
    writeSSEHeaders(res);

    this.writeBridgeEvent(res, this.createBridgeEvent({
      type: 'session.bound',
      sessionId: airiSessionId,
      turnId,
      lobsterSessionId,
      sessionMode: this.getEffectiveBridgeSessionMode(this.bridgeSessions.get(airiSessionId)) ?? 'agent',
    }));

    const onMessage = (sid: string, message: CoworkMessage) => {
      if (sid !== lobsterSessionId) return;
      const content = typeof message.content === 'string' ? message.content : '';
      if (message.type === 'assistant' && message.metadata?.isThinking) {
        thinkingMessageIds.add(message.id);
        messageOffsets.set(message.id, content.length);
        fullThinkingText = content;
        const initialThinking = this.redactSensitiveBridgeString(content).trim();
        if (initialThinking) {
          this.writeBridgeEvent(res, this.createBridgeEvent({
            type: 'reasoning.delta',
            sessionId: airiSessionId,
            turnId,
            text: initialThinking,
          }));
        }
        return;
      }
      if (message.type === 'assistant') {
        const visibleContent = sanitizeAssistantVisibleText(content);
        assistantMessageIds.add(message.id);
        messageOffsets.set(message.id, visibleContent.length);
        fullAssistantText = visibleContent;
        if (visibleContent) {
          if (firstAssistantDeltaAt === null) {
            firstAssistantDeltaAt = Date.now();
          }
          this.writeBridgeEvent(res, this.createBridgeEvent({
            type: 'assistant.delta',
            sessionId: airiSessionId,
            turnId,
            text: visibleContent,
          }));
        }
        return;
      }
      if (message.type === 'tool_use') {
        const sanitizedToolInput = this.sanitizeBridgePayload(message.metadata?.toolInput || {});
        let toolArguments = this.redactSensitiveBridgeString(content);
        try {
          toolArguments = JSON.stringify(sanitizedToolInput, null, 2);
        } catch {}
        this.emitBridgeStateChanged(res, airiSessionId, turnId, 'tool_use', {
          toolName: message.metadata?.toolName || undefined,
        });
        this.writeBridgeEvent(res, this.createBridgeEvent({
          type: 'tool.call',
          sessionId: airiSessionId,
          turnId,
          toolCallId: message.metadata?.toolUseId || `call_${message.id}`,
          name: message.metadata?.toolName || '',
          arguments: toolArguments,
        }));
        return;
      }
      if (message.type === 'tool_result') {
        this.emitBridgeStateChanged(res, airiSessionId, turnId, 'think');
        this.writeBridgeEvent(res, this.createBridgeEvent({
          type: 'tool.result',
          sessionId: airiSessionId,
          turnId,
          toolCallId: message.metadata?.toolUseId || `call_${message.id}`,
          result: this.redactSensitiveBridgeString(content),
          isError: !!message.metadata?.isError,
        }));
      }
    };

    const onMessageUpdate = (sid: string, messageId: string, content: string) => {
      if (sid !== lobsterSessionId) return;
      const previousLength = messageOffsets.get(messageId) || 0;
      const normalizedContent = typeof content === 'string' ? content : '';
      const visibleContent = assistantMessageIds.has(messageId)
        ? sanitizeAssistantVisibleText(normalizedContent)
        : normalizedContent;
      const nextLength = visibleContent.length;
      if (nextLength <= previousLength) {
        messageOffsets.set(messageId, nextLength);
        return;
      }
      const deltaContent = visibleContent.slice(previousLength);
      messageOffsets.set(messageId, nextLength);
      if (!deltaContent) return;
      if (thinkingMessageIds.has(messageId)) {
        fullThinkingText = normalizedContent;
        this.writeBridgeEvent(res, this.createBridgeEvent({
          type: 'reasoning.delta',
          sessionId: airiSessionId,
          turnId,
          text: this.redactSensitiveBridgeString(deltaContent),
        }));
        return;
      }
      if (assistantMessageIds.has(messageId)) {
        fullAssistantText = visibleContent;
        if (firstAssistantDeltaAt === null) {
          firstAssistantDeltaAt = Date.now();
        }
        this.writeBridgeEvent(res, this.createBridgeEvent({
          type: 'assistant.delta',
          sessionId: airiSessionId,
          turnId,
          text: deltaContent,
        }));
      }
    };

    const onPermissionRequest = (sid: string, request: { requestId: string; toolName: string; toolInput: Record<string, unknown> }) => {
      if (sid !== lobsterSessionId) return;
      const capabilityToken = uuidv4();
      this.bridgeSessions.bindPermission({
        requestId: request.requestId,
        capabilityToken,
        airiSessionId,
        lobsterSessionId,
        turnId,
        toolName: request.toolName,
        toolInput: request.toolInput || {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      this.emitBridgeStateChanged(res, airiSessionId, turnId, 'ask_user', {
        toolName: request.toolName,
      });
      const sanitizedToolInput = this.sanitizeBridgePayload(request.toolInput || {}) as Record<string, unknown>;
      this.writeBridgeEvent(res, this.createBridgeEvent({
        type: 'permission.request',
        sessionId: airiSessionId,
        turnId,
        requestId: request.requestId,
        capabilityToken,
        toolName: request.toolName,
        toolInput: sanitizedToolInput,
        expiresAt: Date.now() + BRIDGE_PERMISSION_TTL_MS,
      }));
    };

    const onComplete = (sid: string) => {
      if (sid !== lobsterSessionId) return;
      isCompleted = true;
    };

    runner.on('message', onMessage);
    runner.on('messageUpdate', onMessageUpdate);
    runner.on('permissionRequest', onPermissionRequest);
    runner.on('complete', onComplete);

    try {
      this.emitStateChanged(lobsterSessionId, turnId, 'think');
      this.emitBridgeStateChanged(res, airiSessionId, turnId, 'think');
      firstStateAt = Date.now();
      if (binding.isNew) {
        await this.startRunnerSession(runner, lobsterSessionId, effectiveUserPrompt, imageAttachments, skillIds, systemPrompt, resolvedBridgeFiles.files);
      }
      else {
        await this.continueRunnerSession(runner, lobsterSessionId, effectiveUserPrompt, imageAttachments, skillIds, systemPrompt, resolvedBridgeFiles.files);
      }

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (isCompleted) {
            clearInterval(checkInterval);
            resolve();
            return;
          }
          const status = this.getRunnerSessionStatus(runner, lobsterSessionId);
          if (status === 'completed' || status === 'error' || status === 'idle') {
            clearInterval(checkInterval);
            resolve();
          }
        }, 500);

        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 60000);
      });
    }
    catch (error) {
      const message = String(error);
      hasError = true;
      console.error('[AgentApiServer] Bridge cowork error:', error);
      this.emitStateChanged(lobsterSessionId, turnId, 'error', { reason: message });
      this.emitBridgeStateChanged(res, airiSessionId, turnId, 'error', { reason: message });
      bridgeErrorCode = isRateLimitErrorMessage(message) ? 'bridge_agent_rate_limited' : 'bridge_agent_failed';
      this.writeBridgeEvent(res, this.createBridgeEvent({
        type: 'error',
        sessionId: airiSessionId,
        turnId,
        message,
        code: bridgeErrorCode,
      }));
    }
    finally {
      runner.off('message', onMessage);
      runner.off('messageUpdate', onMessageUpdate);
      runner.off('permissionRequest', onPermissionRequest);
      runner.off('complete', onComplete);
      if (!hasError) {
        this.emitStateChanged(lobsterSessionId, turnId, 'success');
        this.emitBridgeStateChanged(res, airiSessionId, turnId, 'success');
        if (fullThinkingText.trim()) {
          this.writeBridgeEvent(res, this.createBridgeEvent({
            type: 'reasoning.final',
            sessionId: airiSessionId,
            turnId,
            text: this.redactSensitiveBridgeString(fullThinkingText.trim()),
          }));
        }
        fullAssistantText = sanitizeAssistantVisibleText(fullAssistantText);
        this.writeBridgeEvent(res, this.createBridgeEvent({
          type: 'assistant.final',
          sessionId: airiSessionId,
          turnId,
          text: fullAssistantText,
        }));
      }
      this.writeBridgeEvent(res, this.createBridgeEvent({
        type: 'done',
        sessionId: airiSessionId,
        turnId,
      }));
      this.logBridgeMetrics({
        airiSessionId,
        turnId,
        mode: 'agent',
        startedAt: requestStartedAt,
        firstStateAt,
        firstAssistantDeltaAt,
        completedAt: Date.now(),
        outcome: hasError ? 'error' : 'success',
        assistantChars: fullAssistantText.length,
        skillCount: skillIds.length,
        fileCount: fileIds.length,
        imageCount: imageAttachments.length,
        errorCode: bridgeErrorCode,
      });
      sendSSEDone(res);
    }
  }

  private getRunnerSessionStatus(runner: any, sessionId: string): string | null {
    const store = runner?.store;
    if (store && typeof store.getSession === 'function') {
      const session = store.getSession(sessionId) as CoworkSession | null;
      return session?.status || null;
    }
    return null;
  }

  private cleanupRunnerSession(runner: any, sessionId: string): void {
    const store = runner?.store;
    if (store && typeof store.deleteSession === 'function') {
      try {
        store.deleteSession(sessionId);
      } catch (error) {
        console.warn('[AgentApiServer] Failed to delete session:', error);
      }
    }
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }

    const parsed = await this.readRequestBody(req) as AgentChatRequest | null;
    if (!parsed) {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    const { messages, stream = true, skillIds = [] } = parsed;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      sendError(res, 400, 'Missing messages');
      return;
    }

    const { prompt: userPrompt, imageAttachments } = parsePromptAndAttachments(messages);
    if (!userPrompt && imageAttachments.length === 0) {
      sendError(res, 400, 'Missing message content');
      return;
    }

    if (!stream) {
      await this.handleChatNoStream(req, res, messages, userPrompt, imageAttachments, skillIds);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Connection': 'keep-alive',
    });

    const runner = this.getCoworkRunner();
    if (!runner) {
      res.write(createSSEEvent({ error: 'CoworkRunner not available' }));
      res.end();
      return;
    }

    const sessionId = this.createRunnerSession(runner);
    const turnId = uuidv4();
    let messageCount = 0;
    let hasError = false;
    let responseModel = 'claude-agent';
    let fallbackRateLimitMessage = '';
    const messageUpdateOffsets = new Map<string, number>();
    const assistantMessageIds = new Set<string>();

    const onMessage = (sid: string, message: CoworkMessage) => {
      if (sid !== sessionId) return;
      messageCount++;

      if (message.type === 'assistant') {
        if (skillIds.length === 0 && imageAttachments.length === 0 && isRateLimitErrorMessage(message.content || '')) {
          fallbackRateLimitMessage = message.content || '';
          return;
        }
        assistantMessageIds.add(message.id);
        responseModel = 'claude-agent';
        res.write(createSSEEvent({
          id: `chat-${sessionId}`,
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: responseModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: message.content }, finish_reason: null }],
        }));
      } else if (message.type === 'tool_use') {
        this.emitStateChanged(sessionId, turnId, 'tool_use', {
          toolName: message.metadata?.toolName || undefined,
        });
        this.emitActTokenToStream(res, sessionId, 'awkward');
        res.write(createSSEEvent({
          id: `chat-${sessionId}`,
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: responseModel,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                id: message.metadata?.toolUseId || `call_${messageCount}`,
                type: 'function',
                function: { name: message.metadata?.toolName || '', arguments: message.content },
              }],
            },
            finish_reason: null,
          }],
        }));
      } else if (message.type === 'tool_result') {
        this.emitStateChanged(sessionId, turnId, 'think');
        this.emitActTokenToStream(res, sessionId, 'think');
        res.write(createSSEEvent({
          id: `chat-${sessionId}`,
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: responseModel,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                id: message.metadata?.toolUseId || `call_${messageCount}`,
                type: 'function',
                function: { name: '', arguments: '' },
              }],
              content: message.content,
            },
            finish_reason: null,
          }],
        }));
      }
    };

    const onMessageUpdate = (sid: string, messageId: string, content: string) => {
      if (sid !== sessionId) return;
      if (!assistantMessageIds.has(messageId)) return;
      const previousLength = messageUpdateOffsets.get(messageId) || 0;
      const normalizedContent = typeof content === 'string' ? content : '';
      const nextLength = normalizedContent.length;
      if (nextLength <= previousLength) {
        messageUpdateOffsets.set(messageId, nextLength);
        return;
      }
      const deltaContent = normalizedContent.slice(previousLength);
      messageUpdateOffsets.set(messageId, nextLength);
      if (!deltaContent) return;
      res.write(createSSEEvent({
        id: `chat-${sessionId}`,
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: responseModel,
        choices: [{ index: 0, delta: { content: deltaContent }, finish_reason: null }],
      }));
    };

    runner.on('message', onMessage);
    runner.on('messageUpdate', onMessageUpdate);

    try {
      this.emitStateChanged(sessionId, turnId, 'think');
      this.emitActTokenToStream(res, sessionId, 'think');
      await this.startRunnerSession(runner, sessionId, userPrompt, imageAttachments, skillIds);

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          const status = this.getRunnerSessionStatus(runner, sessionId);
          if (status === 'completed' || status === 'error') {
            clearInterval(checkInterval);
            resolve();
          }
        }, 500);

        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 60000);
      });
      if (fallbackRateLimitMessage) {
        const fallback = await requestDirectProviderChat(messages);
        responseModel = fallback.model;
        res.write(createSSEEvent({
          id: `chat-${sessionId}`,
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: responseModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: fallback.content }, finish_reason: null }],
        }));
      }
    } catch (error) {
      const message = String(error);
      if (skillIds.length === 0 && imageAttachments.length === 0 && isRateLimitErrorMessage(message)) {
        try {
          const fallback = await requestDirectProviderChat(messages);
          responseModel = fallback.model;
          this.emitStateChanged(sessionId, turnId, 'success');
          this.emitActTokenToStream(res, sessionId, 'happy');
          res.write(createSSEEvent({
            id: `chat-${sessionId}`,
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: responseModel,
            choices: [{ index: 0, delta: { role: 'assistant', content: fallback.content }, finish_reason: null }],
          }));
        } catch (fallbackError) {
          hasError = true;
          console.error('[AgentApiServer] Cowork error:', error);
          console.error('[AgentApiServer] Direct provider fallback error:', fallbackError);
          this.emitStateChanged(sessionId, turnId, 'error', { reason: String(fallbackError) });
          this.emitActTokenToStream(res, sessionId, 'sad');
          res.write(createSSEEvent({ error: String(fallbackError) }));
        }
      } else {
        hasError = true;
        console.error('[AgentApiServer] Cowork error:', error);
        this.emitStateChanged(sessionId, turnId, 'error', { reason: message });
        this.emitActTokenToStream(res, sessionId, 'sad');
        res.write(createSSEEvent({ error: message }));
      }
    } finally {
      if (!hasError) {
        this.emitStateChanged(sessionId, turnId, 'success');
        this.emitActTokenToStream(res, sessionId, 'happy');
      }
      runner.off('message', onMessage);
      runner.off('messageUpdate', onMessageUpdate);
      this.cleanupRunnerSession(runner, sessionId);

      res.write(createSSEEvent({
        id: `chat-${sessionId}`,
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: responseModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }));

      sendSSEDone(res);
    }
  }

  private async handleChatNoStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    messages: AgentChatRequest['messages'],
    userPrompt: string,
    imageAttachments: Array<{ name: string; mimeType: string; base64Data: string }> = [],
    skillIds: string[] = [],
  ): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }

    const runner = this.getCoworkRunner();
    if (!runner) {
      sendError(res, 503, 'CoworkRunner not available');
      return;
    }

    const sessionId = this.createRunnerSession(runner);
    const turnId = uuidv4();
    let fullContent = '';
    let hasError = false;
    let responseModel = 'claude-agent';
    let fallbackRateLimitMessage = '';
    const assistantMessageIds = new Set<string>();

    const onMessage = (sid: string, message: CoworkMessage) => {
      if (sid !== sessionId) return;
      if (message.type === 'assistant') {
        if (skillIds.length === 0 && imageAttachments.length === 0 && isRateLimitErrorMessage(message.content || '')) {
          fallbackRateLimitMessage = message.content || '';
          return;
        }
        assistantMessageIds.add(message.id);
        fullContent = message.content;
        responseModel = 'claude-agent';
      }
    };

    const onMessageUpdate = (sid: string, messageId: string, content: string) => {
      if (sid !== sessionId) return;
      if (!assistantMessageIds.has(messageId)) return;
      if (typeof content === 'string') {
        fullContent = content;
      }
    };

    runner.on('message', onMessage);
    runner.on('messageUpdate', onMessageUpdate);

    try {
      this.emitStateChanged(sessionId, turnId, 'think');
      await this.startRunnerSession(runner, sessionId, userPrompt, imageAttachments, skillIds);

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          const status = this.getRunnerSessionStatus(runner, sessionId);
          if (status === 'completed' || status === 'error') {
            clearInterval(checkInterval);
            resolve();
          }
        }, 500);

        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 60000);
      });
      if (fallbackRateLimitMessage) {
        const fallback = await requestDirectProviderChat(messages);
        responseModel = fallback.model;
        fullContent = fallback.content;
      }
    } catch (error) {
      const message = String(error);
      if (skillIds.length === 0 && imageAttachments.length === 0 && isRateLimitErrorMessage(message)) {
        try {
          const fallback = await requestDirectProviderChat(messages);
          responseModel = fallback.model;
          fullContent = fallback.content;
        } catch (fallbackError) {
          hasError = true;
          console.error('[AgentApiServer] Cowork error:', error);
          console.error('[AgentApiServer] Direct provider fallback error:', fallbackError);
          this.emitStateChanged(sessionId, turnId, 'error', { reason: String(fallbackError) });
          fullContent = `Error: ${fallbackError}`;
        }
      } else {
        hasError = true;
        console.error('[AgentApiServer] Cowork error:', error);
        this.emitStateChanged(sessionId, turnId, 'error', { reason: message });
        fullContent = `Error: ${message}`;
      }
    } finally {
      if (!hasError) {
        this.emitStateChanged(sessionId, turnId, 'success');
      }
      runner.off('message', onMessage);
      runner.off('messageUpdate', onMessageUpdate);
      this.cleanupRunnerSession(runner, sessionId);
    }

    const response: AgentChatResponse = {
      id: `chat-${sessionId}`,
      object: 'chat.completion',
      created: Date.now(),
      model: responseModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: fullContent },
        finish_reason: 'stop',
      }],
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(response));
  }

  private handleModels(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'claude-agent', name: 'Claude Agent', object: 'model' },
      ],
      models: [
        { id: 'claude-agent', name: 'Claude Agent', object: 'model' },
      ],
    }));
  }

  private handleHealth(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ status: 'ok', server: 'lobster-agent' }));
  }
}

let agentApiServer: AgentApiServer | null = null;

export function createAgentApiServer(apiKey: string): AgentApiServer {
  agentApiServer = new AgentApiServer(apiKey);
  return agentApiServer;
}

export function getAgentApiServer(): AgentApiServer | null {
  return agentApiServer;
}
