import type { OnBeforeSendHeadersListenerDetails, Session } from 'electron';

const WebSocketProtocol = {
  Ws: 'ws:',
  Wss: 'wss:',
} as const;

const WebRequestResourceType = {
  WebSocket: 'webSocket',
} as const;

const ASR_WS_URL_PATTERNS = ['ws://*/*', 'wss://*/*'] as const;
const DEFAULT_TICKET_TTL_MS = 120_000;
const MIN_TICKET_TTL_MS = 60_000;
const MAX_TICKET_TTL_MS = 15 * 60_000;
const MAX_TRACKED_SESSIONS = 32;

interface AuthorizedAsrWebSocketEntry {
  webContentsId: number;
  expiresAt: number;
}

export type AsrWebSocketHeaderDetails = Pick<
  OnBeforeSendHeadersListenerDetails,
  'url' | 'resourceType' | 'webContentsId' | 'requestHeaders'
>;

export interface AsrRealtimeWsOriginStripper {
  allow: (wsUrl: string, webContentsId: number, expiresInSeconds?: number) => void;
  stripOriginIfAuthorized: (details: AsrWebSocketHeaderDetails) => Record<string, string>;
  attachToSession: (targetSession: Pick<Session, 'webRequest'>) => void;
}

const normalizeWebSocketUrl = (rawUrl: string): string | null => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== WebSocketProtocol.Ws && parsed.protocol !== WebSocketProtocol.Wss) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
};

const resolveTicketTtlMs = (expiresInSeconds?: number): number => {
  if (typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    return DEFAULT_TICKET_TTL_MS;
  }
  return Math.min(MAX_TICKET_TTL_MS, Math.max(MIN_TICKET_TTL_MS, Math.round(expiresInSeconds * 1000)));
};

/**
 * Strips the browser `Origin` header exclusively for one-time realtime ASR
 * WebSocket upgrades issued to the requesting renderer `webContents`.
 *
 * The backend WebSocket endpoint rejects development renderer origins such as
 * `http://localhost:5175` with HTTP 403 `Invalid CORS request`, whereas native
 * desktop / main-process WebSocket clients omit `Origin` during the handshake.
 */
export function createAsrRealtimeWsOriginStripper(options?: {
  now?: () => number;
}): AsrRealtimeWsOriginStripper {
  const now = options?.now ?? Date.now;
  const authorizedEntries = new Map<string, AuthorizedAsrWebSocketEntry>();

  const pruneExpired = (currentTime: number): void => {
    for (const [key, entry] of authorizedEntries) {
      if (entry.expiresAt <= currentTime) {
        authorizedEntries.delete(key);
      }
    }
  };

  const allow = (wsUrl: string, webContentsId: number, expiresInSeconds?: number): void => {
    if (!Number.isInteger(webContentsId) || webContentsId < 0) return;
    const normalizedUrl = normalizeWebSocketUrl(wsUrl);
    if (!normalizedUrl) return;

    const currentTime = now();
    pruneExpired(currentTime);
    authorizedEntries.delete(normalizedUrl);
    while (authorizedEntries.size >= MAX_TRACKED_SESSIONS) {
      const oldestKey = authorizedEntries.keys().next().value;
      if (oldestKey === undefined) break;
      authorizedEntries.delete(oldestKey);
    }

    authorizedEntries.set(normalizedUrl, {
      webContentsId,
      expiresAt: currentTime + resolveTicketTtlMs(expiresInSeconds),
    });
  };

  const stripOriginIfAuthorized = (details: AsrWebSocketHeaderDetails): Record<string, string> => {
    if (details.resourceType !== WebRequestResourceType.WebSocket) {
      return details.requestHeaders;
    }
    if (typeof details.webContentsId !== 'number') {
      return details.requestHeaders;
    }
    const normalizedUrl = normalizeWebSocketUrl(details.url);
    if (!normalizedUrl) {
      return details.requestHeaders;
    }

    const currentTime = now();
    pruneExpired(currentTime);
    const entry = authorizedEntries.get(normalizedUrl);
    if (!entry || entry.webContentsId !== details.webContentsId) {
      return details.requestHeaders;
    }

    let stripped = false;
    const nextHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(details.requestHeaders)) {
      if (key.toLowerCase() === 'origin') {
        stripped = true;
        continue;
      }
      nextHeaders[key] = value;
    }
    return stripped ? nextHeaders : details.requestHeaders;
  };

  const attachToSession = (targetSession: Pick<Session, 'webRequest'>): void => {
    targetSession.webRequest.onBeforeSendHeaders(
      {
        urls: [...ASR_WS_URL_PATTERNS],
        types: [WebRequestResourceType.WebSocket],
      },
      (details, callback) => {
        callback({
          requestHeaders: stripOriginIfAuthorized(details),
        });
      },
    );
  };

  return {
    allow,
    stripOriginIfAuthorized,
    attachToSession,
  };
}
