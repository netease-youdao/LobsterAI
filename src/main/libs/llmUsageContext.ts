import { getCoworkLlmTrace, isValidLlmTraceId, parseLlmTraceparent } from '../../shared/cowork/llmTurnUsage';
import { type ModelPresetId, parseModelPresetId } from '../../shared/modelPresets/constants';

const MAX_CONTEXTS = 512;
export type LlmUsageContext = {
  sessionId: string;
  userMessage: string;
  modelPresetId?: unknown;
  resolvedModelId?: unknown;
  title?: string;
  owner?: string | null;
};
// Registration can persist the exact origin; cache misses recover only that origin.
let contextResolver: ((traceId: string, registration?: LlmUsageContext) => LlmUsageContext | null) | undefined;
const contexts = new Map<string, {
  context: LlmUsageContext;
  headers: Record<string, string>;
  modelPresetId: ModelPresetId | null;
  resolvedModelId: string | null;
  owner?: string | null;
}>();
let titleReporter: ((sessionId: string, title?: string) => void) | undefined;

export function configureLlmUsageContextResolver(resolver: typeof contextResolver): void {
  contextResolver = resolver;
}

export function configureUsageTitleReporter(reporter: (sessionId: string, title?: string) => void): void {
  titleReporter = reporter;
}

export function reportUsageSessionTitle(sessionId: string, title?: string): void {
  titleReporter?.(sessionId, title);
}

export const LlmUsageHeader = {
  Session: 'x-lobster-session-id',
  Turn: 'x-lobster-turn-id',
  UserMessage: 'x-lobster-user-message',
  ModelPreset: 'x-lobster-model-preset',
} as const;

/** Bind to the turn's trace, never to a global "current session" (runs can overlap). */
export function registerLlmUsageContext(
  traceId: string,
  sessionId: string,
  userMessage: string,
  selection?: { modelPresetId?: unknown; resolvedModelId?: unknown; title?: string; owner?: string },
): void {
  if (!isValidLlmTraceId(traceId) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(sessionId)) return;
  const registration = { sessionId, userMessage, ...selection };
  const context = contextResolver?.(traceId, registration) ?? registration;
  cacheLlmUsageContext(traceId, context);
  if (context.owner !== null) reportUsageSessionTitle(context.sessionId, context.title);
}

function cacheLlmUsageContext(traceId: string, context: LlmUsageContext): void {
  const userMessage = Array.from(context.userMessage).slice(0, 200).join('');
  contexts.delete(traceId);
  contexts.set(traceId, {
    context: { ...context, userMessage },
    headers: {
      [LlmUsageHeader.Session]: context.sessionId,
      [LlmUsageHeader.Turn]: traceId,
      [LlmUsageHeader.UserMessage]: encodeURIComponent(userMessage),
    },
    modelPresetId: parseModelPresetId(context.modelPresetId),
    resolvedModelId: typeof context.resolvedModelId === 'string' ? context.resolvedModelId.trim() : null,
    owner: context.owner,
  });
  while (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
}

export function getLlmUsageContext(traceId: string, owner?: string | null): LlmUsageContext | null {
  if (!isValidLlmTraceId(traceId)) return null;
  const cached = contexts.get(traceId);
  if (!cached || (owner !== undefined && cached.owner !== undefined && cached.owner !== owner)) {
    const restored = contextResolver?.(traceId);
    if (restored) cacheLlmUsageContext(traceId, restored);
  }
  return contexts.get(traceId)?.context ?? null;
}

/** Whether the client registered this trace for a turn it started. */
export function hasLlmUsageContext(traceId: string): boolean {
  return contexts.has(traceId);
}

/** A proxy-generated request trace has no registered user turn and stays ungrouped. */
export function getLlmUsageHeaders(traceparent?: string, requestModel?: unknown, owner?: string | null): Record<string, string> {
  const trace = traceparent ? parseLlmTraceparent(traceparent) : null;
  if (trace) getLlmUsageContext(trace.traceId, owner);
  const context = trace ? contexts.get(trace.traceId) : undefined;
  if (!trace || !context) return {};
  if (context.owner !== undefined && context.owner !== owner) return {};
  contexts.delete(trace.traceId);
  contexts.set(trace.traceId, context);
  // Only the model resolved for this turn carries the selected mode. Tool models,
  // synthetic traces and requests without an explicit selection remain unlabelled.
  const matchesSelection = context.modelPresetId && context.resolvedModelId
    && typeof requestModel === 'string' && requestModel.trim() === context.resolvedModelId;
  return {
    ...context.headers,
    ...(matchesSelection ? { [LlmUsageHeader.ModelPreset]: context.modelPresetId! } : {}),
  };
}

export function clearLlmUsageContexts(): void {
  contexts.clear();
}

/** Capture the same user message before any async tool work; never re-read the latest turn later. */
export function getMediaUsageContext(sessionId: string | undefined, message: { content: string; metadata?: unknown } | null | undefined) {
  const trace = getCoworkLlmTrace(message?.metadata);
  if (!sessionId || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(sessionId) || !trace || !message) return undefined;
  return { sessionId, turnId: trace.traceId, userMessage: Array.from(message.content).slice(0, 200).join('') };
}
