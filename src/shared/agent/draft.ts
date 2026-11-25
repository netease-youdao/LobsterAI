import { AgentAvatarSvg, isAgentAvatarSvg } from './avatar';
import { AGENT_DESCRIPTION_MAX_CHARS, normalizeAgentSummaryDescription } from './description';

export const AgentDraftMode = {
  Create: 'create',
  Polish: 'polish',
  Summary: 'summary',
} as const;

export type AgentDraftMode = typeof AgentDraftMode[keyof typeof AgentDraftMode];

export const AgentDraftErrorCode = {
  NoModel: 'no-model',
  UnsupportedModel: 'unsupported-model',
  EmptyInput: 'empty-input',
  RequestFailed: 'request-failed',
  ParseFailed: 'parse-failed',
  Timeout: 'timeout',
  Cancelled: 'cancelled',
} as const;

export type AgentDraftErrorCode = typeof AgentDraftErrorCode[keyof typeof AgentDraftErrorCode];

export const AgentDraftLanguage = {
  Zh: 'zh',
  En: 'en',
} as const;

export type AgentDraftLanguage = typeof AgentDraftLanguage[keyof typeof AgentDraftLanguage];

export const AgentRulePolishDirective = {
  Polish: 'polish',
  Concise: 'concise',
  ConclusionFirst: 'conclusion_first',
  Rigorous: 'rigorous',
  Friendly: 'friendly',
} as const;

export type AgentRulePolishDirective =
  typeof AgentRulePolishDirective[keyof typeof AgentRulePolishDirective];

export const AGENT_DRAFT_LIMITS = {
  MaxGoalChars: 2_000,
  MaxExistingInstructionsChars: 6_000,
  MaxFolderContextChars: 1_000,
  MaxSkillsInPrompt: 40,
  MaxNameChars: 48,
  MaxDescriptionChars: AGENT_DESCRIPTION_MAX_CHARS,
  MaxInstructionsChars: 4_000,
  MaxRecommendedSkills: 5,
  MaxStarterPrompts: 3,
  MaxStarterPromptChars: 160,
} as const;

export interface AgentDraftSkillOption {
  id: string;
  name: string;
  description?: string;
}

export interface GenerateAgentDraftRequest {
  requestId?: string;
  mode: AgentDraftMode;
  name?: string;
  goal: string;
  workingDirectory?: string;
  existingInstructions?: string;
  polishDirective?: AgentRulePolishDirective;
  includeDescription?: boolean;
  skills?: AgentDraftSkillOption[];
  language?: AgentDraftLanguage;
}

export interface AgentDraftStreamChunk {
  requestId: string;
  instructions?: string;
  description?: string;
}

export interface AgentDraftStreamPreview {
  instructions?: string;
  description?: string;
}

export interface GeneratedAgentDraft {
  name: string;
  description: string;
  instructions: string;
  avatarSvg?: AgentAvatarSvg;
  recommendedSkillIds: string[];
  starterPrompts: string[];
}

export type GenerateAgentDraftResult =
  | { success: true; draft: GeneratedAgentDraft }
  | { success: false; errorCode: AgentDraftErrorCode; error: string };

export interface AgentDraftPromptPayload {
  system: string;
  user: string;
}

const VALID_AVATAR_VALUES = Object.values(AgentAvatarSvg);
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_LETTER_RE = /[A-Za-z]/;
const POLISH_SUMMARY_LINE_PREFIX_RE = /^(?:summary|description|简介|简短描述)\s*[:：]/i;
const POLISH_SUMMARY_TAG_CANDIDATES = ['summary', 'description', '简介', '简短描述'] as const;

export function detectPreferredAgentLanguage(
  text: string,
  fallback: AgentDraftLanguage = AgentDraftLanguage.Zh,
): AgentDraftLanguage {
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  if (CJK_CHAR_RE.test(trimmed)) return AgentDraftLanguage.Zh;
  if (LATIN_LETTER_RE.test(trimmed)) return AgentDraftLanguage.En;
  return fallback;
}

const clampText = (value: unknown, maxChars: number): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars).trimEnd() : trimmed;
};

const resolvePolishDirectivePrompt = (
  directive: AgentRulePolishDirective | undefined,
  isZh: boolean,
): string | null => {
  switch (directive) {
    case AgentRulePolishDirective.Concise:
      return isZh
        ? '重点调整方向（更简洁直接）：将规则改写为强调回答简明扼要、直奔主题、避免客套和冗余铺垫；若原文中有相互冲突的语气设定，以本次调整方向为准并自然融合。'
        : 'Targeted style adjustment (More concise & direct): Rewrite the rules so responses stay brief, direct, and free of filler. Smoothly reconcile any conflicting tone rules in favor of this direction.';
    case AgentRulePolishDirective.ConclusionFirst:
      return isZh
        ? '重点调整方向（先给结论再展开）：将规则改写为强调复杂分析与较长回复先给出核心结论，再展开关键依据、步骤或细节，并与现有角色定位自然融合。'
        : 'Targeted style adjustment (Lead with conclusions): Rewrite the rules so complex analyses and longer responses lead with the core conclusion before expanding into reasoning and details.';
    case AgentRulePolishDirective.Rigorous:
      return isZh
        ? '重点调整方向（更严谨核查）：将规则改写为强调事实核查与严谨客观，涉及文件、数据和事实的结论必须基于实际读取或观察结果，不凭空臆测，并与现有角色定位自然融合。'
        : 'Targeted style adjustment (More rigorous & verified): Rewrite the rules to emphasize factual rigor and verification—ground claims about files, data, and facts in actual observed results without guessing.';
    case AgentRulePolishDirective.Friendly:
      return isZh
        ? '重点调整方向（更口语亲切）：将规则改写为语气更自然亲切、通俗易懂、少用生硬术语，同时保留原有的专业职责与核心约束。'
        : 'Targeted style adjustment (Warmer & conversational): Rewrite the rules for a more natural, approachable, easy-to-follow tone with less stiff jargon while keeping core responsibilities intact.';
    default:
      return null;
  }
};

export function buildAgentDraftPrompt(
  request: GenerateAgentDraftRequest,
  folderContext?: string,
): AgentDraftPromptPayload {
  const isZh = (request.language ?? AgentDraftLanguage.Zh) === AgentDraftLanguage.Zh;
  const mode = request.mode === AgentDraftMode.Polish
    ? AgentDraftMode.Polish
    : request.mode === AgentDraftMode.Summary
      ? AgentDraftMode.Summary
      : AgentDraftMode.Create;
  const name = clampText(request.name, AGENT_DRAFT_LIMITS.MaxNameChars);
  const goal = clampText(request.goal, AGENT_DRAFT_LIMITS.MaxGoalChars);
  const existing = clampText(request.existingInstructions, AGENT_DRAFT_LIMITS.MaxExistingInstructionsChars);
  const folder = clampText(request.workingDirectory, 260);
  const safeFolderContext = clampText(folderContext, AGENT_DRAFT_LIMITS.MaxFolderContextChars);

  if (mode === AgentDraftMode.Summary) {
    const system = isZh
      ? [
          '你是 LobsterAI 的 Agent 简介提炼助手。',
          '根据提供的 Agent 名称、角色与规则、关联文件夹或技能信息，提炼一句清晰简短的能力简介，用于界面卡片展示与多 Agent 协作任务路由。',
          '输出要求：',
          '- 仅输出一句话纯文本（15~35 字），客观第三人称描述它擅长做什么（例如“将零散资料整理为结构化周报，先给结论再列细节”）。',
          '- 不要用“你是……”，不要加引号、编号、Markdown 符号、前缀标签（如“简介：”）或任何解释。',
          '- 严格基于提供的信息，不要凭空捏造未提及的功能。',
        ].join('\n')
      : [
          'You are the Agent Summary Assistant for LobsterAI.',
          'Distill the provided agent name, role/rules, working folder, or skills into one crisp capability summary for UI cards and multi-agent task routing.',
          'Output rules:',
          '- Output ONLY one plain-text sentence (<= 100 chars) in third person describing what the agent does (e.g., "Turns rough notes into structured weekly reports, leading with conclusions").',
          '- Do NOT use second person ("You are..."), quotes, bullets, Markdown, label prefixes (such as "Summary:"), or surrounding prose.',
          '- Stay strictly grounded in the provided context without inventing capabilities.',
        ].join('\n');

    const userParts: string[] = [];
    if (name) {
      userParts.push(isZh ? `Agent 名称：${name}` : `Agent name: ${name}`);
    }
    if (existing) {
      userParts.push(isZh ? `角色与规则：\n${existing}` : `Role & rules:\n${existing}`);
    }
    if (goal && goal !== name && goal !== existing) {
      userParts.push(isZh ? `目标说明：\n${goal}` : `Goal:\n${goal}`);
    }
    if (folder) {
      userParts.push(isZh ? `关联本地文件夹：${folder}` : `Linked working folder: ${folder}`);
    }
    if (safeFolderContext) {
      userParts.push(isZh ? `文件夹概览参考：\n${safeFolderContext}` : `Folder context:\n${safeFolderContext}`);
    }
    const summarySkillLines = (request.skills ?? [])
      .slice(0, AGENT_DRAFT_LIMITS.MaxSkillsInPrompt)
      .map(skill => `- ${clampText(skill.name || skill.id, 48)}${skill.description ? `: ${clampText(skill.description, 80)}` : ''}`);
    if (summarySkillLines.length > 0) {
      userParts.push(
        (isZh ? '已配置技能：\n' : 'Configured skills:\n') + summarySkillLines.join('\n'),
      );
    }
    return {
      system,
      user: userParts.join('\n\n'),
    };
  }

  if (mode === AgentDraftMode.Polish) {
    const directiveInstruction = resolvePolishDirectivePrompt(request.polishDirective, isZh);
    const includeDescription = Boolean(request.includeDescription);
    const system = isZh
      ? [
          '你是 LobsterAI 的 Agent 规则润色助手。',
          existing
            ? '当前为“润色规则”模式：在严格保留用户原有核心意图、人设与关键约束的前提下，把「角色与规则」梳理得结构清晰、务实具体、可直接执行，去掉重复啰嗦和错别字。'
            : '当前为“生成规则”模式：根据 Agent 名称、目标和工作目录，直接生成清晰、实用、可直接生效的「角色与规则」。',
          ...(directiveInstruction ? [directiveInstruction] : []),
          '输出要求：',
          ...(includeDescription
            ? [
                '- 第 1 行严格以 `SUMMARY: ` 开头，后接一句第三人称能力简介（15~35 字，用于列表展示与多 Agent 协作识别，不要加引号）。',
                '- 空一行后，直接输出润色/生成后的「角色与规则」Markdown 正文（推荐使用简洁条目，120~350 字）。',
              ]
            : [
                '- 直接输出润色/生成后的 Markdown 正文（推荐使用简洁条目，120~350 字）。',
              ]),
          '- 不要输出 JSON，不要用 ``` 代码块包裹，不要添加任何前后缀说明或寒暄。',
          '- 不要留待填占位符，不要凭空捏造用户未提及的限制。',
        ].join('\n')
      : [
          'You are the Agent Rules Assistant for LobsterAI.',
          existing
            ? 'Mode: Polish. Preserve the user\'s core intent, persona, and constraints while rewriting the role and rules to be clearer, better structured, concise, and directly actionable.'
            : 'Mode: Polish (generate from scratch). Produce clear, practical, ready-to-use role and rules from the agent name, goal, and workspace context.',
          ...(directiveInstruction ? [directiveInstruction] : []),
          'Output rules:',
          ...(includeDescription
            ? [
                '- Line 1 MUST start with `SUMMARY: ` followed by one concise third-person sentence (<= 100 chars, no quotes) summarizing what this agent does for cards and multi-agent routing.',
                '- Follow with a blank line, then output ONLY the final Markdown instructions directly (concise bullets, 80-220 words).',
              ]
            : [
                '- Output ONLY the final Markdown instructions directly (concise bullets, 80-220 words).',
              ]),
          '- Do NOT output JSON, do NOT wrap in ``` code fences, and do NOT add any surrounding explanation.',
          '- Avoid filler and placeholders.',
        ].join('\n');

    const userParts: string[] = [];
    if (name) {
      userParts.push(isZh ? `Agent 名称：${name}` : `Agent name: ${name}`);
    }
    if (goal && goal !== name) {
      userParts.push(isZh ? `Agent 简短描述/目标：\n${goal}` : `Agent goal/description:\n${goal}`);
    }
    if (existing) {
      userParts.push(isZh ? `现有角色与规则：\n${existing}` : `Existing instructions:\n${existing}`);
    }
    if (directiveInstruction) {
      userParts.push(directiveInstruction);
    }
    if (folder) {
      userParts.push(isZh ? `关联本地文件夹：${folder}` : `Linked working folder: ${folder}`);
    }
    if (safeFolderContext) {
      userParts.push(isZh ? `文件夹概览参考：\n${safeFolderContext}` : `Folder context:\n${safeFolderContext}`);
    }
    return {
      system,
      user: userParts.join('\n\n'),
    };
  }

  const skillLines = (request.skills ?? [])
    .slice(0, AGENT_DRAFT_LIMITS.MaxSkillsInPrompt)
    .map((skill) => {
      const desc = clampText(skill.description, 100);
      return `- ${skill.id} (${clampText(skill.name, 48)})${desc ? `: ${desc}` : ''}`;
    });

  const system = isZh
    ? [
        '你是 LobsterAI 的 Agent 配置助手。你的职责是把用户的自然语言想法整理成清晰、实用、可直接生效的个人助理 Agent 设定。',
        '必须只输出一个合法 JSON 对象，不要包含任何解释、前后缀文字或多余说明。JSON 结构如下：',
        '{',
        '  "name": "简洁易记的 Agent 名称（若用户已提供名称则尽量保留）",',
        '  "description": "一句话说明该 Agent 的职责（20~40 字）",',
        '  "instructions": "直接写给该 Agent 的工作定位、执行原则与输出风格（Markdown 条目，120~400 字，务实具体，不要空洞套话，不要留待填占位符）",',
        `  "avatarSvg": "从以下枚举中选最贴合的一个：${VALID_AVATAR_VALUES.join(', ')}",`,
        '  "recommendedSkillIds": ["仅从用户提供的可用技能列表中挑选最相关的 0~5 个技能 id；无明确强相关则返回空数组"],',
        '  "starterPrompts": ["2~3 条用户可以直接发送给该 Agent 的开场任务示例，每条简短具体"]',
        '}',
        '当前为“新建 Agent”模式：即使用户只给了很短的描述或项目名，也要结合常见最佳实践生成可直接投入使用的设定。',
      ].join('\n')
    : [
        'You are the Agent Configuration Assistant for LobsterAI. Convert a user\'s plain-language goal into a crisp, practical, ready-to-use agent configuration.',
        'Output ONLY one valid JSON object with no surrounding prose. Schema:',
        '{',
        '  "name": "Concise memorable agent name (preserve user-provided name when given)",',
        '  "description": "One-sentence summary of what this agent does (<= 100 chars)",',
        '  "instructions": "Practical role, working rules, and output style written directly for the agent (Markdown bullets, 80-250 words, concrete and free of placeholders)",',
        `  "avatarSvg": "Pick the single best match from: ${VALID_AVATAR_VALUES.join(', ')}",`,
        '  "recommendedSkillIds": ["0 to 5 exact skill IDs from the provided list that strongly match; empty array if general-purpose"],',
        '  "starterPrompts": ["2 to 3 concrete, ready-to-send example prompts for this agent"]',
        '}',
        'Mode: Create. Even from a brief goal or folder name, produce sensible, immediately usable rules.',
      ].join('\n');

  const userParts: string[] = [];
  if (name) {
    userParts.push(isZh ? `Agent 名称：${name}` : `Agent name: ${name}`);
  }
  if (goal) {
    userParts.push(isZh ? `用户期望它做什么：\n${goal}` : `User goal:\n${goal}`);
  }
  if (existing) {
    userParts.push(isZh ? `现有角色与规则：\n${existing}` : `Existing instructions:\n${existing}`);
  }
  if (folder) {
    userParts.push(isZh ? `关联本地文件夹：${folder}` : `Linked working folder: ${folder}`);
  }
  if (safeFolderContext) {
    userParts.push(isZh ? `文件夹概览参考：\n${safeFolderContext}` : `Folder context:\n${safeFolderContext}`);
  }
  if (skillLines.length > 0) {
    userParts.push(
      (isZh ? '当前已启用的全局技能列表（仅供挑选 recommendedSkillIds）：\n' : 'Available enabled skills (for recommendedSkillIds):\n')
      + skillLines.join('\n'),
    );
  }

  return {
    system,
    user: userParts.join('\n\n'),
  };
}

/**
 * Strip accidental leading/trailing markdown code fences while preserving
 * live streaming whitespace inside the body.
 */
export function extractStreamingPolishInstructions(rawText: string): string {
  let text = rawText.replace(/\r\n?/g, '\n');
  const trimmedStart = text.trimStart();
  if (trimmedStart.startsWith('```')) {
    const firstNewline = trimmedStart.indexOf('\n');
    if (firstNewline === -1) return '';
    text = trimmedStart.slice(firstNewline + 1);
  } else {
    text = trimmedStart;
  }
  // Drop a trailing closing fence if already arrived at end of stream.
  text = text.replace(/\n```[ \t]*$/, '');
  return text.length > AGENT_DRAFT_LIMITS.MaxInstructionsChars
    ? text.slice(0, AGENT_DRAFT_LIMITS.MaxInstructionsChars)
    : text;
}

export function normalizePolishedInstructions(rawText: string): string {
  const cleaned = extractStreamingPolishInstructions(rawText).trim();
  if (!cleaned) return '';
  return cleaned.length > AGENT_DRAFT_LIMITS.MaxInstructionsChars
    ? cleaned.slice(0, AGENT_DRAFT_LIMITS.MaxInstructionsChars).trimEnd()
    : cleaned;
}

function isPotentialSummaryTagPrefix(firstLine: string): boolean {
  const trimmed = firstLine.trim().toLowerCase();
  if (!trimmed) return true;
  return POLISH_SUMMARY_TAG_CANDIDATES.some(tag => tag.startsWith(trimmed));
}

/**
 * Incrementally extract streamed `description` (from an optional leading
 * `SUMMARY: ...` line) and `instructions` in Polish mode without flashing the
 * tag prefix inside the rules editor.
 */
export function extractStreamingPolishPreview(
  rawText: string,
  includeDescription = false,
): AgentDraftStreamPreview {
  const cleaned = extractStreamingPolishInstructions(rawText);
  if (!cleaned) return {};
  if (!includeDescription) {
    return { instructions: cleaned };
  }

  const newlineIdx = cleaned.indexOf('\n');
  if (newlineIdx === -1) {
    if (POLISH_SUMMARY_LINE_PREFIX_RE.test(cleaned)) {
      const description = normalizeAgentSummaryDescription(
        cleaned.replace(POLISH_SUMMARY_LINE_PREFIX_RE, ''),
      );
      return description ? { description } : {};
    }
    if (isPotentialSummaryTagPrefix(cleaned)) {
      return {};
    }
    return { instructions: cleaned };
  }

  const firstLine = cleaned.slice(0, newlineIdx);
  if (!POLISH_SUMMARY_LINE_PREFIX_RE.test(firstLine)) {
    return { instructions: cleaned };
  }

  const description = normalizeAgentSummaryDescription(
    firstLine.replace(POLISH_SUMMARY_LINE_PREFIX_RE, ''),
  );
  const body = cleaned.slice(newlineIdx + 1).replace(/^(?:[ \t]*\n)+/, '');
  const instructions = body.length > AGENT_DRAFT_LIMITS.MaxInstructionsChars
    ? body.slice(0, AGENT_DRAFT_LIMITS.MaxInstructionsChars)
    : body;

  return {
    ...(description ? { description } : {}),
    ...(instructions ? { instructions } : {}),
  };
}

export function parsePolishedDraftOutput(
  rawText: string,
  includeDescription = false,
): { description: string; instructions: string } {
  const normalized = normalizePolishedInstructions(rawText);
  if (!normalized) {
    return { description: '', instructions: '' };
  }
  if (!includeDescription) {
    return { description: '', instructions: normalized };
  }

  const newlineIdx = normalized.indexOf('\n');
  if (newlineIdx === -1) {
    return { description: '', instructions: normalized };
  }

  const firstLine = normalized.slice(0, newlineIdx);
  if (!POLISH_SUMMARY_LINE_PREFIX_RE.test(firstLine)) {
    return { description: '', instructions: normalized };
  }

  const description = normalizeAgentSummaryDescription(
    firstLine.replace(POLISH_SUMMARY_LINE_PREFIX_RE, ''),
  );
  const body = normalized.slice(newlineIdx + 1).trim();
  if (!body) {
    return { description: '', instructions: normalized };
  }

  return {
    description,
    instructions: body.length > AGENT_DRAFT_LIMITS.MaxInstructionsChars
      ? body.slice(0, AGENT_DRAFT_LIMITS.MaxInstructionsChars).trimEnd()
      : body,
  };
}

function extractPartialJsonStringField(rawText: string, fieldName: string): string | undefined {
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"`);
  const match = pattern.exec(rawText);
  if (!match) return undefined;

  let index = match.index + match[0].length;
  let result = '';
  while (index < rawText.length) {
    const ch = rawText[index];
    if (ch === '"') {
      return result;
    }
    if (ch === '\\') {
      if (index + 1 >= rawText.length) {
        // Incomplete escape sequence at chunk boundary; stop cleanly before it.
        return result;
      }
      const next = rawText[index + 1];
      switch (next) {
        case '"': result += '"'; index += 2; break;
        case '\\': result += '\\'; index += 2; break;
        case '/': result += '/'; index += 2; break;
        case 'b': result += '\b'; index += 2; break;
        case 'f': result += '\f'; index += 2; break;
        case 'n': result += '\n'; index += 2; break;
        case 'r': result += '\r'; index += 2; break;
        case 't': result += '\t'; index += 2; break;
        case 'u': {
          if (index + 6 > rawText.length) return result;
          const hex = rawText.slice(index + 2, index + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result += String.fromCharCode(parseInt(hex, 16));
            index += 6;
          } else {
            index += 2;
          }
          break;
        }
        default:
          result += next;
          index += 2;
          break;
      }
      continue;
    }
    result += ch;
    index += 1;
  }
  return result;
}

/**
 * Incrementally extract streamed `description` and `instructions` previews from
 * an in-flight JSON response in Create mode so the UI can stream text live.
 */
export function extractStreamingDraftPreview(rawText: string): AgentDraftStreamPreview {
  const description = extractPartialJsonStringField(rawText, 'description');
  const instructions = extractPartialJsonStringField(rawText, 'instructions');
  const preview: AgentDraftStreamPreview = {};
  if (description) {
    preview.description = description.length > AGENT_DRAFT_LIMITS.MaxDescriptionChars
      ? description.slice(0, AGENT_DRAFT_LIMITS.MaxDescriptionChars)
      : description;
  }
  if (instructions) {
    preview.instructions = instructions.length > AGENT_DRAFT_LIMITS.MaxInstructionsChars
      ? instructions.slice(0, AGENT_DRAFT_LIMITS.MaxInstructionsChars)
      : instructions;
  }
  return preview;
}

function extractJsonObjectText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    return candidate;
  }

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

export function parseAgentDraftResponse(
  rawText: string,
  options: {
    fallbackName?: string;
    allowedSkillIds?: readonly string[];
  } = {},
): GeneratedAgentDraft | null {
  const jsonText = extractJsonObjectText(rawText);
  if (!jsonText) return null;

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(jsonText);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const instructions = clampText(parsed.instructions, AGENT_DRAFT_LIMITS.MaxInstructionsChars);
  if (!instructions) return null;

  const fallbackName = clampText(options.fallbackName, AGENT_DRAFT_LIMITS.MaxNameChars);
  const name = clampText(parsed.name, AGENT_DRAFT_LIMITS.MaxNameChars) || fallbackName;
  const description = clampText(parsed.description, AGENT_DRAFT_LIMITS.MaxDescriptionChars);

  const rawAvatar = typeof parsed.avatarSvg === 'string' ? parsed.avatarSvg.trim().toLowerCase() : '';
  const avatarSvg = isAgentAvatarSvg(rawAvatar) ? rawAvatar : undefined;

  const allowedSet = options.allowedSkillIds
    ? new Set(options.allowedSkillIds.map(id => id.trim()).filter(Boolean))
    : null;
  const recommendedSkillIds: string[] = [];
  if (Array.isArray(parsed.recommendedSkillIds)) {
    const seen = new Set<string>();
    for (const item of parsed.recommendedSkillIds) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      if (allowedSet && !allowedSet.has(id)) continue;
      seen.add(id);
      recommendedSkillIds.push(id);
      if (recommendedSkillIds.length >= AGENT_DRAFT_LIMITS.MaxRecommendedSkills) break;
    }
  }

  const starterPrompts: string[] = [];
  if (Array.isArray(parsed.starterPrompts)) {
    const seen = new Set<string>();
    for (const item of parsed.starterPrompts) {
      const prompt = clampText(item, AGENT_DRAFT_LIMITS.MaxStarterPromptChars);
      if (!prompt || seen.has(prompt)) continue;
      seen.add(prompt);
      starterPrompts.push(prompt);
      if (starterPrompts.length >= AGENT_DRAFT_LIMITS.MaxStarterPrompts) break;
    }
  }

  return {
    name,
    description,
    instructions,
    ...(avatarSvg ? { avatarSvg } : {}),
    recommendedSkillIds,
    starterPrompts,
  };
}
