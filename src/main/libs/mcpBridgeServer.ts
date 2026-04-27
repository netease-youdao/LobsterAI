/**
 * McpBridgeServer — lightweight HTTP callback endpoint for the OpenClaw MCP Bridge.
 *
 * OpenClaw's mcp-bridge plugin calls this endpoint to execute MCP tools.
 * OpenClaw's ask-user-question plugin calls /askuser for user confirmation dialogs.
 * Binds to 127.0.0.1 only (local traffic).
 */
import crypto from 'crypto';
import http from 'http';
import net from 'net';

import { getToolTextPreview, looksLikeTransportErrorText, serializeForLog, serializeToolContentForLog } from './mcpLog';
import type { McpServerManager } from './mcpServerManager';

const log = (level: string, msg: string) => {
  const formatted = `[McpBridge:HTTP][${level}] ${msg}`;
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
  questions: Array<{
    question: string;
    header?: string;
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

export class McpBridgeServer {
  private server: http.Server | null = null;
  private _port: number | null = null;
  private readonly mcpManager: McpServerManager;
  private readonly secret: string;
  private readonly pendingAskUser = new Map<string, PendingAskUser>();
  private onAskUserCallback: ((request: AskUserRequest) => void) | null = null;
  private onAskUserDismissCallback: ((requestId: string) => void) | null = null;

  constructor(mcpManager: McpServerManager, secret: string) {
    this.mcpManager = mcpManager;
    this.secret = secret;
    log('INFO', `McpBridgeServer created, secret prefix="${secret.slice(0, 8)}…"`);
  }

  get port(): number | null {
    return this._port;
  }

  get callbackUrl(): string | null {
    return this._port ? `http://127.0.0.1:${this._port}/mcp/execute` : null;
  }

  get askUserCallbackUrl(): string | null {
    return this._port ? `http://127.0.0.1:${this._port}/askuser` : null;
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
      this.server!.close(() => {
        log('INFO', 'McpBridgeServer stopped');
        this.server = null;
        this._port = null;
        resolve();
      });
      // Force-close open connections after a short timeout
      setTimeout(() => {
        this.server?.closeAllConnections?.();
      }, 2000);
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    log('DEBUG', `HTTP ${req.method} ${req.url}`);

    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Verify secret token (accept either header name)
    const authHeader = req.headers['x-mcp-bridge-secret'] || req.headers['x-ask-user-secret'];
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

    if (req.url?.startsWith('/mcp/execute')) {
      await this.handleMcpExecute(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async handleAskUser(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ASKUSER_TIMEOUT_MS = 120_000;

    try {
      const body = await this.readBody(req);
      const input = JSON.parse(body) as { questions?: unknown[] };
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

  private async handleMcpExecute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Abort in-flight MCP tool calls when the gateway drops the HTTP connection
    // (e.g. after chat.abort).  This prevents zombie 60-second MCP timeouts from
    // keeping the gateway run active and blocking new user messages.
    //
    // Listen on `res` (ServerResponse), NOT `req` (IncomingMessage).
    // `req` is a Readable stream that emits `close` after the body is consumed
    // (auto-destroy via nextTick, which runs before the Promise microtask from
    // readBody), causing the signal to be aborted before callTool even starts.
    // `res.close` fires when the underlying socket disconnects; we only abort
    // if the response hasn't been fully sent yet (i.e. a premature disconnect).
    const abortController = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) {
        abortController.abort();
      }
    };
    res.on('close', onClose);

    try {
      const body = await this.readBody(req);
      const { server, tool, args } = JSON.parse(body) as {
        server: string;
        tool: string;
        args: Record<string, unknown>;
      };

      log('INFO', `Execute request received for server="${server}" tool="${tool}" with arguments ${serializeForLog(args || {})}`);

      if (!server || !tool) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "server" or "tool" field' }));
        return;
      }

      const t0 = Date.now();
      const result = await this.mcpManager.callTool(server, tool, args || {}, { signal: abortController.signal });
      const contentPreview = serializeToolContentForLog(result.content);
      const textPreview = getToolTextPreview(result.content);
      log('INFO', `Execute completed for server="${server}" tool="${tool}" in ${Date.now() - t0}ms with isError=${result.isError}. Result=${contentPreview}`);
      if (!result.isError && looksLikeTransportErrorText(textPreview)) {
        log('WARN', `Execute completed for server="${server}" tool="${tool}" with transport-style error text but isError=false. Result text="${textPreview}"`);
      }

      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log('ERROR', `Request handling error: ${errMsg}`);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          content: [{ type: 'text', text: `Bridge error: ${errMsg}` }],
          isError: true,
        }));
      }
    } finally {
      res.removeListener('close', onClose);
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
