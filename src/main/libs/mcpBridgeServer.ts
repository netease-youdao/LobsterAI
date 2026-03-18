/**
 * McpBridgeServer — lightweight HTTP callback endpoint for the OpenClaw MCP Bridge.
 *
 * OpenClaw's mcp-bridge plugin calls this endpoint to execute MCP tools.
 * Binds to 127.0.0.1 only (local traffic).
 */
import http from 'http';
import net from 'net';
import type { McpServerManager } from './mcpServerManager';

const log = (level: string, msg: string) => {
  console.log(`[McpBridge][${level}] ${msg}`);
};

export class McpBridgeServer {
  private server: http.Server | null = null;
  private _port: number | null = null;
  private readonly mcpManager: McpServerManager;
  private readonly secret: string;

  constructor(mcpManager: McpServerManager, secret: string) {
    this.mcpManager = mcpManager;
    this.secret = secret;
  }

  get port(): number | null {
    return this._port;
  }

  get callbackUrl(): string | null {
    return this._port ? `http://127.0.0.1:${this._port}/mcp/execute` : null;
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
        this.handleRequest(req, res);
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
    // Only accept POST /mcp/execute
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp/execute')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Verify secret token
    const authHeader = req.headers['x-mcp-bridge-secret'];
    if (authHeader !== this.secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      const body = await this.readBody(req);
      const { server, tool, args } = JSON.parse(body) as {
        server: string;
        tool: string;
        args: Record<string, unknown>;
      };

      if (!server || !tool) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "server" or "tool" field' }));
        return;
      }

      const result = await this.mcpManager.callTool(server, tool, args || {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log('ERROR', `Request handling error: ${errMsg}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: [{ type: 'text', text: `Bridge error: ${errMsg}` }],
        isError: true,
      }));
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
