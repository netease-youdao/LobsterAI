import { resolveCurrentApiConfig } from './claudeSettings';
import type { CoworkMemoryGuardLevel } from './coworkMemoryExtractor';
import { isQuestionLikeMemoryText } from './coworkMemoryExtractor';

const FACTUAL_PROFILE_RE = /(我叫|我是|我的名字|我名字|我来自|我住在|我的职业|我有(?!\s*(?:一个|个)?问题)|我养了|我喜欢|我偏好|我习惯|\bmy\s+name\s+is\b|\bi\s+am\b|\bi['’]?m\b|\bi\s+live\s+in\b|\bi['’]?m\s+from\b|\bi\s+work\s+as\b|\bi\s+have\b|\bi\s+prefer\b|\bi\s+like\b|\bi\s+usually\b)/i;
const TRANSIENT_RE = /(今天|昨日|昨天|刚刚|刚才|本周|本月|临时|暂时|这次|当前|today|yesterday|this\s+week|this\s+month|temporary|for\s+now)/i;
const PROCEDURAL_RE = /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const REQUEST_STYLE_RE = /^(?:请|麻烦|帮我|请你|帮忙|请帮我|use|please|can you|could you|would you)/i;
const ASSISTANT_STYLE_RE = /((请|以后|后续|默认|请始终|不要再|请不要|优先|务必).*(回复|回答|语言|中文|英文|格式|风格|语气|简洁|详细|代码|命名|markdown|respond|reply|language|format|style|tone))/i;
const LLM_BORDERLINE_MARGIN = 0.08;
const LLM_MIN_CONFIDENCE = 0.55;
const LLM_TIMEOUT_MS = 5000;
const LLM_CACHE_MAX_SIZE = 256;
const LLM_CACHE_TTL_MS = 10 * 60 * 1000;
const LLM_INPUT_MAX_CHARS = 280;

export interface MemoryJudgeInput {
  text: string;
  isExplicit: boolean;
  guardLevel: CoworkMemoryGuardLevel;
  llmEnabled?: boolean;
}

export interface MemoryJudgeResult {
  accepted: boolean;
  score: number;
  reason: string;
  source: 'rule' | 'llm';
}

type CachedLlmJudgeResult = {
  value: MemoryJudgeResult;
  createdAt: number;
};

const llmJudgeCache = new Map<string, CachedLlmJudgeResult>();

function thresholdByGuardLevel(isExplicit: boolean, guardLevel: CoworkMemoryGuardLevel): number {
  if (isExplicit) {
    if (guardLevel === 'strict') return 0.7;
    if (guardLevel === 'relaxed') return 0.52;
    return 0.6;
  }
  if (guardLevel === 'strict') return 0.8;
  if (guardLevel === 'relaxed') return 0.62;
  return 0.72;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function shouldCallLlmForBoundaryCase(score: number, threshold: number, reason: string): boolean {
  if (reason === 'empty' || reason === 'question-like' || reason === 'procedural-like') {
    return false;
  }
  return Math.abs(score - threshold) <= LLM_BORDERLINE_MARGIN;
}

function buildLlmCacheKey(input: MemoryJudgeInput): string {
  return `${input.guardLevel}|${input.isExplicit ? 1 : 0}|${normalizeText(input.text)}`;
}

function getCachedLlmResult(key: string): MemoryJudgeResult | null {
  const cached = llmJudgeCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > LLM_CACHE_TTL_MS) {
    llmJudgeCache.delete(key);
    return null;
  }
  // LRU: Map iteration order follows insertion; move this key to the end on hit.
  llmJudgeCache.delete(key);
  llmJudgeCache.set(key, cached);
  return cached.value;
}

function setCachedLlmResult(key: string, value: MemoryJudgeResult): void {
  if (llmJudgeCache.has(key)) {
    llmJudgeCache.delete(key);
  }
  llmJudgeCache.set(key, { value, createdAt: Date.now() });
  while (llmJudgeCache.size > LLM_CACHE_MAX_SIZE) {
    const oldestKey = llmJudgeCache.keys().next().value;
    if (!oldestKey || typeof oldestKey !== 'string') break;
    llmJudgeCache.delete(oldestKey);
  }
}

function scoreMemoryText(text: string): { score: number; reason: string } {
  const normalized = normalizeText(text);
  if (!normalized) return { score: 0, reason: 'empty' };
  if (isQuestionLikeMemoryText(normalized)) {
    return { score: 0.05, reason: 'question-like' };
  }

  let score = 0.5;
  let strongestReason = 'neutral';

  if (FACTUAL_PROFILE_RE.test(normalized)) {
    score += 0.28;
    strongestReason = 'factual-personal';
  }
  if (ASSISTANT_STYLE_RE.test(normalized)) {
    score += 0.1;
    strongestReason = strongestReason === 'neutral' ? 'assistant-preference' : strongestReason;
  }
  if (REQUEST_STYLE_RE.test(normalized)) {
    score -= 0.14;
    if (strongestReason === 'neutral') strongestReason = 'request-like';
  }
  if (TRANSIENT_RE.test(normalized)) {
    score -= 0.18;
    if (strongestReason === 'neutral') strongestReason = 'transient-like';
  }
  if (PROCEDURAL_RE.test(normalized)) {
    score -= 0.4;
    strongestReason = 'procedural-like';
  }
  if (normalized.length < 6) {
    score -= 0.2;
  } else if (normalized.length <= 120) {
    score += 0.06;
  } else if (normalized.length > 240) {
    score -= 0.08;
  }

  return { score: clamp01(score), reason: strongestReason };
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/messages';
  }
  if (normalized.endsWith('/v1/messages')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

function extractTextFromAnthropicResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const block = item as Record<string, unknown>;
        return typeof block.text === 'string' ? block.text : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content === 'string') return content.trim();
  if (typeof record.output_text === 'string') return record.output_text.trim();
  return '';
}

function parseLlmJudgePayload(text: string): { accepted: boolean; confidence: number; reason: string } | null {
  if (!text.trim()) return null;
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() || trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;

  try {
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
    const acceptedRaw = parsed.accepted;
    const decisionRaw = parsed.decision;
    const confidenceRaw = parsed.confidence;
    const reasonRaw = parsed.reason;

    const accepted =
      typeof acceptedRaw === 'boolean'
        ? acceptedRaw
        : typeof decisionRaw === 'string'
          ? /(accept|allow|yes|true|pass)/i.test(decisionRaw)
          : false;
    const confidence = clamp01(
      typeof confidenceRaw === 'number'
        ? confidenceRaw
        : typeof confidenceRaw === 'string'
          ? Number(confidenceRaw)
          : 0
    );
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : 'llm';
    return { accepted, confidence, reason };
  } catch {
    return null;
  }
}

async function judgeWithLlm(
  input: MemoryJudgeInput,
  ruleScore: number,
  threshold: number,
  ruleReason: string
): Promise<MemoryJudgeResult | null> {
  const { config } = resolveCurrentApiConfig();
  if (!config) return null;

  const url = buildAnthropicMessagesUrl(config.baseURL);
  const normalizedText = normalizeText(input.text).slice(0, LLM_INPUT_MAX_CHARS);
  if (!normalizedText) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  const systemPrompt = [
    'You classify whether a sentence is durable long-term user memory.',
    'Accept only stable personal facts or stable assistant preferences.',
    'Reject questions, temporary context, one-off tasks, and procedural command text.',
    'Return JSON only: {"accepted":boolean,"confidence":number,"reason":string}',
  ].join(' ');

  const userPrompt = JSON.stringify({
    text: normalizedText,
    is_explicit: input.isExplicit,
    guard_level: input.guardLevel,
    rule_score: Number(ruleScore.toFixed(3)),
    threshold: Number(threshold.toFixed(3)),
    rule_reason: ruleReason,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 120,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const text = extractTextFromAnthropicResponse(payload);
    const parsed = parseLlmJudgePayload(text);
    if (!parsed || parsed.confidence < LLM_MIN_CONFIDENCE) {
      return null;
    }

    return {
      accepted: parsed.accepted,
      score: parsed.confidence,
      reason: `llm:${parsed.reason || 'boundary'}`,
      source: 'llm',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function judgeMemoryCandidate(input: MemoryJudgeInput): Promise<MemoryJudgeResult> {
  const { score, reason } = scoreMemoryText(input.text);
  const threshold = thresholdByGuardLevel(input.isExplicit, input.guardLevel);
  const ruleResult: MemoryJudgeResult = {
    accepted: score >= threshold,
    score,
    reason,
    source: 'rule',
  };
  if (!shouldCallLlmForBoundaryCase(score, threshold, reason)) {
    return ruleResult;
  }
  if (!input.llmEnabled) {
    return ruleResult;
  }

  const cacheKey = buildLlmCacheKey(input);
  const cached = getCachedLlmResult(cacheKey);
  if (cached) {
    return cached;
  }

  const llmResult = await judgeWithLlm(input, score, threshold, reason);
  if (!llmResult) {
    return ruleResult;
  }
  setCachedLlmResult(cacheKey, llmResult);
  return llmResult;
}
