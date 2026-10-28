import crypto from 'crypto';

/**
 * Log-only diagnostics for provider prefix caching. Each model request is
 * reduced to hashes of its prompt components, then compared with the closest
 * recent request of the same conversation. A request that only appends messages keeps
 * the provider cache warm; anything else shows where the cached prefix ends.
 * Fingerprints never keep message text: the system prompt is the only text
 * held (per conversation) so a change can be located by offset and heading.
 */

/** First prompt component that differs from the previous request, in rendered order. */
export const PromptPrefixChange = {
  First: 'first',
  Append: 'append',
  Model: 'model',
  Params: 'params',
  System: 'system',
  ToolsOrder: 'tools_order',
  Tools: 'tools',
  Message: 'message',
  Truncated: 'truncated',
} as const;
export type PromptPrefixChange = typeof PromptPrefixChange[keyof typeof PromptPrefixChange];

export const PromptPrefixBoundary = {
  /** Same trace as the previous request: a tool-loop step inside one turn. */
  Step: 'step',
  /** A new trace: the first request of a new turn or run. */
  Turn: 'turn',
} as const;
export type PromptPrefixBoundary = typeof PromptPrefixBoundary[keyof typeof PromptPrefixBoundary];

const PromptRequestFormat = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
} as const;
type PromptRequestFormat = typeof PromptRequestFormat[keyof typeof PromptRequestFormat];

const PROMPT_COMPONENT_KEYS = new Set(['messages', 'tools', 'system']);
const OPENAI_SYSTEM_ROLES = new Set(['system', 'developer']);
const HASH_HEX_CHARS = 16;
const MAX_LISTED_NAMES = 5;
const MAX_HEADING_CHARS = 40;
const DEFAULT_MAX_TRACKED_CONVERSATIONS = 64;
const DEFAULT_MAX_LINEAGES_PER_CONVERSATION = 4;
const UPSTREAM_MISS_MIN_PROMPT_TOKENS = 8_000;
const UPSTREAM_MISS_MAX_CACHED_RATIO = 0.5;
const PROMPT_DRIFT_MAX_CACHED_RATIO = 0.9;

type MessageFingerprint = {
  role: string;
  hash: string;
  bytes: number;
  fields: Record<string, string>;
};

export type PromptFingerprint = {
  model: string;
  format: PromptRequestFormat;
  params: Record<string, string>;
  /** Joined system text, kept only to locate a change. */
  systemText: string;
  systemHash: string;
  systemBytes: number;
  toolNames: string[];
  toolHashes: string[];
  toolBytes: number[];
  messages: MessageFingerprint[];
  totalBytes: number;
};

export type PromptPrefixComparison = {
  change: PromptPrefixChange;
  /** Later components that also differ. */
  alsoChanged: PromptPrefixChange[];
  detail: string;
  /** Serialized bytes of the leading unchanged components (system, tools, messages). */
  stableBytes: number;
  totalBytes: number;
  previousMessages: number;
  currentMessages: number;
  /** Leading conversation messages shared with the previous request. */
  matchedMessages: number;
};

export type PromptPrefixObservation = PromptPrefixComparison & {
  boundary: PromptPrefixBoundary;
  /** Milliseconds since the previous request of this conversation started. */
  sincePreviousMs: number | null;
};

export type PromptUsage = {
  promptTokens?: number;
  cachedTokens?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, HASH_HEX_CHARS);
}

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function fingerprintMessage(message: unknown): MessageFingerprint {
  if (!isRecord(message)) {
    const json = serialize(message);
    return { role: 'unknown', hash: hashText(json), bytes: json.length, fields: { value: hashText(json) } };
  }
  const fields: Record<string, string> = {};
  let bytes = 0;
  for (const key of Object.keys(message).sort()) {
    const json = serialize(message[key]);
    fields[key] = hashText(json);
    bytes += key.length + json.length;
  }
  const hash = hashText(Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('|'));
  return { role: typeof message.role === 'string' ? message.role : 'unknown', hash, bytes, fields };
}

function resolveToolName(tool: unknown, index: number): string {
  if (isRecord(tool)) {
    if (isRecord(tool.function) && typeof tool.function.name === 'string') return tool.function.name;
    if (typeof tool.name === 'string') return tool.name;
  }
  return `#${index}`;
}

/** Returns null for bodies that are not chat-style model requests. */
export function fingerprintPromptRequest(body: unknown, totalBytes: number): PromptFingerprint | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;

  const format = body.system !== undefined ? PromptRequestFormat.Anthropic : PromptRequestFormat.OpenAI;
  let systemParts: unknown[];
  let conversation: unknown[];
  if (format === PromptRequestFormat.Anthropic) {
    systemParts = body.system === undefined ? [] : [body.system];
    conversation = body.messages;
  } else {
    let leading = 0;
    while (
      leading < body.messages.length
      && isRecord(body.messages[leading])
      && OPENAI_SYSTEM_ROLES.has(String((body.messages[leading] as Record<string, unknown>).role))
    ) {
      leading += 1;
    }
    systemParts = body.messages.slice(0, leading);
    conversation = body.messages.slice(leading);
  }

  const systemJson = serialize(systemParts);
  const systemText = systemParts
    .map(part => (format === PromptRequestFormat.Anthropic ? extractText(part) : extractText((part as Record<string, unknown>).content)))
    .join('\n');

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames: string[] = [];
  const toolHashes: string[] = [];
  const toolBytes: number[] = [];
  tools.forEach((tool, index) => {
    const json = serialize(tool);
    toolNames.push(resolveToolName(tool, index));
    toolHashes.push(hashText(json));
    toolBytes.push(json.length);
  });

  const params: Record<string, string> = {};
  for (const key of Object.keys(body).sort()) {
    if (!PROMPT_COMPONENT_KEYS.has(key)) params[key] = hashText(serialize(body[key]));
  }

  return {
    model: typeof body.model === 'string' ? body.model : 'unknown',
    format,
    params,
    systemText,
    systemHash: hashText(systemJson),
    systemBytes: systemJson.length,
    toolNames,
    toolHashes,
    toolBytes,
    messages: conversation.map(fingerprintMessage),
    totalBytes,
  };
}

/** Stable key for requests that carry no conversation id: the model plus its first message. */
export function resolvePromptAnchorKey(fingerprint: PromptFingerprint): string {
  return `${fingerprint.model}:${fingerprint.messages[0]?.hash ?? 'empty'}`;
}

function listNames(names: string[]): string {
  if (names.length <= MAX_LISTED_NAMES) return names.join(',');
  return `${names.slice(0, MAX_LISTED_NAMES).join(',')},+${names.length - MAX_LISTED_NAMES}`;
}

function sanitizeHeading(line: string): string {
  return Array.from(line.trim())
    .filter(char => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)
    .slice(0, MAX_HEADING_CHARS)
    .join('')
    .replace(/\s+/g, '_');
}

function describeSystemChange(previous: PromptFingerprint, current: PromptFingerprint): string {
  const before = previous.systemText;
  const after = current.systemText;
  if (before === after) {
    return `nonText=true prevBytes=${previous.systemBytes} curBytes=${current.systemBytes}`;
  }
  const limit = Math.min(before.length, after.length);
  let offset = 0;
  while (offset < limit && before.charCodeAt(offset) === after.charCodeAt(offset)) offset += 1;
  const lineEnd = after.indexOf('\n', offset);
  const heading = after
    .slice(0, lineEnd === -1 ? after.length : lineEnd)
    .split('\n')
    .reverse()
    .find(line => line.trimStart().startsWith('#'));
  return [
    `offset=${offset}`,
    `fromEnd=${after.length - offset}`,
    `prevChars=${before.length}`,
    `curChars=${after.length}`,
    `heading=${heading ? sanitizeHeading(heading) : 'none'}`,
  ].join(' ');
}

function compareTools(previous: PromptFingerprint, current: PromptFingerprint): {
  change: PromptPrefixChange | null;
  detail: string;
  firstDiffIndex: number;
} {
  const count = Math.max(previous.toolNames.length, current.toolNames.length);
  let firstDiffIndex = -1;
  for (let index = 0; index < count; index += 1) {
    if (previous.toolNames[index] !== current.toolNames[index]
      || previous.toolHashes[index] !== current.toolHashes[index]) {
      firstDiffIndex = index;
      break;
    }
  }
  if (firstDiffIndex === -1) return { change: null, detail: '', firstDiffIndex };

  const previousByName = new Map(previous.toolNames.map((name, index) => [name, previous.toolHashes[index]]));
  const currentByName = new Map(current.toolNames.map((name, index) => [name, current.toolHashes[index]]));
  const added = current.toolNames.filter(name => !previousByName.has(name));
  const removed = previous.toolNames.filter(name => !currentByName.has(name));
  const changed = current.toolNames.filter(name => previousByName.has(name) && previousByName.get(name) !== currentByName.get(name));
  const position = `firstIndex=${firstDiffIndex} prev=${previous.toolNames[firstDiffIndex] ?? 'none'}`
    + ` cur=${current.toolNames[firstDiffIndex] ?? 'none'} count=${previous.toolNames.length}->${current.toolNames.length}`;
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return { change: PromptPrefixChange.ToolsOrder, detail: position, firstDiffIndex };
  }
  const parts = [position];
  if (added.length) parts.push(`added=${listNames(added)}`);
  if (removed.length) parts.push(`removed=${listNames(removed)}`);
  if (changed.length) parts.push(`changed=${listNames(changed)}`);
  return { change: PromptPrefixChange.Tools, detail: parts.join(' '), firstDiffIndex };
}

function compareMessages(previous: PromptFingerprint, current: PromptFingerprint): {
  change: PromptPrefixChange | null;
  detail: string;
  firstDiffIndex: number;
} {
  const shared = Math.min(previous.messages.length, current.messages.length);
  for (let index = 0; index < shared; index += 1) {
    const before = previous.messages[index];
    const after = current.messages[index];
    if (before.hash === after.hash) continue;
    const keys = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
    const fields = [...keys].filter(key => before.fields[key] !== after.fields[key]).sort();
    return {
      change: PromptPrefixChange.Message,
      detail: [
        `index=${index}`,
        `fromPrevEnd=${previous.messages.length - index}`,
        `role=${before.role}${after.role === before.role ? '' : `->${after.role}`}`,
        `fields=${fields.join(',') || 'none'}`,
        `prevBytes=${before.bytes}`,
        `curBytes=${after.bytes}`,
      ].join(' '),
      firstDiffIndex: index,
    };
  }
  if (current.messages.length < previous.messages.length) {
    return {
      change: PromptPrefixChange.Truncated,
      detail: `kept=${current.messages.length} dropped=${previous.messages.length - current.messages.length}`,
      firstDiffIndex: current.messages.length,
    };
  }
  return { change: null, detail: '', firstDiffIndex: shared };
}

function changedParamKeys(previous: PromptFingerprint, current: PromptFingerprint): string[] {
  const keys = new Set([...Object.keys(previous.params), ...Object.keys(current.params)]);
  return [...keys].filter(key => previous.params[key] !== current.params[key]).sort();
}

function sumBytes(values: number[], end: number): number {
  let total = 0;
  for (let index = 0; index < end && index < values.length; index += 1) total += values[index];
  return total;
}

/** Compares two requests of one conversation in the order providers render them. */
export function comparePromptFingerprints(
  previous: PromptFingerprint,
  current: PromptFingerprint,
): PromptPrefixComparison {
  const changes: Array<{ change: PromptPrefixChange; detail: string }> = [];
  if (previous.model !== current.model) {
    changes.push({ change: PromptPrefixChange.Model, detail: `prev=${previous.model} cur=${current.model}` });
  }
  const paramKeys = changedParamKeys(previous, current);
  if (paramKeys.length) {
    changes.push({ change: PromptPrefixChange.Params, detail: `keys=${listNames(paramKeys)}` });
  }

  const systemChanged = previous.systemHash !== current.systemHash;
  const tools = compareTools(previous, current);
  const messages = compareMessages(previous, current);
  const systemEntry = systemChanged
    ? { change: PromptPrefixChange.System, detail: describeSystemChange(previous, current) }
    : null;
  const toolsEntry = tools.change ? { change: tools.change, detail: tools.detail } : null;
  // Anthropic renders tools before the system prompt; OpenAI-compatible
  // templates (DeepSeek, Qwen, GLM) render the system prompt first.
  const ordered = current.format === PromptRequestFormat.Anthropic
    ? [toolsEntry, systemEntry]
    : [systemEntry, toolsEntry];
  for (const entry of ordered) {
    if (entry) changes.push(entry);
  }
  if (messages.change) changes.push({ change: messages.change, detail: messages.detail });

  const systemStable = systemChanged ? 0 : current.systemBytes;
  const toolsStable = sumBytes(current.toolBytes, tools.change ? tools.firstDiffIndex : current.toolBytes.length);
  const messagesStable = sumBytes(current.messages.map(message => message.bytes), messages.firstDiffIndex);
  let stableBytes: number;
  if (paramKeys.length || previous.model !== current.model) {
    stableBytes = 0;
  } else if (current.format === PromptRequestFormat.Anthropic) {
    stableBytes = toolsStable + (tools.change ? 0 : systemStable + (systemChanged ? 0 : messagesStable));
  } else {
    stableBytes = systemStable + (systemChanged ? 0 : toolsStable + (tools.change ? 0 : messagesStable));
  }

  const [primary, ...rest] = changes;
  return {
    change: primary?.change ?? PromptPrefixChange.Append,
    alsoChanged: rest.map(entry => entry.change),
    detail: primary?.detail ?? '',
    stableBytes,
    totalBytes: current.totalBytes,
    previousMessages: previous.messages.length,
    currentMessages: current.messages.length,
    matchedMessages: messages.firstDiffIndex,
  };
}

type TrackedPromptRequest = { fingerprint: PromptFingerprint; traceId: string; at: number };

/**
 * Keeps recent requests per conversation, least recently used first. One
 * conversation can interleave unrelated prompts (a session-scoped heartbeat run
 * shares the session id and the turn's trace), so each request is compared with
 * the tracked request it shares the longest prefix with, as a prefix cache would.
 */
export class PromptPrefixTracker {
  private readonly entries = new Map<string, TrackedPromptRequest[]>();

  constructor(
    private readonly maxConversations = DEFAULT_MAX_TRACKED_CONVERSATIONS,
    private readonly maxLineagesPerConversation = DEFAULT_MAX_LINEAGES_PER_CONVERSATION,
  ) {}

  observe(key: string, traceId: string, fingerprint: PromptFingerprint, now = Date.now()): PromptPrefixObservation {
    const lineages = this.entries.get(key) ?? [];
    this.entries.delete(key);

    let bestIndex = -1;
    let best: PromptPrefixComparison | null = null;
    // Later lineages win ties, so the most recent related request is the reference.
    for (let index = 0; index < lineages.length; index += 1) {
      const comparison = comparePromptFingerprints(lineages[index].fingerprint, fingerprint);
      if (
        !best
        || comparison.stableBytes > best.stableBytes
        || (comparison.stableBytes === best.stableBytes && comparison.matchedMessages >= best.matchedMessages)
      ) {
        best = comparison;
        bestIndex = index;
      }
    }
    const related = best !== null && (best.stableBytes > 0 || best.matchedMessages > 0);
    const previous = related ? lineages[bestIndex] : null;
    const remaining = related ? lineages.filter((_, index) => index !== bestIndex) : lineages;
    const next = [...remaining, { fingerprint, traceId, at: now }];
    this.entries.set(key, next.slice(-this.maxLineagesPerConversation));
    while (this.entries.size > this.maxConversations) {
      this.entries.delete(this.entries.keys().next().value!);
    }

    if (!previous || !best) {
      return {
        change: PromptPrefixChange.First,
        alsoChanged: [],
        detail: lineages.length ? `newLineage tracked=${lineages.length}` : '',
        stableBytes: 0,
        totalBytes: fingerprint.totalBytes,
        previousMessages: 0,
        currentMessages: fingerprint.messages.length,
        matchedMessages: 0,
        boundary: PromptPrefixBoundary.Turn,
        sincePreviousMs: null,
      };
    }
    return {
      ...best,
      boundary: previous.traceId === traceId ? PromptPrefixBoundary.Step : PromptPrefixBoundary.Turn,
      sincePreviousMs: Math.max(0, now - previous.at),
    };
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Reads prompt/cache token counts from an OpenAI, DeepSeek or Anthropic stream payload. */
export function extractPromptUsage(payload: unknown): PromptUsage | null {
  if (!isRecord(payload)) return null;
  const usage = isRecord(payload.usage)
    ? payload.usage
    : isRecord(payload.message) && isRecord(payload.message.usage) ? payload.message.usage : null;
  if (!usage) return null;
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const cachedTokens = toFiniteNumber(details?.cached_tokens)
    ?? toFiniteNumber(usage.prompt_cache_hit_tokens)
    ?? toFiniteNumber(usage.cache_read_input_tokens);
  let promptTokens = toFiniteNumber(usage.prompt_tokens);
  const inputTokens = toFiniteNumber(usage.input_tokens);
  if (promptTokens === undefined && inputTokens !== undefined) {
    // Anthropic reports uncached input separately from cache reads and writes.
    promptTokens = inputTokens
      + (toFiniteNumber(usage.cache_read_input_tokens) ?? 0)
      + (toFiniteNumber(usage.cache_creation_input_tokens) ?? 0);
  }
  if (promptTokens === undefined && cachedTokens === undefined) return null;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

export function mergePromptUsage(previous: PromptUsage | undefined, next: PromptUsage): PromptUsage {
  return {
    promptTokens: next.promptTokens ?? previous?.promptTokens,
    cachedTokens: next.cachedTokens ?? previous?.cachedTokens,
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const PROMPT_DRIFT_CHANGES = new Set<PromptPrefixChange>([
  PromptPrefixChange.Model,
  PromptPrefixChange.Params,
  PromptPrefixChange.System,
  PromptPrefixChange.ToolsOrder,
  PromptPrefixChange.Tools,
  PromptPrefixChange.Message,
]);

/**
 * Names the likely side of a cache miss: an unchanged prefix that still missed
 * points at the upstream; a changed prefix that missed points at the prompt.
 */
export function resolvePromptCacheSuspect(
  observation: PromptPrefixObservation,
  usage: PromptUsage | undefined,
): 'upstream' | 'prompt' | null {
  if (usage?.promptTokens === undefined || usage.cachedTokens === undefined || usage.promptTokens <= 0) return null;
  const cachedRatio = usage.cachedTokens / usage.promptTokens;
  if (
    observation.change === PromptPrefixChange.Append
    && usage.promptTokens >= UPSTREAM_MISS_MIN_PROMPT_TOKENS
    && cachedRatio < UPSTREAM_MISS_MAX_CACHED_RATIO
  ) {
    return 'upstream';
  }
  if (PROMPT_DRIFT_CHANGES.has(observation.change) && cachedRatio < PROMPT_DRIFT_MAX_CACHED_RATIO) {
    return 'prompt';
  }
  return null;
}

/** Whether the observation is routine enough for debug level. */
export function isRoutinePromptPrefixObservation(observation: PromptPrefixObservation): boolean {
  return observation.boundary === PromptPrefixBoundary.Step && observation.change === PromptPrefixChange.Append;
}

export function formatPromptPrefixObservation(
  observation: PromptPrefixObservation,
  usage: PromptUsage | undefined,
): string {
  const parts = [
    `boundary=${observation.boundary}`,
    `change=${observation.change}`,
  ];
  if (observation.alsoChanged.length) parts.push(`also=${observation.alsoChanged.join(',')}`);
  if (observation.detail) parts.push(observation.detail);
  parts.push(
    `messages=${observation.previousMessages}->${observation.currentMessages}`,
    `stableBytes=${observation.stableBytes}/${observation.totalBytes}`
      + (observation.totalBytes > 0 ? `(${formatPercent(observation.stableBytes / observation.totalBytes)})` : ''),
    `sincePrevMs=${observation.sincePreviousMs ?? 'none'}`,
  );
  if (usage?.promptTokens !== undefined) {
    const cached = usage.cachedTokens;
    parts.push(
      `promptTokens=${usage.promptTokens}`,
      `cachedTokens=${cached ?? 'unknown'}`
        + (cached !== undefined && usage.promptTokens > 0 ? `(${formatPercent(cached / usage.promptTokens)})` : ''),
    );
  } else {
    parts.push('usage=none');
  }
  const suspect = resolvePromptCacheSuspect(observation, usage);
  if (suspect) parts.push(`suspect=${suspect}`);
  return parts.join(' ');
}
