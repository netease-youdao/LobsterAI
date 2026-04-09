const EXPLICIT_ADD_RE = /(?:^|\n)\s*(?:请)?(?:记住|记下|保存到记忆|保存记忆|写入记忆|remember(?:\s+this|\s+that)?|store\s+(?:this|that)\s+in\s+memory)\s*[:：,，]?\s*(.+)$/gim;
const EXPLICIT_DELETE_RE = /(?:^|\n)\s*(?:请)?(?:删除记忆|从记忆中删除|忘掉|忘记这条|forget\s+this|remove\s+from\s+memory)\s*[:：,，]?\s*(.+)$/gim;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const SMALL_TALK_RE = /^(ok|okay|thanks|thank\s+you|好的|收到|明白|行|嗯|谢谢)[.!? ]*$/i;
const SHORT_FACT_SIGNAL_RE = /(我叫|我是|我的名字是|我名字是|名字叫|我有(?!\s*(?:一个|个)?问题)|我养了|我家有|\bmy\s+name\s+is\b|\bi\s+am\b|\bi['’]?m\b|\bi\s+have\b|\bi\s+own\b)/i;
const NON_DURABLE_TOPIC_RE = /(我有\s*(?:一个|个)?问题|有个问题|报错|出现异常|exception|stack\s*trace)/i;
const PERSONAL_PROFILE_SIGNAL_RE = /(我叫|我是|我的名字是|我名字是|名字叫|我住在|我来自|我是做|我的职业|\bmy\s+name\s+is\b|\bi\s+am\b|\bi['’]?m\b|\bi\s+live\s+in\b|\bi['’]?m\s+from\b|\bi\s+work\s+as\b)/i;
const PERSONAL_OWNERSHIP_SIGNAL_RE = /(我有(?!\s*(?:一个|个)?问题)|我养了|我家有|我女儿|我儿子|我的孩子|我的小狗|我的小猫|\bi\s+have\b|\bi\s+own\b|\bmy\s+(?:daughter|son|child|dog|cat)\b)/i;
const PERSONAL_PREFERENCE_SIGNAL_RE = /(我喜欢|我偏好|我习惯|我常用|我不喜欢|我讨厌|我更喜欢|\bi\s+prefer\b|\bi\s+like\b|\bi\s+usually\b|\bi\s+often\b|\bi\s+don['’]?\s*t\s+like\b|\bi\s+hate\b)/i;
const ASSISTANT_PREFERENCE_SIGNAL_RE = /((请|以后|后续|默认|请始终|不要再|请不要|优先|务必).*(回复|回答|语言|中文|英文|格式|风格|语气|简洁|详细|代码|命名|markdown|respond|reply|language|format|style|tone))/i;
const SOURCE_STYLE_LINE_RE = /^(?:来源|source)\s*[:：]/i;
const ATTACHMENT_STYLE_LINE_RE = /^(?:输入文件|input\s*file)\s*[:：]/i;
const TRANSIENT_SIGNAL_RE = /(今天|昨日|昨天|刚刚|刚才|本周|本月|news|breaking|快讯|新闻|\b(19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}\b|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日)/i;
const REQUEST_TAIL_SPLIT_RE = /[,，。]\s*(?:请|麻烦)?你(?:帮我|帮忙|给我|为我|看下|看一下|查下|查一下)|[,，。]\s*帮我|[,，。]\s*请帮我|[,，。]\s*(?:能|可以)不能?\s*帮我|[,，。]\s*你看|[,，。]\s*请你/i;
const PROCEDURAL_CANDIDATE_RE = /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const ASSISTANT_STYLE_CANDIDATE_RE = /^(?:使用|use)\s+[A-Za-z0-9._-]+\s*(?:技能|skill)/i;
const CHINESE_QUESTION_PREFIX_RE = /^(?:请问|问下|问一下|是否|能否|可否|为什么|为何|怎么|如何|谁|什么|哪(?:里|儿|个)?|几|多少|要不要|会不会|是不是|能不能|可不可以|行不行|对不对|好不好)/u;
const ENGLISH_QUESTION_PREFIX_RE = /^(?:what|who|why|how|when|where|which|is|are|am|do|does|did|can|could|would|will|should)\b/i;
const QUESTION_INLINE_RE = /(是不是|能不能|可不可以|要不要|会不会|有没有|对不对|好不好)/i;
const QUESTION_SUFFIX_RE = /(吗|么|呢|嘛)\s*$/u;

export type CoworkMemoryGuardLevel = 'strict' | 'standard' | 'relaxed';

export interface ExtractedMemoryChange {
  action: 'add' | 'delete';
  text: string;
  confidence: number;
  isExplicit: boolean;
  reason: string;
}

export interface ExtractTurnMemoryOptions {
  userText: string;
  assistantText: string;
  guardLevel: CoworkMemoryGuardLevel;
  maxImplicitAdds?: number;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function isQuestionLikeMemoryText(text: string): boolean {
  const normalized = normalizeText(text).replace(/[。！!]+$/g, '').trim();
  if (!normalized) return false;
  if (/[？?]\s*$/.test(normalized)) return true;
  if (CHINESE_QUESTION_PREFIX_RE.test(normalized)) return true;
  if (ENGLISH_QUESTION_PREFIX_RE.test(normalized)) return true;
  if (QUESTION_INLINE_RE.test(normalized)) return true;
  if (QUESTION_SUFFIX_RE.test(normalized)) return true;
  return false;
}

function shouldKeepCandidate(text: string): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) return false;
  if (trimmed.length < 6 && !SHORT_FACT_SIGNAL_RE.test(trimmed)) return false;
  if (SMALL_TALK_RE.test(trimmed)) return false;
  if (isQuestionLikeMemoryText(trimmed)) return false;
  if (ASSISTANT_STYLE_CANDIDATE_RE.test(trimmed)) return false;
  if (PROCEDURAL_CANDIDATE_RE.test(trimmed)) return false;
  return true;
}

function sanitizeImplicitCandidate(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  const tailMatch = normalized.match(REQUEST_TAIL_SPLIT_RE);
  const clipped = tailMatch?.index && tailMatch.index > 0
    ? normalized.slice(0, tailMatch.index)
    : normalized;
  return normalizeText(clipped.replace(/[，,；;:\-]+$/, ''));
}

function confidenceThreshold(level: CoworkMemoryGuardLevel): number {
  if (level === 'strict') return 0.85;
  if (level === 'relaxed') return 0.5;
  return 0.65;
}

function extractExplicit(
  text: string,
  action: 'add' | 'delete',
  pattern: RegExp,
  reason: string
): ExtractedMemoryChange[] {
  const result: ExtractedMemoryChange[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const raw = normalizeText(match[1] || '');
    if (!shouldKeepCandidate(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      action,
      text: raw,
      confidence: 0.99,
      isExplicit: true,
      reason,
    });
  }
  return result;
}

function extractImplicit(options: ExtractTurnMemoryOptions): ExtractedMemoryChange[] {
  const requestedMaxImplicitAdds = Number.isFinite(options.maxImplicitAdds)
    ? Number(options.maxImplicitAdds)
    : 2;
  const maxImplicitAdds = Math.max(0, Math.min(2, Math.floor(requestedMaxImplicitAdds)));
  if (maxImplicitAdds === 0) return [];
  const threshold = confidenceThreshold(options.guardLevel);
  const strippedUser = options.userText.replace(CODE_BLOCK_RE, ' ').trim();
  const strippedAssistant = options.assistantText.replace(CODE_BLOCK_RE, ' ').trim();
  if (!strippedUser || !strippedAssistant) return [];

  const candidates = strippedUser
    .split(/[。！？!?；;\n]/g)
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const result: ExtractedMemoryChange[] = [];
  const seen = new Set<string>();

  for (const rawCandidate of candidates) {
    const candidate = sanitizeImplicitCandidate(rawCandidate);
    if (!shouldKeepCandidate(candidate)) continue;

    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (NON_DURABLE_TOPIC_RE.test(candidate)) continue;

    if (SOURCE_STYLE_LINE_RE.test(candidate) || ATTACHMENT_STYLE_LINE_RE.test(candidate)) {
      continue;
    }
    if (TRANSIENT_SIGNAL_RE.test(candidate)
      && !PERSONAL_PROFILE_SIGNAL_RE.test(candidate)
      && !PERSONAL_OWNERSHIP_SIGNAL_RE.test(candidate)
      && !ASSISTANT_PREFERENCE_SIGNAL_RE.test(candidate)) {
      continue;
    }

    let confidence = 0;
    let reason = '';

    if (PERSONAL_PROFILE_SIGNAL_RE.test(candidate)) {
      confidence = 0.93;
      reason = 'implicit:personal-profile';
    } else if (PERSONAL_OWNERSHIP_SIGNAL_RE.test(candidate)) {
      confidence = 0.9;
      reason = 'implicit:personal-ownership';
    } else if (PERSONAL_PREFERENCE_SIGNAL_RE.test(candidate)) {
      confidence = 0.88;
      reason = 'implicit:personal-preference';
    } else if (ASSISTANT_PREFERENCE_SIGNAL_RE.test(candidate)) {
      confidence = 0.86;
      reason = 'implicit:assistant-preference';
    }

    if (confidence === 0) {
      continue;
    }
    if (confidence < threshold) continue;

    result.push({
      action: 'add',
      text: candidate,
      confidence,
      isExplicit: false,
      reason,
    });

    if (result.length >= maxImplicitAdds) break;
  }

  return result;
}

export function extractTurnMemoryChanges(options: ExtractTurnMemoryOptions): ExtractedMemoryChange[] {
  const userText = (options.userText || '').trim();
  const assistantText = (options.assistantText || '').trim();
  if (!userText || !assistantText) return [];

  const explicitAdds = extractExplicit(userText, 'add', EXPLICIT_ADD_RE, 'explicit:add-command');
  const explicitDeletes = extractExplicit(userText, 'delete', EXPLICIT_DELETE_RE, 'explicit:delete-command');
  const implicitAdds = extractImplicit(options);

  const merged: ExtractedMemoryChange[] = [];
  const seen = new Set<string>();
  for (const entry of [...explicitDeletes, ...explicitAdds, ...implicitAdds]) {
    const key = `${entry.action}|${entry.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }

  return merged;
}
