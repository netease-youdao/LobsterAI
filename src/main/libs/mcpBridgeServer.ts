/**
 * McpBridgeServer — lightweight HTTP callback endpoint for OpenClaw's ask-user-question plugin.
 *
 * Provides a /askuser endpoint that OpenClaw calls to show user confirmation dialogs.
 * Binds to 127.0.0.1 only (local traffic).
 */
import crypto from 'crypto';
import http from 'http';
import net from 'net';

import { serializeForLog } from './sanitizeForLog';

const log = (level: string, msg: string) => {
  const formatted = `[AskUser:HTTP][${level}] ${msg}`;
  if (level === 'ERROR') {
    console.error(formatted);
  } else if (level === 'WARN') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
};

export type AskUserRequest = {
  requestId: string;
  sessionKey?: string;
  questions: Array<{
    question: string;
    header?: string;
    title?: string;
    subtitle?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

export type AskUserResponse = {
  behavior: 'allow' | 'deny';
  answers?: Record<string, string>;
};

type PendingAskUser = {
  requestId: string;
  resolve: (response: AskUserResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type MediaGenerationRequest = {
  tool: string;
  args: Record<string, unknown>;
  context: {
    sessionKey: string;
    toolCallId: string;
  };
};

export type MediaGenerationResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
};

export class McpBridgeServer {
  private server: http.Server | null = null;
  private _port: number | null = null;
  private readonly secret: string;
  private readonly pendingAskUser = new Map<string, PendingAskUser>();
  private onAskUserCallback: ((request: AskUserRequest) => void) | null = null;
  private onAskUserDismissCallback: ((requestId: string) => void) | null = null;
  private onMediaGenerationCallback: ((request: MediaGenerationRequest) => Promise<MediaGenerationResponse>) | null = null;

  constructor(secret: string) {
    this.secret = secret;
    log('INFO', `McpBridgeServer created, secret prefix="${secret.slice(0, 8)}…"`);
  }

  get port(): number | null {
    return this._port;
  }

  get askUserCallbackUrl(): string | null {
    return this._port ? `http://127.0.0.1:${this._port}/askuser` : null;
  }

  get mediaCallbackUrl(): string | null {
    return this._port ? `http://127.0.0.1:${this._port}/media-generation/tool` : null;
  }

  /**
   * Register a callback that fires when an AskUserQuestion request arrives.
   * The callback should show a modal and eventually call resolveAskUser().
   */
  onAskUser(callback: (request: AskUserRequest) => void): void {
    this.onAskUserCallback = callback;
  }

  /**
   * Register a callback that fires when an AskUser request is dismissed (timeout or resolved).
   * The callback should close the modal in the renderer.
   */
  onAskUserDismiss(callback: (requestId: string) => void): void {
    this.onAskUserDismissCallback = callback;
  }

  /**
   * Register a callback for media generation tool requests.
   * The callback should call lobsterai-server and return the result.
   */
  onMediaGeneration(callback: (request: MediaGenerationRequest) => Promise<MediaGenerationResponse>): void {
    this.onMediaGenerationCallback = callback;
  }

  /**
   * Resolve a pending AskUserQuestion request (called when user clicks in the modal).
   */
  resolveAskUser(requestId: string, response: AskUserResponse): void {
    const pending = this.pendingAskUser.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAskUser.delete(requestId);
    pending.resolve(response);
  }

  /**
   * Programmatic ask-user request from within the main process.
   * Reuses the same pending/resolve/callback infrastructure as the HTTP endpoint
   * but skips HTTP and authentication.
   */
  async askUserInternal(
    questions: AskUserRequest['questions'],
    timeoutMs = 120_000,
    options: { sessionKey?: string } = {},
  ): Promise<AskUserResponse> {
    const requestId = crypto.randomUUID();
    const sessionKey = options.sessionKey?.trim() || undefined;
    log('INFO', `AskUser (internal) request, requestId=${requestId}`);

    return new Promise<AskUserResponse>((resolve) => {
      const timer = setTimeout(() => {
        log('INFO', `AskUser (internal) timeout, requestId=${requestId}`);
        this.pendingAskUser.delete(requestId);
        this.onAskUserDismissCallback?.(requestId);
        resolve({ behavior: 'deny' });
      }, timeoutMs);

      this.pendingAskUser.set(requestId, { requestId, resolve, timer });

      if (this.onAskUserCallback) {
        this.onAskUserCallback({ requestId, questions, sessionKey });
      } else {
        log('WARN', 'AskUser callback not registered, denying (internal)');
        clearTimeout(timer);
        this.pendingAskUser.delete(requestId);
        resolve({ behavior: 'deny' });
      }
    });
  }

  /**
   * Start the HTTP callback server on a free port.
   */
  async start(): Promise<number> {
    if (this.server) {
      throw new Error('McpBridgeServer is already running');
    }

    const port = await this.findFreePort();

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          log('ERROR', `Unhandled error in handleRequest: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
      });

      srv.on('error', (err) => {
        log('ERROR', `HTTP server error: ${err.message}`);
        reject(err);
      });

      srv.listen(port, '127.0.0.1', () => {
        this._port = port;
        this.server = srv;
        log('INFO', `McpBridgeServer listening on http://127.0.0.1:${port}`);
        resolve(port);
      });
    });
  }

  /**
   * Stop the HTTP callback server.
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      // Force-close open connections after a short timeout if server hasn't closed yet
      const forceCloseTimer = setTimeout(() => {
        this.server?.closeAllConnections?.();
      }, 2000);

      this.server!.close(() => {
        clearTimeout(forceCloseTimer);
        log('INFO', 'McpBridgeServer stopped');
        this.server = null;
        this._port = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    log('DEBUG', `HTTP ${req.method} ${req.url}`);

    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Verify secret token (accept any of the known header name for backwards compats)
    const authHeader = req.headers['x-mcp-bridge-secret'] || req.headers['x-ask-user-secret'] || req.headers['x-lobster-media-secret'];
    if (authHeader !== this.secret) {
      log('WARN', `Auth rejected for ${req.url}: header=${authHeader ? 'present-but-mismatch' : 'missing'}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.url?.startsWith('/askuser')) {
      await this.handleAskUser(req, res);
      return;
    }

    if (req.url?.startsWith('/media-generation/tool')) {
      await this.handleMediaGeneration(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async handleAskUser(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ASKUSER_TIMEOUT_MS = 120_000;

    try {
      const body = await this.readBody(req);
      const input = JSON.parse(body) as { questions?: unknown[]; sessionKey?: unknown };
      const sessionKey = typeof input.sessionKey === 'string' && input.sessionKey.trim()
        ? input.sessionKey.trim()
        : undefined;
      log('INFO', `AskUser request received, questions=${Array.isArray(input.questions) ? input.questions.length : 0}`);

      if (!Array.isArray(input.questions) || input.questions.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or empty "questions" field' }));
        return;
      }

      const requestId = crypto.randomUUID();
      log('INFO', `AskUser waiting for user response, requestId=${requestId}`);

      // Create a Promise that resolves when the user responds or timeout
      const userResponse = await new Promise<AskUserResponse>((resolve) => {
        const timer = setTimeout(() => {
          log('INFO', `AskUser timeout, requestId=${requestId}`);
          this.pendingAskUser.delete(requestId);
          this.onAskUserDismissCallback?.(requestId);
          resolve({ behavior: 'deny' });
        }, ASKUSER_TIMEOUT_MS);

        this.pendingAskUser.set(requestId, { requestId, resolve, timer });

        // Notify LobsterAI to show the modal
        if (this.onAskUserCallback) {
          this.onAskUserCallback({
            requestId,
            sessionKey,
            questions: input.questions as AskUserRequest['questions'],
          });
        } else {
          log('WARN', 'AskUser callback not registered, denying');
          clearTimeout(timer);
          this.pendingAskUser.delete(requestId);
          resolve({ behavior: 'deny' });
        }
      });

      log('INFO', `AskUser resolved, requestId=${requestId} behavior=${userResponse.behavior}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(userResponse));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log('ERROR', `AskUser request error: ${errMsg}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ behavior: 'deny' }));
    }
  }

  private async handleMediaGeneration(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const t0 = Date.now();
    try {
      const body = await this.readBody(req);
      const request = JSON.parse(body) as MediaGenerationRequest;
      const action = typeof request.args?.action === 'string' ? request.args.action : 'generate';
      const model = typeof request.args?.model === 'string' ? request.args.model : '';
      const prompt = typeof request.args?.prompt === 'string' ? request.args.prompt : '';
      log('INFO', `Media generation request received for tool="${request.tool}" action="${action}" toolCallId="${request.context?.toolCallId ?? ''}" sessionKey="${request.context?.sessionKey?.slice(0, 30)}…" args=${serializeForLog({
        action,
        model,
        promptLength: prompt.length,
        hasImage: typeof request.args?.image === 'string',
        imageCount: Array.isArray(request.args?.images) ? request.args.images.length : undefined,
        hasVideo: typeof request.args?.video === 'string',
        videoCount: Array.isArray(request.args?.videos) ? request.args.videos.length : undefined,
        aspectRatio: request.args?.aspectRatio,
        resolution: request.args?.resolution,
        size: request.args?.size,
        count: request.args?.count,
        durationSeconds: request.args?.durationSeconds,
      })}`);

      if (!request.tool || !request.context?.sessionKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'Missing tool or context.sessionKey' }], isError: true }));
        return;
      }

      if (!this.onMediaGenerationCallback) {
        log('WARN', 'Media generation callback not registered');
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'Media generation service not available.' }], isError: true }));
        return;
      }

      const result = await this.onMediaGenerationCallback(request);
      const contentPreview = serializeForLog(result.content);
      log('INFO', `Media generation completed for tool="${request.tool}" in ${Date.now() - t0}ms with isError=${result.isError ?? false}. Details=${serializeForLog(result.details ?? {})} Result=${contentPreview}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log('ERROR', `Media generation request failed after ${Date.now() - t0}ms: ${errMsg}`);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: `Media generation error: ${errMsg}` }], isError: true }));
      }
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.once('listening', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
      srv.listen(0, '127.0.0.1');
    });
  }
}
