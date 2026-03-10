import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import type { CoworkMessage, CoworkSession } from '../coworkStore';

const AGENT_API_PORT = 19888;
const AGENT_API_HOST = '127.0.0.1';

interface AgentChatRequest {
  messages: { role: string; content: string }[];
  model?: string;
  stream?: boolean;
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
  private publishStateChanged: (event: AgentStateChangedEvent) => void = () => {};

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  setCoworkRunnerGetter(getter: () => any | null): void {
    this.getCoworkRunner = getter;
  }

  setStateChangedPublisher(publisher: (event: AgentStateChangedEvent) => void): void {
    this.publishStateChanged = publisher;
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

  private async startRunnerSession(runner: any, sessionId: string, prompt: string): Promise<void> {
    if (typeof runner?.startCoworkSession === 'function') {
      await runner.startCoworkSession(sessionId, prompt);
      return;
    }
    if (typeof runner?.startSession === 'function') {
      await runner.startSession(sessionId, prompt, { confirmationMode: 'text' });
      return;
    }
    throw new Error('CoworkRunner start method not available');
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

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed: AgentChatRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    const { messages, stream = true } = parsed;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      sendError(res, 400, 'Missing messages');
      return;
    }

    const lastMessage = messages[messages.length - 1];
    const userPrompt = lastMessage.content;

    if (!stream) {
      await this.handleChatNoStream(req, res, userPrompt);
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
      await this.startRunnerSession(runner, sessionId, userPrompt);

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

  private async handleChatNoStream(req: http.IncomingMessage, res: http.ServerResponse, userPrompt: string): Promise<void> {
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
      await this.startRunnerSession(runner, sessionId, userPrompt);

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
