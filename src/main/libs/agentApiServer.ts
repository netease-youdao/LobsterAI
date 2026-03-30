import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import { AgentBridgeSessionStore } from './agentBridgeSessionStore';

const AGENT_API_PORT = 19888;
const AGENT_API_HOST = '127.0.0.1';
const BRIDGE_PERMISSION_TTL_MS = 60_000;

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
  systemPrompt?: string;
}

interface AgentBridgePermissionRequest {
  airiSessionId: string;
  requestId: string;
  decision: 'allow' | 'deny';
}

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

function sendError(res: http.ServerResponse, code: number, message: string): void {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
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
  private uploadRoot: string;
  private bridgeSessions = new AgentBridgeSessionStore();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.uploadRoot = path.join(os.tmpdir(), 'lobster-agent-uploads');
    fs.mkdirSync(this.uploadRoot, { recursive: true });
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

  private async startRunnerSession(
    runner: any,
    sessionId: string,
    prompt: string,
    imageAttachments: Array<{ name: string; mimeType: string; base64Data: string }> = [],
    skillIds: string[] = [],
    systemPrompt?: string,
  ): Promise<void> {
    const normalizedSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    const store = runner?.store;
    if (normalizedSystemPrompt && store && typeof store.updateSession === 'function') {
      store.updateSession(sessionId, { systemPrompt: normalizedSystemPrompt });
    }
    if (typeof runner?.startCoworkSession === 'function') {
      await runner.startCoworkSession(sessionId, prompt, { imageAttachments, skillIds, systemPrompt: normalizedSystemPrompt || undefined });
      return;
    }
    if (typeof runner?.startSession === 'function') {
      await runner.startSession(sessionId, prompt, { confirmationMode: 'text', imageAttachments, skillIds, systemPrompt: normalizedSystemPrompt || undefined });
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
  ): Promise<void> {
    const normalizedSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    const store = runner?.store;
    if (normalizedSystemPrompt && store && typeof store.updateSession === 'function') {
      store.updateSession(sessionId, { systemPrompt: normalizedSystemPrompt });
    }
    if (typeof runner?.continueSession === 'function') {
      await runner.continueSession(sessionId, prompt, { imageAttachments, skillIds, systemPrompt: normalizedSystemPrompt || undefined });
      return;
    }
    await this.startRunnerSession(runner, sessionId, prompt, imageAttachments, skillIds, normalizedSystemPrompt || undefined);
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

  private getOrCreateBridgeBinding(runner: any, airiSessionId: string): { lobsterSessionId: string; isNew: boolean } {
    const existing = this.bridgeSessions.get(airiSessionId);
    if (existing) {
      this.bridgeSessions.touch(airiSessionId);
      return { lobsterSessionId: existing.lobsterSessionId, isNew: false };
    }
    const lobsterSessionId = this.createRunnerSession(runner);
    this.bridgeSessions.bind(airiSessionId, lobsterSessionId);
    return { lobsterSessionId, isNew: true };
  }

  private resolveBridgeFilePaths(airiSessionId: string, fileIds: string[] = []): string[] {
    const resolved: string[] = [];
    for (const fileId of fileIds) {
      const file = this.bridgeSessions.getFile(fileId);
      if (!file || file.airiSessionId !== airiSessionId) {
        continue;
      }
      resolved.push(file.path);
    }
    return resolved;
  }

  private resolvePermissionStatus(airiSessionId: string, requestId: string): { status: 'pending' | 'expired' | 'not_found'; expiresAt?: number } {
    const permission = this.bridgeSessions.getPermission(requestId);
    if (!permission || permission.airiSessionId !== airiSessionId) {
      return { status: 'not_found' };
    }
    const expiresAt = permission.createdAt + BRIDGE_PERMISSION_TTL_MS;
    if (Date.now() > expiresAt) {
      this.bridgeSessions.deletePermission(requestId);
      return { status: 'expired', expiresAt };
    }
    return { status: 'pending', expiresAt };
  }

  private listPendingPermissions(airiSessionId: string): Array<{
    requestId: string;
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
        toolName: permission.toolName,
        toolInput: permission.toolInput,
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
    const binding = this.bridgeSessions.get(airiSessionId);
    if (!airiSessionId || !binding) {
      sendError(res, 400, 'Unknown bridge session');
      return;
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
    const fullPath = path.join(this.uploadRoot, `${fileId}-${safeName}`);
    fs.writeFileSync(fullPath, buffer);
    this.bridgeSessions.bindFile({
      id: fileId,
      airiSessionId,
      lobsterSessionId: binding.lobsterSessionId,
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

  private async handleBridgePermission(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const parsed = await this.readRequestBody(req) as AgentBridgePermissionRequest | null;
    if (!parsed?.airiSessionId?.trim() || !parsed?.requestId?.trim() || !parsed?.decision) {
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
    const permission = this.bridgeSessions.consumePermission(requestId);
    if (!permission || permission.airiSessionId !== airiSessionId) {
      sendError(res, 404, 'Permission request not found');
      return;
    }
    const runner = this.getCoworkRunner();
    if (!runner || typeof runner.respondToPermission !== 'function') {
      sendError(res, 503, 'CoworkRunner not available');
      return;
    }
    runner.respondToPermission(requestId, parsed.decision === 'allow' ? 'allow' : 'deny');
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
    const { messages, skillIds = [], fileIds = [], systemPrompt } = parsed;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      sendError(res, 400, 'Missing messages');
      return;
    }
    const { prompt: rawUserPrompt, imageAttachments } = parsePromptAndAttachments(messages);
    const bridgeFilePaths = this.resolveBridgeFilePaths(parsed.airiSessionId.trim(), fileIds);
    const userPrompt = bridgeFilePaths.length > 0
      ? `${rawUserPrompt || '请先查看我上传的文件并回答问题。'}\n${bridgeFilePaths.map(filePath => `input file: ${filePath}`).join('\n')}`
      : rawUserPrompt;
    if (!userPrompt && imageAttachments.length === 0) {
      sendError(res, 400, 'Missing message content');
      return;
    }

    const runner = this.getCoworkRunner();
    if (!runner) {
      sendError(res, 503, 'CoworkRunner not available');
      return;
    }

    const airiSessionId = parsed.airiSessionId.trim();
    const binding = this.getOrCreateBridgeBinding(runner, airiSessionId);
    const lobsterSessionId = binding.lobsterSessionId;
    const turnId = uuidv4();
    const assistantMessageIds = new Set<string>();
    const thinkingMessageIds = new Set<string>();
    const messageOffsets = new Map<string, number>();
    let fullAssistantText = '';
    let fullThinkingText = '';
    let hasError = false;
    let isCompleted = false;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Connection': 'keep-alive',
    });

    this.writeBridgeEvent(res, this.createBridgeEvent({
      type: 'session.bound',
      sessionId: airiSessionId,
      turnId,
      lobsterSessionId,
    }));

    const onMessage = (sid: string, message: CoworkMessage) => {
      if (sid !== lobsterSessionId) return;
      const content = typeof message.content === 'string' ? message.content : '';
      if (message.type === 'assistant' && message.metadata?.isThinking) {
        thinkingMessageIds.add(message.id);
        messageOffsets.set(message.id, content.length);
        fullThinkingText = content;
        if (content) {
          this.writeBridgeEvent(res, this.createBridgeEvent({
            type: 'reasoning.delta',
            sessionId: airiSessionId,
            turnId,
            text: content,
          }));
        }
        return;
      }
      if (message.type === 'assistant') {
        assistantMessageIds.add(message.id);
        messageOffsets.set(message.id, content.length);
        fullAssistantText = content;
        if (content) {
          this.writeBridgeEvent(res, this.createBridgeEvent({
            type: 'assistant.delta',
            sessionId: airiSessionId,
            turnId,
            text: content,
          }));
        }
        return;
      }
      if (message.type === 'tool_use') {
        let toolArguments = content;
        try {
          toolArguments = JSON.stringify(message.metadata?.toolInput || {}, null, 2);
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
          result: content,
          isError: !!message.metadata?.isError,
        }));
      }
    };

    const onMessageUpdate = (sid: string, messageId: string, content: string) => {
      if (sid !== lobsterSessionId) return;
      const previousLength = messageOffsets.get(messageId) || 0;
      const normalizedContent = typeof content === 'string' ? content : '';
      const nextLength = normalizedContent.length;
      if (nextLength <= previousLength) {
        messageOffsets.set(messageId, nextLength);
        return;
      }
      const deltaContent = normalizedContent.slice(previousLength);
      messageOffsets.set(messageId, nextLength);
      if (!deltaContent) return;
      if (thinkingMessageIds.has(messageId)) {
        fullThinkingText = normalizedContent;
        this.writeBridgeEvent(res, this.createBridgeEvent({
          type: 'reasoning.delta',
          sessionId: airiSessionId,
          turnId,
          text: deltaContent,
        }));
        return;
      }
      if (assistantMessageIds.has(messageId)) {
        fullAssistantText = normalizedContent;
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
      this.bridgeSessions.bindPermission({
        requestId: request.requestId,
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
      this.writeBridgeEvent(res, this.createBridgeEvent({
        type: 'permission.request',
        sessionId: airiSessionId,
        turnId,
        requestId: request.requestId,
        toolName: request.toolName,
        toolInput: request.toolInput || {},
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
      if (binding.isNew) {
        await this.startRunnerSession(runner, lobsterSessionId, userPrompt, imageAttachments, skillIds, systemPrompt);
      }
      else {
        await this.continueRunnerSession(runner, lobsterSessionId, userPrompt, imageAttachments, skillIds, systemPrompt);
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
      hasError = true;
      const message = String(error);
      console.error('[AgentApiServer] Bridge cowork error:', error);
      this.emitStateChanged(lobsterSessionId, turnId, 'error', { reason: message });
      this.emitBridgeStateChanged(res, airiSessionId, turnId, 'error', { reason: message });
      this.writeBridgeEvent(res, this.createBridgeEvent({
        type: 'error',
        sessionId: airiSessionId,
        turnId,
        message,
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
        if (fullThinkingText) {
          this.writeBridgeEvent(res, this.createBridgeEvent({
            type: 'reasoning.final',
            sessionId: airiSessionId,
            turnId,
            text: fullThinkingText,
          }));
        }
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
      await this.handleChatNoStream(req, res, userPrompt, imageAttachments, skillIds);
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
    const messageUpdateOffsets = new Map<string, number>();
    const assistantMessageIds = new Set<string>();

    const onMessage = (sid: string, message: CoworkMessage) => {
      if (sid !== sessionId) return;
      messageCount++;

      if (message.type === 'assistant') {
        assistantMessageIds.add(message.id);
        res.write(createSSEEvent({
          id: `chat-${sessionId}`,
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'claude-agent',
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
          model: 'claude-agent',
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
          model: 'claude-agent',
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
        model: 'claude-agent',
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
    } catch (error) {
      hasError = true;
      console.error('[AgentApiServer] Cowork error:', error);
      this.emitStateChanged(sessionId, turnId, 'error', { reason: String(error) });
      this.emitActTokenToStream(res, sessionId, 'sad');
      res.write(createSSEEvent({ error: String(error) }));
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
        model: 'claude-agent',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }));

      sendSSEDone(res);
    }
  }

  private async handleChatNoStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
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
    const assistantMessageIds = new Set<string>();

    const onMessage = (sid: string, message: CoworkMessage) => {
      if (sid !== sessionId) return;
      if (message.type === 'assistant') {
        assistantMessageIds.add(message.id);
        fullContent = message.content;
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
    } catch (error) {
      hasError = true;
      console.error('[AgentApiServer] Cowork error:', error);
      this.emitStateChanged(sessionId, turnId, 'error', { reason: String(error) });
      fullContent = `Error: ${error}`;
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
      model: 'claude-agent',
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
