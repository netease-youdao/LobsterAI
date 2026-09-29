import { net } from 'electron';
import http from 'http';

import { isLobsterAIQuotaExhaustedError } from '../../common/coworkErrorClassify';
import {
  AuthRefreshOutcome,
  AuthRefreshReason,
  type AuthRefreshReason as AuthRefreshReasonValue,
  type AuthTokenRefreshResult,
} from '../../shared/auth/constants';
import {
  formatLlmTraceparent,
  isValidLlmTraceId,
  LLM_TRACEPARENT_HEADER,
  LOBSTER_SERVER_TRACE_ID_HEADER,
  parseLlmTraceparent,
} from '../../shared/cowork/llmTurnUsage';
import { EnterpriseApiErrorCode } from '../../shared/enterpriseAccount/constants';
import {
  LOBSTERAI_CLIENT_CAPABILITIES,
  LOBSTERAI_CLIENT_CAPABILITIES_HEADER,
  LOBSTERAI_CLIENT_VERSION_HEADER,
} from '../../shared/providers/modelRuntimeProfiles';
import type { EnterpriseAuthSessionSnapshot } from '../enterpriseAccount/membershipRevocation';
import { createLlmSpanId, createLlmTraceId } from './llmTrace';

const PROXY_BIND_HOST = '127.0.0.1';
const RECENT_QUOTA_ERROR_TTL_MS = 30_000;
const MAX_PROXY_SSE_SCAN_BUFFER_CHARS = 1_048_576;
const GEMINI_FALLBACK_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const MAX_TRACE_STATS_ENTRIES = 500;

let proxyServer: http.Server | null = null;
let proxyPort: number | null = null;
let recentQuotaError: OpenClawTokenProxyQuotaError | null = null;
const traceStatsById = new Map<string, OpenClawTokenProxyTraceStats>();

// Injected dependencies
let tokenGetter: (() => { accessToken: string; refreshToken: string } | null) | null = null;
let tokenRefresher: (
  (reason: AuthRefreshReasonValue) => Promise<AuthTokenRefreshResult>
) | null = null;
let serverBaseUrlGetter: (() => string) | null = null;
let accountContextHeadersGetter: (() => Record<string, string>) | null = null;
let sessionKeyGetter: (() => string | null) | null = null;
let clientVersionGetter: (() => string) | null = null;
let enterpriseAuthSessionSnapshotGetter: (() => EnterpriseAuthSessionSnapshot | null) | null = null;
let enterpriseMembershipRevokedHandler: (
  (event: OpenClawTokenProxyMembershipRevocationEvent) => void
) | null = null;

export type OpenClawTokenProxyMembershipRevocationEvent = {
  code: number;
  requestSession: EnterpriseAuthSessionSnapshot;
};

export type OpenClawTokenProxyConfig = {
  getAuthTokens: () => { accessToken: string; refreshToken: string } | null;
  refreshToken: (reason: AuthRefreshReasonValue) => Promise<AuthTokenRefreshResult>;
  getServerBaseUrl: () => string;
  getAccountContextHeaders?: () => Record<string, string>;
  getSessionKey?: () => string | null;
  getClientVersion: () => string;
  getEnterpriseAuthSessionSnapshot?: () => EnterpriseAuthSessionSnapshot | null;
  onEnterpriseMembershipRevoked?: (
    event: OpenClawTokenProxyMembershipRevocationEvent
  ) => void;
};

type OpenClawTokenProxyQuotaError = {
  message: string;
  code?: string | number;
  capturedAt: number;
};

/** Model requests the proxy forwarded for one client trace (one Cowork turn). */
export type OpenClawTokenProxyTraceStats = {
  requests: number;
  /** Responses that ended with a terminal success packet or a 2xx body. */
  completed: number;
  failed: number;
  lastSeenAt: number;
};

/**
 * One forwarded model request. traceId/spanId come from OpenClaw's traceparent
 * (the turn's trace when the turn was started with one) and are forwarded to
 * lobsterai-server, which echoes its own trace id back for log correlation.
 */
type ProxyRequestTrace = {
  traceId: string;
  spanId: string;
  traceparent: string;
  generated: boolean;
  path: string;
  startedAt: number;
  serverTraceId: string | null;
  status: number | null;
  finished: boolean;
};

const ProxyRequestOutcome = {
  Completed: 'completed',
  UpstreamError: 'upstream_error',
  HttpError: 'http_error',
  UnexpectedEof: 'unexpected_eof',
  TransportError: 'transport_error',
  DownstreamClosed: 'downstream_closed',
  AuthSessionChanged: 'auth_session_changed',
  AuthRefreshUnavailable: 'auth_refresh_unavailable',
  ProxyError: 'proxy_error',
} as const;
type ProxyRequestOutcomeValue = typeof ProxyRequestOutcome[keyof typeof ProxyRequestOutcome];

export function startOpenClawTokenProxy(config: OpenClawTokenProxyConfig): Promise<{ port: number }> {
  tokenGetter = config.getAuthTokens;
  tokenRefresher = config.refreshToken;
  serverBaseUrlGetter = config.getServerBaseUrl;
  accountContextHeadersGetter = config.getAccountContextHeaders ?? null;
  sessionKeyGetter = config.getSessionKey ?? null;
  clientVersionGetter = config.getClientVersion;
  enterpriseAuthSessionSnapshotGetter = config.getEnterpriseAuthSessionSnapshot ?? null;
  enterpriseMembershipRevokedHandler = config.onEnterpriseMembershipRevoked ?? null;

  return new Promise((resolve, reject) => {
    if (proxyServer) {
      if (proxyPort) {
        resolve({ port: proxyPort });
        return;
      }
      reject(new Error('Token proxy is starting'));
      return;
    }

    const server = http.createServer(handleRequest);

    server.listen(0, PROXY_BIND_HOST, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        proxyPort = addr.port;
        proxyServer = server;
        console.log(`[OpenClawTokenProxy] started on ${PROXY_BIND_HOST}:${proxyPort}`);
        resolve({ port: proxyPort });
      } else {
        server.close();
        reject(new Error('Failed to bind token proxy'));
      }
    });

    server.on('error', (err) => {
      console.error('[OpenClawTokenProxy] server error:', err);
      reject(err);
    });
  });
}

export function stopOpenClawTokenProxy(): void {
  if (proxyServer) {
    proxyServer.close();
    console.log('[OpenClawTokenProxy] stopped');
  }
  proxyServer = null;
  proxyPort = null;
  recentQuotaError = null;
  traceStatsById.clear();
  tokenGetter = null;
  tokenRefresher = null;
  serverBaseUrlGetter = null;
  accountContextHeadersGetter = null;
  sessionKeyGetter = null;
  clientVersionGetter = null;
  enterpriseAuthSessionSnapshotGetter = null;
  enterpriseMembershipRevokedHandler = null;
}

export function getOpenClawTokenProxyPort(): number | null {
  return proxyPort;
}

export function getOpenClawTokenProxyTraceStats(traceId: string): OpenClawTokenProxyTraceStats | null {
  const stats = traceStatsById.get(traceId);
  return stats ? { ...stats } : null;
}

function createProxyRequestTrace(
  traceparentHeader: string | string[] | undefined,
  path: string,
  now = Date.now(),
): ProxyRequestTrace {
  const parsed = parseLlmTraceparent(Array.isArray(traceparentHeader) ? traceparentHeader[0] : traceparentHeader);
  // Requests outside a traced run still get ids so client and server logs match.
  const traceId = parsed?.traceId ?? createLlmTraceId();
  const spanId = parsed?.spanId ?? createLlmSpanId();
  return {
    traceId,
    spanId,
    traceparent: formatLlmTraceparent(traceId, spanId),
    generated: !parsed,
    path,
    startedAt: now,
    serverTraceId: null,
    status: null,
    finished: false,
  };
}

// Entries are re-inserted on every request, so map order is least recently used first.
function pruneTraceStats(): void {
  for (const traceId of traceStatsById.keys()) {
    if (traceStatsById.size <= MAX_TRACE_STATS_ENTRIES) return;
    traceStatsById.delete(traceId);
  }
}

function recordProxyRequestStarted(trace: ProxyRequestTrace, bodyBytes: number): void {
  if (!trace.generated && isValidLlmTraceId(trace.traceId)) {
    const stats = traceStatsById.get(trace.traceId) ?? { requests: 0, completed: 0, failed: 0, lastSeenAt: 0 };
    stats.requests += 1;
    stats.lastSeenAt = trace.startedAt;
    traceStatsById.delete(trace.traceId);
    traceStatsById.set(trace.traceId, stats);
    pruneTraceStats();
  }
  console.debug(
    `[OpenClawTokenProxy] LLM request started trace=${trace.traceId} span=${trace.spanId}`
    + `${trace.generated ? ' traceSource=generated' : ''} path=${trace.path} bytes=${bodyBytes}`,
  );
}

function finishProxyRequest(
  trace: ProxyRequestTrace | undefined,
  outcome: ProxyRequestOutcomeValue,
  detail = '',
  now = Date.now(),
): void {
  if (!trace || trace.finished) return;
  trace.finished = true;
  const completed = outcome === ProxyRequestOutcome.Completed;
  const stats = trace.generated ? undefined : traceStatsById.get(trace.traceId);
  if (stats) {
    if (completed) {
      stats.completed += 1;
    } else {
      stats.failed += 1;
    }
    stats.lastSeenAt = now;
  }
  const message = `[OpenClawTokenProxy] LLM request finished trace=${trace.traceId} span=${trace.spanId}`
    + ` serverTrace=${trace.serverTraceId ?? 'none'} status=${trace.status ?? 'none'} outcome=${outcome}`
    + `${detail ? ` ${detail}` : ''} durationMs=${Math.max(0, now - trace.startedAt)}`;
  if (completed) {
    console.log(message);
  } else {
    console.warn(message);
  }
}

export function consumeRecentOpenClawTokenProxyQuotaError(
  now = Date.now(),
): OpenClawTokenProxyQuotaError | null {
  const error = recentQuotaError;
  recentQuotaError = null;
  if (!error) {
    return null;
  }
  if (now - error.capturedAt > RECENT_QUOTA_ERROR_TTL_MS) {
    return null;
  }
  return error;
}

function collectRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function shouldRefreshLobsterAIToken(status: number): boolean {
  return status === 401;
}

function isTemporaryAuthRefreshFailure(result: AuthTokenRefreshResult): boolean {
  return result.outcome === AuthRefreshOutcome.TransientFailure;
}

function writeTemporaryAuthRefreshFailure(res: http.ServerResponse): void {
  res.writeHead(503, {
    'Content-Type': 'application/json',
    'Retry-After': '1',
  });
  res.end(JSON.stringify({
    error: {
      message: 'Login verification is temporarily unavailable. Please retry.',
      type: 'service_unavailable',
      code: 'auth_refresh_temporarily_unavailable',
    },
  }));
}

function isProxySessionKeyCurrent(
  expectedSessionKey: string | null,
  getCurrentSessionKey: (() => string | null) | null,
): boolean {
  return getCurrentSessionKey === null || getCurrentSessionKey() === expectedSessionKey;
}

function writeAuthSessionChanged(res: http.ServerResponse): void {
  res.writeHead(409, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      message: 'The authenticated account changed while the request was running.',
      type: 'authentication_error',
      code: 'auth_session_changed',
    },
  }));
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let requestTrace: ProxyRequestTrace | undefined;
  try {
    const tokens = tokenGetter?.();
    const serverBaseUrl = serverBaseUrlGetter?.();
    const requestSessionKey = sessionKeyGetter?.() ?? null;
    const requestEnterpriseSession = enterpriseAuthSessionSnapshotGetter?.() ?? null;
    const inspectionContext = requestEnterpriseSession && enterpriseMembershipRevokedHandler
      ? {
        requestEnterpriseSession,
        onEnterpriseMembershipRevoked: enterpriseMembershipRevokedHandler,
      }
      : undefined;

    if (!tokens?.accessToken || !serverBaseUrl) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No auth tokens available' }));
      return;
    }

    const body = await collectRequestBody(req);
    requestTrace = createProxyRequestTrace(req.headers[LLM_TRACEPARENT_HEADER], req.url?.split('?')[0] ?? '/');
    recordProxyRequestStarted(requestTrace, body.length);
    const upstreamBody = shouldHydrateGeminiChatCompletionsBody(req.url)
      ? hydrateGeminiChatCompletionsBody(body)
      : body;

    // Build upstream URL: serverBaseUrl + request path
    // OpenClaw sends to /v1/chat/completions, upstream is /api/proxy/v1/chat/completions
    const upstreamPath = `/api/proxy${req.url || '/'}`;
    const upstreamUrl = `${serverBaseUrl}${upstreamPath}`;

    const clientVersion = clientVersionGetter?.() ?? '';
    let result = await forwardRequest(
      upstreamUrl,
      req.method || 'POST',
      tokens.accessToken,
      upstreamBody,
      req.headers,
      clientVersion,
      requestTrace.traceparent,
    );
    if (!isProxySessionKeyCurrent(requestSessionKey, sessionKeyGetter)) {
      cancelUpstreamResult(result);
      writeAuthSessionChanged(res);
      finishProxyRequest(requestTrace, ProxyRequestOutcome.AuthSessionChanged);
      return;
    }

    if (shouldRefreshLobsterAIToken(result.status) && tokenRefresher) {
      const latestAccessToken = tokenGetter?.()?.accessToken;
      if (latestAccessToken && latestAccessToken !== tokens.accessToken) {
        result = await forwardRequest(
          upstreamUrl,
          req.method || 'POST',
          latestAccessToken,
          upstreamBody,
          req.headers,
          clientVersion,
          requestTrace.traceparent,
        );
        if (!isProxySessionKeyCurrent(requestSessionKey, sessionKeyGetter)) {
          cancelUpstreamResult(result);
          writeAuthSessionChanged(res);
          finishProxyRequest(requestTrace, ProxyRequestOutcome.AuthSessionChanged);
          return;
        }
        if (result.status !== 401) {
          pipeResponse(result, res, inspectionContext, requestTrace);
          return;
        }
      }

      console.log('[OpenClawTokenProxy] received 401, attempting token refresh');
      const refreshResult = await tokenRefresher(AuthRefreshReason.OpenClawProxy);
      if (!isProxySessionKeyCurrent(requestSessionKey, sessionKeyGetter)) {
        writeAuthSessionChanged(res);
        finishProxyRequest(requestTrace, ProxyRequestOutcome.AuthSessionChanged);
        return;
      }
      if (refreshResult.accessToken) {
        const retryResult = await forwardRequest(
          upstreamUrl,
          req.method || 'POST',
          refreshResult.accessToken,
          upstreamBody,
          req.headers,
          clientVersion,
          requestTrace.traceparent,
        );
        if (!isProxySessionKeyCurrent(requestSessionKey, sessionKeyGetter)) {
          cancelUpstreamResult(retryResult);
          writeAuthSessionChanged(res);
          finishProxyRequest(requestTrace, ProxyRequestOutcome.AuthSessionChanged);
          return;
        }
        pipeResponse(retryResult, res, inspectionContext, requestTrace);
        return;
      }
      if (isTemporaryAuthRefreshFailure(refreshResult)) {
        writeTemporaryAuthRefreshFailure(res);
        finishProxyRequest(requestTrace, ProxyRequestOutcome.AuthRefreshUnavailable);
        return;
      }
    }

    pipeResponse(result, res, inspectionContext, requestTrace);
  } catch (err) {
    console.error('[OpenClawTokenProxy] request handling error:', err);
    finishProxyRequest(requestTrace, ProxyRequestOutcome.ProxyError);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token proxy upstream error' }));
    }
  }
}

type UpstreamResult = {
  status: number;
  headers: Record<string, string>;
  body: NodeJS.ReadableStream | Buffer;
  isStream: boolean;
};

function cancelUpstreamResult(result: UpstreamResult): void {
  if (Buffer.isBuffer(result.body)) return;
  const body = result.body as NodeJS.ReadableStream & {
    cancel?: (reason?: unknown) => Promise<void>;
    destroy?: () => void;
    destroyed?: boolean;
  };
  try {
    if (typeof body.destroy === 'function' && !body.destroyed) {
      body.destroy();
      return;
    }
    if (typeof body.cancel === 'function') {
      void body.cancel('Authenticated account changed').catch(error => {
        console.debug('[OpenClawTokenProxy] stale upstream cancellation failed:', error);
      });
    }
  } catch (error) {
    console.debug('[OpenClawTokenProxy] stale upstream cancellation failed:', error);
  }
}

type ParsedProxySSEPacket = {
  event: string;
  payload: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toOptionalRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isGeminiModel(model: unknown): boolean {
  return typeof model === 'string' && model.toLowerCase().includes('gemini');
}

function shouldHydrateGeminiChatCompletionsBody(url?: string): boolean {
  const path = url?.split('?')[0] ?? '';
  return path.endsWith('/chat/completions');
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getGoogleThoughtSignatureFromExtraContent(extraContent: unknown): string | null {
  const extraContentObj = toOptionalRecord(extraContent);
  const googleObj = toOptionalRecord(extraContentObj?.google);
  return toNonEmptyString(googleObj?.thought_signature);
}

function getGeminiThoughtSignature(toolCallObj: Record<string, unknown>): string | null {
  const functionObj = toOptionalRecord(toolCallObj.function);
  return getGoogleThoughtSignatureFromExtraContent(toolCallObj.extra_content)
    ?? getGoogleThoughtSignatureFromExtraContent(functionObj?.extra_content)
    ?? toNonEmptyString(functionObj?.thought_signature);
}

function withGoogleThoughtSignature(extraContent: unknown, signature: string): Record<string, unknown> {
  const extraContentObj = toOptionalRecord(extraContent);
  const nextExtraContent = extraContentObj ? { ...extraContentObj } : {};
  const googleObj = toOptionalRecord(nextExtraContent.google);
  nextExtraContent.google = {
    ...(googleObj ?? {}),
    thought_signature: signature,
  };
  return nextExtraContent;
}

function ensureGeminiToolCallThoughtSignature(toolCallObj: Record<string, unknown>): boolean {
  const functionObj = toOptionalRecord(toolCallObj.function);
  const signature = getGeminiThoughtSignature(toolCallObj)
    ?? GEMINI_FALLBACK_THOUGHT_SIGNATURE;
  let changed = false;

  if (getGoogleThoughtSignatureFromExtraContent(toolCallObj.extra_content) !== signature) {
    toolCallObj.extra_content = withGoogleThoughtSignature(toolCallObj.extra_content, signature);
    changed = true;
  }

  if (functionObj) {
    if (getGoogleThoughtSignatureFromExtraContent(functionObj.extra_content) !== signature) {
      functionObj.extra_content = withGoogleThoughtSignature(functionObj.extra_content, signature);
      changed = true;
    }

    if (functionObj.thought_signature !== signature) {
      functionObj.thought_signature = signature;
      changed = true;
    }
  }

  return changed;
}

function hydrateGeminiToolCallThoughtSignatures(body: unknown): boolean {
  const bodyObj = toOptionalRecord(body);
  if (!bodyObj || !isGeminiModel(bodyObj.model)) {
    return false;
  }

  let changed = false;
  for (const message of toArray(bodyObj.messages)) {
    const messageObj = toOptionalRecord(message);
    if (!messageObj) {
      continue;
    }

    for (const toolCall of toArray(messageObj.tool_calls)) {
      const toolCallObj = toOptionalRecord(toolCall);
      if (!toolCallObj) {
        continue;
      }

      changed = ensureGeminiToolCallThoughtSignature(toolCallObj) || changed;
    }
  }

  return changed;
}

function hydrateGeminiChatCompletionsBody(body: Buffer): Buffer {
  if (body.length === 0) {
    return body;
  }

  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (!hydrateGeminiToolCallThoughtSignatures(parsed)) {
      return body;
    }
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return body;
  }
}

function getErrorMessage(value: Record<string, unknown>): string {
  const nestedError = value.error;
  if (isRecord(nestedError) && typeof nestedError.message === 'string') {
    return nestedError.message;
  }
  if (typeof value.message === 'string') {
    return value.message;
  }
  return '';
}

function getErrorCode(value: Record<string, unknown>): string | number | undefined {
  const nestedError = value.error;
  if (
    isRecord(nestedError)
    && (typeof nestedError.code === 'string' || typeof nestedError.code === 'number')
  ) {
    return nestedError.code;
  }
  if (typeof value.code === 'string' || typeof value.code === 'number') {
    return value.code;
  }
  return undefined;
}

function parseProxySSEPacket(packet: string): ParsedProxySSEPacket {
  const lines = packet.split(/\r?\n/);
  const dataLines: string[] = [];
  let event = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    event,
    payload: dataLines.join('\n'),
  };
}

const ProxySSETerminalKind = {
  Done: 'done',
  FinishReason: 'finish_reason',
  MessageStop: 'message_stop',
  Error: 'error',
} as const;
type ProxySSETerminalKindValue =
  typeof ProxySSETerminalKind[keyof typeof ProxySSETerminalKind];

const PROXY_SSE_TERMINAL_KIND_PRIORITY: Record<ProxySSETerminalKindValue, number> = {
  [ProxySSETerminalKind.FinishReason]: 1,
  [ProxySSETerminalKind.MessageStop]: 2,
  [ProxySSETerminalKind.Done]: 3,
  [ProxySSETerminalKind.Error]: 4,
};

// Tracks SSE completion without logging individual chunks. Upstream connection
// resets can surface as a clean 'end' with no terminal packet, which downstream
// OpenClaw would otherwise treat as a completed turn.
type ProxyResponseInspectionContext = {
  requestEnterpriseSession: EnterpriseAuthSessionSnapshot;
  onEnterpriseMembershipRevoked: (
    event: OpenClawTokenProxyMembershipRevocationEvent
  ) => void;
};

type ProxySSEStreamScanState = {
  requestTrace?: ProxyRequestTrace;
  sawTerminalPacket: boolean;
  terminalKind: ProxySSETerminalKindValue | null;
  eventCount: number;
  startedAt: number;
  downstreamClosedAt: number | null;
  downstreamCancellationRequested: boolean;
  upstreamSettled: boolean;
  inspectionContext?: ProxyResponseInspectionContext;
  membershipRevocationNotified: boolean;
};

function createProxySSEStreamScanState(
  now = Date.now(),
  inspectionContext?: ProxyResponseInspectionContext,
  requestTrace?: ProxyRequestTrace,
): ProxySSEStreamScanState {
  return {
    requestTrace,
    sawTerminalPacket: false,
    terminalKind: null,
    eventCount: 0,
    startedAt: now,
    downstreamClosedAt: null,
    downstreamCancellationRequested: false,
    upstreamSettled: false,
    inspectionContext,
    membershipRevocationNotified: false,
  };
}

function classifyTerminalProxySSEPacket(
  packet: ParsedProxySSEPacket,
): ProxySSETerminalKindValue | null {
  const { event, payload } = packet;
  if (!payload) {
    return null;
  }
  if (event === 'error') {
    return ProxySSETerminalKind.Error;
  }
  if (payload === '[DONE]') {
    return ProxySSETerminalKind.Done;
  }
  // Explicit upstream error payloads must pass through untouched so the client
  // receives the error details instead of a connection reset.
  if (event === 'message_stop') {
    return ProxySSETerminalKind.MessageStop;
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    if (parsed.type === 'error' || parsed.error != null) {
      return ProxySSETerminalKind.Error;
    }
    if (parsed.type === 'message_stop') {
      return ProxySSETerminalKind.MessageStop;
    }
    for (const choice of toArray(parsed.choices)) {
      if (isRecord(choice) && choice.finish_reason != null && choice.finish_reason !== '') {
        return ProxySSETerminalKind.FinishReason;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isTerminalProxySSEPacket(packet: ParsedProxySSEPacket): boolean {
  return classifyTerminalProxySSEPacket(packet) !== null;
}

function recordProxySSETerminalKind(
  scanState: ProxySSEStreamScanState,
  terminalKind: ProxySSETerminalKindValue,
): void {
  scanState.sawTerminalPacket = true;
  if (
    scanState.terminalKind === null
    || PROXY_SSE_TERMINAL_KIND_PRIORITY[terminalKind]
      > PROXY_SSE_TERMINAL_KIND_PRIORITY[scanState.terminalKind]
  ) {
    scanState.terminalKind = terminalKind;
  }
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

type StructuredProxyError = Omit<OpenClawTokenProxyQuotaError, 'capturedAt'>;

function extractStructuredProxyError(
  payload: string,
  event = '',
): StructuredProxyError | null {
  if (!payload || payload === '[DONE]') {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const message = getErrorMessage(parsed);
    const code = getErrorCode(parsed);
    const isErrorPayload = event === 'error'
      || parsed.type === 'error'
      || parsed.error != null
      || (!event && code !== undefined && String(code) !== '0');
    if (!isErrorPayload) {
      return null;
    }

    return {
      message: message || payload,
      ...(code !== undefined ? { code } : {}),
    };
  } catch {
    return null;
  }
}

function extractQuotaErrorFromProxyErrorPayload(
  payload: string,
  event = '',
): StructuredProxyError | null {
  const proxyError = extractStructuredProxyError(payload, event);
  if (proxyError) {
    const searchable = `${proxyError.message} ${proxyError.code ?? ''} ${payload}`;
    return isLobsterAIQuotaExhaustedError(searchable) ? proxyError : null;
  }
  return event === 'error' && isLobsterAIQuotaExhaustedError(payload)
    ? { message: payload }
    : null;
}

function isEnterpriseMembershipRevocationError(error: StructuredProxyError | null): boolean {
  if (!error || error.code === undefined) {
    return false;
  }
  if (typeof error.code === 'number') {
    return error.code === EnterpriseApiErrorCode.NotMember;
  }
  if (/^\d+$/.test(error.code.trim())) {
    return Number(error.code.trim()) === EnterpriseApiErrorCode.NotMember;
  }
  return false;
}

function notifyEnterpriseMembershipRevoked(
  error: StructuredProxyError | null,
  scanState?: ProxySSEStreamScanState,
): void {
  if (
    !isEnterpriseMembershipRevocationError(error)
    || !scanState?.inspectionContext
    || scanState.membershipRevocationNotified
  ) {
    return;
  }

  scanState.membershipRevocationNotified = true;
  try {
    scanState.inspectionContext.onEnterpriseMembershipRevoked({
      code: EnterpriseApiErrorCode.NotMember,
      requestSession: scanState.inspectionContext.requestEnterpriseSession,
    });
  } catch (error) {
    console.warn('[OpenClawTokenProxy] failed to invalidate revoked enterprise session:', error);
  }
}

function extractQuotaErrorFromProxySSEPacket(
  packet: string,
): Omit<OpenClawTokenProxyQuotaError, 'capturedAt'> | null {
  const parsed = parseProxySSEPacket(packet);
  return extractQuotaErrorFromProxyErrorPayload(parsed.payload, parsed.event);
}

function rememberQuotaError(error: Omit<OpenClawTokenProxyQuotaError, 'capturedAt'>, now = Date.now()): void {
  recentQuotaError = {
    ...error,
    capturedAt: now,
  };
}

function inspectProxySSEPacket(
  packet: string,
  now: number,
  scanState?: ProxySSEStreamScanState,
): void {
  const parsed = parseProxySSEPacket(packet);
  const proxyError = extractStructuredProxyError(parsed.payload, parsed.event);
  const quotaError = extractQuotaErrorFromProxyErrorPayload(parsed.payload, parsed.event);
  if (quotaError) {
    rememberQuotaError(quotaError, now);
  }
  notifyEnterpriseMembershipRevoked(proxyError, scanState);
  if (!scanState) {
    return;
  }

  if (parsed.event || parsed.payload) {
    scanState.eventCount += 1;
  }
  const terminalKind = classifyTerminalProxySSEPacket(parsed);
  if (terminalKind) {
    recordProxySSETerminalKind(scanState, terminalKind);
  }
}

function scanProxySSEBufferForQuotaError(
  buffer: string,
  now = Date.now(),
  scanState?: ProxySSEStreamScanState,
): string {
  let remaining = buffer;
  let boundary = findSSEPacketBoundary(remaining);

  while (boundary) {
    const packet = remaining.slice(0, boundary.index);
    remaining = remaining.slice(boundary.index + boundary.separatorLength);

    inspectProxySSEPacket(packet, now, scanState);

    boundary = findSSEPacketBoundary(remaining);
  }

  return remaining.length <= MAX_PROXY_SSE_SCAN_BUFFER_CHARS
    ? remaining
    : remaining.slice(-MAX_PROXY_SSE_SCAN_BUFFER_CHARS);
}

function flushProxySSEBufferForQuotaError(
  buffer: string,
  now = Date.now(),
  scanState?: ProxySSEStreamScanState,
): void {
  const remaining = scanProxySSEBufferForQuotaError(buffer, now, scanState);
  if (!remaining.trim()) {
    return;
  }
  inspectProxySSEPacket(remaining, now, scanState);
}

function scanProxyBodyForQuotaError(
  body: Buffer,
  now = Date.now(),
  inspectionContext?: ProxyResponseInspectionContext,
): void {
  const text = body.toString('utf8');
  const proxyError = extractStructuredProxyError(text);
  const quotaError = extractQuotaErrorFromProxyErrorPayload(text);
  if (quotaError) {
    rememberQuotaError(quotaError, now);
  }
  if (isEnterpriseMembershipRevocationError(proxyError) && inspectionContext) {
    try {
      inspectionContext.onEnterpriseMembershipRevoked({
        code: EnterpriseApiErrorCode.NotMember,
        requestSession: inspectionContext.requestEnterpriseSession,
      });
    } catch (error) {
      console.warn('[OpenClawTokenProxy] failed to invalidate revoked enterprise session:', error);
    }
  }
}

async function forwardRequest(
  url: string,
  method: string,
  accessToken: string,
  body: Buffer,
  incomingHeaders: http.IncomingHttpHeaders,
  clientVersion: string,
  traceparent: string,
): Promise<UpstreamResult> {
  let accountContextHeaders: Record<string, string> = {};
  try {
    accountContextHeaders = accountContextHeadersGetter?.() ?? {};
  } catch (error) {
    console.warn('[OpenClawTokenProxy] failed to read account context headers; forwarding with token only:', error);
  }
  const headers = buildUpstreamRequestHeaders(
    accessToken,
    incomingHeaders,
    clientVersion,
    accountContextHeaders,
    traceparent,
  );

  const resp = await net.fetch(url, {
    method,
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  });

  const contentType = resp.headers.get('content-type') || '';
  const isStream = contentType.includes('text/event-stream');

  const responseHeaders: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  if (isStream && resp.body) {
    return {
      status: resp.status,
      headers: responseHeaders,
      body: resp.body as unknown as NodeJS.ReadableStream,
      isStream: true,
    };
  }

  const respBuffer = Buffer.from(await resp.arrayBuffer());
  return {
    status: resp.status,
    headers: responseHeaders,
    body: respBuffer,
    isStream: false,
  };
}

function buildUpstreamRequestHeaders(
  accessToken: string,
  incomingHeaders: http.IncomingHttpHeaders,
  clientVersion: string,
  accountContextHeaders: Record<string, string> = {},
  traceparent?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...accountContextHeaders,
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': incomingHeaders['content-type'] || 'application/json',
    [LOBSTERAI_CLIENT_CAPABILITIES_HEADER]: LOBSTERAI_CLIENT_CAPABILITIES,
    [LOBSTERAI_CLIENT_VERSION_HEADER]: clientVersion,
    ...(traceparent ? { [LLM_TRACEPARENT_HEADER]: traceparent } : {}),
  };

  // Forward accept header for SSE streaming
  if (incomingHeaders.accept) {
    headers['Accept'] = incomingHeaders.accept;
  }

  return headers;
}

function pipeResponse(
  result: UpstreamResult,
  res: http.ServerResponse,
  inspectionContext?: ProxyResponseInspectionContext,
  requestTrace?: ProxyRequestTrace,
): void {
  if (requestTrace) {
    requestTrace.status = result.status;
    requestTrace.serverTraceId = result.headers[LOBSTER_SERVER_TRACE_ID_HEADER] ?? null;
  }
  res.writeHead(result.status, result.headers);

  if (result.isStream) {
    pipeStreamingResponseWithQuotaScan(result.body, res, inspectionContext, requestTrace);
  } else if (Buffer.isBuffer(result.body)) {
    scanProxyBodyForQuotaError(result.body, Date.now(), inspectionContext);
    res.end(result.body);
    finishProxyRequest(
      requestTrace,
      result.status >= 200 && result.status < 300 ? ProxyRequestOutcome.Completed : ProxyRequestOutcome.HttpError,
    );
  } else {
    pipeWebReadableResponseWithQuotaScan(result.body as unknown as ReadableStream<Uint8Array>, res);
    finishProxyRequest(requestTrace, ProxyRequestOutcome.Completed, 'body=unscanned');
  }
}

function isNodeReadableStream(body: unknown): body is NodeJS.ReadableStream {
  return Boolean(
    body
    && typeof body === 'object'
    && typeof (body as NodeJS.ReadableStream).on === 'function',
  );
}

function pipeStreamingResponseWithQuotaScan(
  body: NodeJS.ReadableStream | Buffer,
  res: http.ServerResponse,
  inspectionContext?: ProxyResponseInspectionContext,
  requestTrace?: ProxyRequestTrace,
): void {
  if (Buffer.isBuffer(body)) {
    scanProxyBodyForQuotaError(body, Date.now(), inspectionContext);
    res.end(body);
    finishProxyRequest(requestTrace, ProxyRequestOutcome.Completed);
    return;
  }

  // SSE responses must end with a terminal packet ([DONE], finish_reason, or an
  // error payload). Anything else is a truncated stream and must not be
  // presented to the client as a cleanly completed response.
  const scanState = createProxySSEStreamScanState(Date.now(), inspectionContext, requestTrace);

  if (isNodeReadableStream(body)) {
    pipeNodeReadableResponseWithQuotaScan(body, res, scanState);
    return;
  }

  pipeWebReadableResponseWithQuotaScan(body as unknown as ReadableStream<Uint8Array>, res, scanState);
}

// Destroying the response mid-stream aborts the chunked encoding, so the
// client observes a network error instead of a clean end and can retry or
// surface the failure. res.destroy() must stay argument-less: passing an error
// would re-emit it on the response with no listener attached.
function abortProxyResponse(res: http.ServerResponse): void {
  if (res.destroyed) {
    return;
  }
  res.destroy();
}

function formatProxySSEOutcome(
  outcome: string,
  scanState: ProxySSEStreamScanState,
  now = Date.now(),
): string {
  const durationMs = Math.max(0, now - scanState.startedAt);
  const downstreamClosedAfterMs = scanState.downstreamClosedAt === null
    ? 'none'
    : Math.max(0, scanState.downstreamClosedAt - scanState.startedAt);
  const trace = scanState.requestTrace;
  return `[OpenClawTokenProxy] upstream SSE outcome=${outcome}`
    + (trace ? ` trace=${trace.traceId} span=${trace.spanId} serverTrace=${trace.serverTraceId ?? 'none'}` : '')
    + ` terminal=${scanState.terminalKind ?? 'none'}`
    + ` events=${scanState.eventCount}`
    + ` durationMs=${durationMs}`
    + ` downstreamClosedAfterMs=${downstreamClosedAfterMs}`;
}

// A client that closes after the terminal packet still received the whole answer.
function resolveDownstreamClosedOutcome(scanState: ProxySSEStreamScanState): ProxyRequestOutcomeValue {
  if (scanState.terminalKind === ProxySSETerminalKind.Error) return ProxyRequestOutcome.UpstreamError;
  return scanState.sawTerminalPacket ? ProxyRequestOutcome.Completed : ProxyRequestOutcome.DownstreamClosed;
}

function observeProxyResponseClose(
  res: http.ServerResponse,
  cancelUpstream: () => boolean,
  scanState?: ProxySSEStreamScanState,
): void {
  res.on('close', () => {
    if (
      scanState
      && (scanState.upstreamSettled || scanState.downstreamClosedAt !== null)
    ) {
      return;
    }
    if (scanState) {
      scanState.downstreamClosedAt = Date.now();
    }
    const cancellationRequested = cancelUpstream();
    if (scanState && cancellationRequested) {
      scanState.downstreamCancellationRequested = true;
      console.debug(formatProxySSEOutcome('downstream_closed_upstream_cancelled', scanState));
      finishProxyRequest(
        scanState.requestTrace,
        resolveDownstreamClosedOutcome(scanState),
        `events=${scanState.eventCount}`,
      );
    }
  });
}

function writeProxyResponseChunk(
  res: http.ServerResponse,
  chunk: Buffer | Uint8Array,
): void {
  if (!res.destroyed && !res.writableEnded) {
    res.write(chunk);
  }
}

function endProxyResponseAfterScan(
  res: http.ServerResponse,
  scanState?: ProxySSEStreamScanState,
): void {
  if (scanState) {
    scanState.upstreamSettled = true;
  }
  if (scanState?.downstreamCancellationRequested) {
    return;
  }
  if (scanState && scanState.downstreamClosedAt !== null) {
    if (scanState.terminalKind === ProxySSETerminalKind.Error) {
      console.error(formatProxySSEOutcome('late_error_after_downstream_close', scanState));
    } else if (scanState.sawTerminalPacket) {
      console.warn(formatProxySSEOutcome('late_completion_after_downstream_close', scanState));
    } else {
      console.error(formatProxySSEOutcome('incomplete_end_after_downstream_close', scanState));
    }
    finishProxyRequest(
      scanState.requestTrace,
      resolveDownstreamClosedOutcome(scanState),
      `events=${scanState.eventCount}`,
    );
    return;
  }
  if (scanState && !scanState.sawTerminalPacket) {
    console.error(formatProxySSEOutcome('unexpected_eof', scanState));
    finishProxyRequest(scanState.requestTrace, ProxyRequestOutcome.UnexpectedEof, `events=${scanState.eventCount}`);
    abortProxyResponse(res);
    return;
  }
  if (scanState) {
    finishProxyRequest(
      scanState.requestTrace,
      scanState.terminalKind === ProxySSETerminalKind.Error
        ? ProxyRequestOutcome.UpstreamError
        : ProxyRequestOutcome.Completed,
      `terminal=${scanState.terminalKind ?? 'none'} events=${scanState.eventCount}`,
    );
  }
  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }
}

function abortProxyResponseAfterReadError(
  res: http.ServerResponse,
  error: unknown,
  scanState?: ProxySSEStreamScanState,
): void {
  if (scanState) {
    scanState.upstreamSettled = true;
    if (scanState.downstreamCancellationRequested) {
      return;
    }
    const outcome = scanState.downstreamClosedAt === null
      ? 'transport_error'
      : 'transport_error_after_downstream_close';
    console.error(formatProxySSEOutcome(outcome, scanState), error);
    finishProxyRequest(scanState.requestTrace, ProxyRequestOutcome.TransportError, `events=${scanState.eventCount}`);
  } else {
    console.error('[OpenClawTokenProxy] upstream stream read error', error);
  }
  abortProxyResponse(res);
}

function pipeNodeReadableResponseWithQuotaScan(
  stream: NodeJS.ReadableStream,
  res: http.ServerResponse,
  scanState?: ProxySSEStreamScanState,
): void {
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let upstreamSettled = false;

  observeProxyResponseClose(res, () => {
    if (upstreamSettled) {
      return false;
    }
    const destroyableStream = stream as NodeJS.ReadableStream & {
      destroy?: () => void;
      destroyed?: boolean;
    };
    if (typeof destroyableStream.destroy !== 'function' || destroyableStream.destroyed) {
      return false;
    }
    try {
      destroyableStream.destroy();
      return true;
    } catch (error) {
      console.debug('[OpenClawTokenProxy] upstream stream cancellation failed:', error);
      return false;
    }
  }, scanState);
  res.on('error', (err) => {
    console.debug('[OpenClawTokenProxy] response write error:', err);
  });

  stream.on('data', (chunk: Buffer | Uint8Array | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sseBuffer = scanProxySSEBufferForQuotaError(
      sseBuffer + decoder.decode(buffer, { stream: true }),
      Date.now(),
      scanState,
    );
    writeProxyResponseChunk(res, buffer);
  });

  stream.on('end', () => {
    upstreamSettled = true;
    const tail = decoder.decode();
    flushProxySSEBufferForQuotaError(sseBuffer + tail, Date.now(), scanState);
    endProxyResponseAfterScan(res, scanState);
  });

  stream.on('error', (err) => {
    upstreamSettled = true;
    flushProxySSEBufferForQuotaError(sseBuffer + decoder.decode(), Date.now(), scanState);
    abortProxyResponseAfterReadError(res, err, scanState);
  });
}

function pipeWebReadableResponseWithQuotaScan(
  webStream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  scanState?: ProxySSEStreamScanState,
): void {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let upstreamSettled = false;

  observeProxyResponseClose(res, () => {
    if (upstreamSettled) {
      return false;
    }
    void reader.cancel('Downstream response closed').catch((error) => {
      console.debug('[OpenClawTokenProxy] upstream stream cancellation failed:', error);
    });
    return true;
  }, scanState);
  res.on('error', (err) => {
    console.debug('[OpenClawTokenProxy] response write error:', err);
  });

  const pump = (): void => {
    reader.read().then(({ done, value }) => {
      if (done) {
        upstreamSettled = true;
        const tail = decoder.decode();
        flushProxySSEBufferForQuotaError(sseBuffer + tail, Date.now(), scanState);
        endProxyResponseAfterScan(res, scanState);
        return;
      }

      sseBuffer = scanProxySSEBufferForQuotaError(
        sseBuffer + decoder.decode(value, { stream: true }),
        Date.now(),
        scanState,
      );
      writeProxyResponseChunk(res, value);
      pump();
    }).catch((err) => {
      upstreamSettled = true;
      flushProxySSEBufferForQuotaError(sseBuffer + decoder.decode(), Date.now(), scanState);
      abortProxyResponseAfterReadError(res, err, scanState);
    });
  };

  pump();
}

export const __openClawTokenProxyTestUtils = {
  createProxyRequestTrace,
  recordProxyRequestStarted,
  finishProxyRequest,
  ProxyRequestOutcome,
  resetTraceStats: () => traceStatsById.clear(),
  extractStructuredProxyError,
  extractQuotaErrorFromProxyErrorPayload,
  extractQuotaErrorFromProxySSEPacket,
  hydrateGeminiChatCompletionsBody,
  hydrateGeminiToolCallThoughtSignatures,
  buildUpstreamRequestHeaders,
  scanProxySSEBufferForQuotaError,
  flushProxySSEBufferForQuotaError,
  rememberQuotaError,
  isEnterpriseMembershipRevocationError,
  ProxySSETerminalKind,
  classifyTerminalProxySSEPacket,
  createProxySSEStreamScanState,
  isTerminalProxySSEPacket,
  parseProxySSEPacket,
  pipeNodeReadableResponseWithQuotaScan,
  pipeWebReadableResponseWithQuotaScan,
  pipeStreamingResponseWithQuotaScan,
  isTemporaryAuthRefreshFailure,
  isProxySessionKeyCurrent,
  shouldRefreshLobsterAIToken,
};
