import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { CoworkMessage, CoworkSession } from '../coworkStore';

const AGENT_API_PORT = 19888;
const AGENT_API_HOST = '127.0.0.1';

type AgentChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url?: { url?: string } | string };

interface AgentChatRequest {
  messages: { role: string; content: string | AgentChatContentPart[] }[];
  model?: string;
  stream?: boolean;
  skillIds?: string[];
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

    if (pathname === '/api/agent/skills/set-enabled' && req.method === 'POST') {
      await this.handleSetSkillEnabled(req, res);
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
  ): Promise<void> {
    if (typeof runner?.startCoworkSession === 'function') {
      await runner.startCoworkSession(sessionId, prompt, { imageAttachments, skillIds });
      return;
    }
    if (typeof runner?.startSession === 'function') {
      await runner.startSession(sessionId, prompt, { confirmationMode: 'text', imageAttachments, skillIds });
      return;
    }
    throw new Error('CoworkRunner start method not available');
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

  private async handleUploadFile(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.verifyAuth(req)) {
      sendError(res, 401, 'Invalid or missing API key');
      return;
    }
    const parsed = await this.readRequestBody(req);
    if (!parsed || typeof parsed.name !== 'string' || typeof parsed.base64Data !== 'string') {
      sendError(res, 400, 'Invalid payload');
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
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({
      file: {
        id: fileId,
        name: safeName,
        path: fullPath,
        size: buffer.length,
      },
    }));
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
