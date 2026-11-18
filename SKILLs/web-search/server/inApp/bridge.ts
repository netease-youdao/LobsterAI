/**
 * In-app browser backend - runs searches in LobsterAI's own hidden browser page
 * instead of launching a separate Chrome window.
 *
 * LobsterAI publishes its endpoint in the file named by
 * LOBSTERAI_WEB_SEARCH_BRIDGE_FILE. The file is read on every request because
 * this server outlives the app and the endpoint changes on each app launch.
 */

import { readFile } from 'fs/promises';

export const IN_APP_BRIDGE_FILE_ENV = 'LOBSTERAI_WEB_SEARCH_BRIDGE_FILE';

/** Connection id handed to clients while searches run in the in-app browser. */
export const IN_APP_CONNECTION_ID = 'lobster-in-app';

const STATUS_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 45000;

interface BridgeEndpoint {
  bridgeUrl: string;
  bridgeSecret: string;
}

interface BridgeResponse {
  success?: boolean;
  data?: unknown;
  error?: string;
}

export type InAppPageOp = 'status' | 'search' | 'navigate' | 'text' | 'html';

export class InAppBrowserBridge {
  constructor(private readonly bridgeFile: string | undefined = process.env[IN_APP_BRIDGE_FILE_ENV]) {}

  private async readEndpoint(): Promise<BridgeEndpoint | null> {
    if (!this.bridgeFile) {
      return null;
    }

    try {
      const parsed = JSON.parse(await readFile(this.bridgeFile, 'utf8')) as Partial<BridgeEndpoint>;
      if (typeof parsed.bridgeUrl !== 'string' || typeof parsed.bridgeSecret !== 'string') {
        return null;
      }
      // Only ever talk to the app on this machine.
      if (new URL(parsed.bridgeUrl).hostname !== '127.0.0.1') {
        return null;
      }
      return { bridgeUrl: parsed.bridgeUrl, bridgeSecret: parsed.bridgeSecret };
    } catch {
      // No file means LobsterAI is not running or predates the in-app backend.
      return null;
    }
  }

  private async post(
    endpoint: BridgeEndpoint,
    op: InAppPageOp,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<BridgeResponse> {
    const response = await fetch(endpoint.bridgeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mcp-bridge-secret': endpoint.bridgeSecret
      },
      body: JSON.stringify({ ...payload, op }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json().catch(() => null) as BridgeResponse | null;
    if (!body) {
      throw new Error(`LobsterAI in-app browser returned HTTP ${response.status}`);
    }
    return body;
  }

  /**
   * True when LobsterAI is running with the in-app browser mode on. Any
   * failure means "not active" so callers fall back to their own browser.
   */
  async isActive(): Promise<boolean> {
    const endpoint = await this.readEndpoint();
    if (!endpoint) {
      return false;
    }

    try {
      const body = await this.post(endpoint, 'status', {}, STATUS_TIMEOUT_MS);
      return body.success === true;
    } catch {
      return false;
    }
  }

  async request<T>(op: InAppPageOp, payload: Record<string, unknown> = {}): Promise<T> {
    const endpoint = await this.readEndpoint();
    if (!endpoint) {
      throw new Error('LobsterAI in-app browser is not available');
    }

    const body = await this.post(endpoint, op, payload, REQUEST_TIMEOUT_MS);
    if (body.success !== true) {
      throw new Error(body.error || 'LobsterAI in-app browser request failed');
    }
    return body.data as T;
  }
}
