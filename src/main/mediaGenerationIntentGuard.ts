/**
 * Intent checks that run before a paid media generation request is submitted.
 *
 * The media selection gate (mediaGenerationPolicy) only answers "is this tool
 * enabled for the session". Once a user has picked an image or video model the
 * selection stays active for later messages, so the chat model can still call
 * the generate tool when the user did not ask for media: after the user asked
 * to stop, while it is waiting for the user's answer to its own confirmation
 * question, or with a refusal such as "No image is needed this turn" as the
 * prompt (which the provider then renders into a picture and bills).
 *
 * These checks are deliberately conservative: they only block when the user's
 * own words or the tool prompt make it clear that no media was requested.
 */

const MEDIA_ACTION_PATTERN = '(?:生图|做图|作图|画图|做视频|制作(?:图片|图像|视频|商品图|产品图|主图|海报|插画|封面)|创建(?:图片|图像|视频|商品图|产品图|主图|海报|插画|封面)|生成(?:图片|图像|照片|视频|商品图|产品图|主图|海报|插画|封面)|图片生成|图像生成|视频生成)';
// A media noun followed by one of these describes part of the picture
// ("不要生成图片边框", "不要生成图片中的文字"), not the act of generating media.
const MEDIA_NOUN_MODIFIER_LOOKAHEAD = '(?!的|中|里|上|内|边框|背景|尺寸|比例|文字|水印|风格|质量|格式|大小)';
const MEDIA_STOP_TARGET = `${MEDIA_ACTION_PATTERN}${MEDIA_NOUN_MODIFIER_LOOKAHEAD}`;
const CHINESE_KEEP_GENERATING_PATTERNS = [
  new RegExp(`(?:不要|别|请勿)(?:停止|暂停|取消)(?:继续)?${MEDIA_ACTION_PATTERN}`),
  /(?:不要|别|请勿)(?:停止|暂停|取消)(?:继续)?(?:生成|制作|创建)(?:了|啦|吧)?(?=$|[，。！？,.!?])/,
];
const CHINESE_STOP_PATTERNS = [
  new RegExp(`(?:先|暂时|现在|目前)?(?:不要|别|不用|无需)(?:再)?(?:继续)?${MEDIA_STOP_TARGET}`),
  new RegExp(`(?:停止|暂停|取消)(?:继续)?${MEDIA_STOP_TARGET}`),
  /(?:先|暂时|现在|目前)?(?:不要|别|不用|无需)(?:再|继续)?(?:生成|制作|创建)(?:了|啦|吧)?(?=$|[，。！？,.!?])/,
  /(?:停止|暂停|取消)(?:继续)?(?:生成|制作|创建)(?:了|啦|吧)?(?=$|[，。！？,.!?])/,
];
const ENGLISH_KEEP_GENERATING_PATTERNS = [
  /\b(?:don't|dont|do not|never)\s+(?:stop|cancel|pause)\b\s+(?:(?:the|this|current|any|all)\s+){0,2}(?:(?:generating|making|creating)\s+)?(?:images?|pictures?|photos?|art|drawings?|videos?|clips?|animations?|image\s+generation|video\s+generation)\b/i,
  /\b(?:don't|dont|do not|never)\s+(?:stop|cancel|pause)\b\s+(?:generating|making|creating)\b(?=$|[,.!?])/i,
];
const ENGLISH_STOP_PATTERNS = [
  /\b(?:stop|cancel|pause)\b\s+(?:(?:the|this|current|any|all)\s+){0,2}(?:(?:generating|making|creating)\s+)?(?:images?|pictures?|photos?|art|drawings?|videos?|clips?|animations?|image\s+generation|video\s+generation)\b/i,
  /\b(?:don't|dont|do not|no need to|please do not)\b\s+(?:generate|create|make|draw)\b\s+(?:(?:another|any|more|an?|the|this)\s+)?(?:images?|pictures?|photos?|art|drawings?|videos?|clips?|animations?)\b/i,
  /\b(?:stop|cancel|pause)\b.{0,16}\b(?:generating|making|creating)\b(?=$|[,.!?])/i,
  /\b(?:don't|dont|do not|no need to|please do not)\b.{0,24}\b(?:generate|create|make|draw)\b(?=$|[,.!?])/i,
];
const CHINESE_GENERATE_PATTERNS = [
  new RegExp(`(?:继续|恢复|开始|重新|还是|那就|现在)?${MEDIA_ACTION_PATTERN}`),
  /(?:继续|恢复|开始|重新|还是|那就|现在)?生成(?:[一二两三四五六七八九十\d]+\s*张)?(?:图片|图像|照片|商品图|产品图|主图|海报|插画|封面)/,
];
const ENGLISH_GENERATE_PATTERNS = [
  /\b(?:(?:continue|resume|start|restart)\s+)?(?:generate|create|make|draw|generating|creating|making)\s+(?:(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|\d+|another|more)\s+)?(?:images?|pictures?|photos?|art|drawings?|videos?|clips?|animations?)\b/i,
];
// Generation requests with a quantifier or a short modifier between the verb and
// the noun ("生成一张产品主图"). The verb list is kept narrow so that discussion
// about images is not mistaken for a request.
const QUANTIFIED_GENERATE_PATTERNS = [
  /(?:生成|制作|创建)\s*(?:[一二两三四五六七八九十\d]+\s*[张个幅条支]\s*)?[^，。！？,.!?]{0,8}?(?:图片|图像|照片|视频|商品图|产品图|主图|海报|插画|封面|对比图)/,
];

// Follow-ups that edit or repeat the previous media ("把刚才那张的背景换成红色",
// "make it brighter"). They count as a new media request after a pause.
const CONTEXTUAL_MEDIA_REFERENCE_RE =
  /(?:(?:这张|那张|上张|上一张|前一张)(?!表|表格|报表|清单|幻灯片|卡片|票据|文档|页面)|(?:刚才|刚刚)(?:生成|做|画|出)?(?:的)?(?:图|图片|照片|画面|视频)|首帧|尾帧|(?:previous|last|same)\s+(?:image|picture|photo|video)|(?:this|that)\s+(?:image|picture|photo|video))/i;
const CONTEXTUAL_MEDIA_REPEAT_RE =
  /(?:^\s*(?:请|麻烦|帮我)?\s*(?:再来|再做|再生成|继续(?:生成|做|画|出图))|(?:同样的?|保持不变).{0,8}(?:再来|再做|再生成)|\b(?:again|another)\s+(?:image|picture|photo|video|version|variant)\b|\bcontinue\s+with\s+(?:another|a\s+different)\s+(?:pose|version|variant|background|style)\b)/i;
const CONTEXTUAL_VISUAL_EDIT_RE =
  /(?:(?:背景|主体|人物|模特|产品|商品|宠物|狗|猫|颜色|光线|构图|姿势|风格|画面|文字|logo).{0,24}(?:加|放|移|换|改|调|变|删|去掉|移除|亮|暗|大|小|左|右)|^(?:换|改|调整|修改|变成|做成).{0,10}(?:晚上|夜晚|白天|日出|日落|海边|室内|室外|横版|竖版|方形|高清|更亮|更暗)|(?:它|这张|那张).{0,12}(?:更亮|更暗|大一点|小一点|放左边|放右边)|(?:晚上|夜晚|白天|日出|日落|海边|室内|室外|横版|竖版|方形|高清).{0,8}(?:版本|版)|(?:add|remove|move|make).{0,32}(?:background|subject|person|product|dog|cat|text|logo|brighter|darker|larger|smaller)|\bmake\s+it\s+(?:brighter|darker|larger|smaller)\b)/i;

// A refusal or meta instruction used as the tool prompt. The media noun must be
// followed by punctuation, whitespace or the end so that negative visual
// constraints ("不要生成图片边框", "no text or watermark") are not matched.
const META_MEDIA_NOUN = '(?:图片|图像|照片|视频|媒体)';
const META_MEDIA_TAIL = '(?:$|[，。！？、,.!?\\s])';
const META_MEDIA_REFUSAL_PATTERNS = [
  new RegExp(
    `(?:无需|不需要|无须|不必|不用|请勿|不要|禁止|勿)(?:再|继续)?(?:生成|制作|创建|调用|生产|输出)(?:任何)?${META_MEDIA_NOUN}${META_MEDIA_TAIL}`,
  ),
  new RegExp(`不(?:生成|生产|制作|输出)(?:任何)?${META_MEDIA_NOUN}${META_MEDIA_TAIL}`),
  /\bno\s+(?:image|picture|photo|video|media)s?\s+(?:is\s+|are\s+)?(?:needed|required|necessary)\b/i,
  /\b(?:do\s+not|don't|must\s+not|should\s+not|no\s+need\s+to)\s+(?:generate|create|produce|make|draw)\s+(?:any\s+(?:more\s+)?|more\s+|an?\s+|the\s+)?(?:images?|pictures?|photos?|videos?|media)(?=\s*(?:$|[,.!?;:]))/i,
  /\b(?:do\s+not|don't|must\s+not|should\s+not|no\s+need\s+to)\s+(?:call|invoke|use)\s+(?:the\s+|any\s+)?(?:image|video|media)[\s_-]+(?:generation[\s_-]+)?tools?\b/i,
  /\bskip\s+(?:image|video|media)\s+generation\b/i,
];
// High-confidence meta phrases that never belong in a visual description.
const META_MEDIA_ANYWHERE_PATTERNS = [
  /(?:本回合|本轮|此轮|这轮|当前回合)(?:无需|不需要|不用|无须)/,
  /请勿调用/,
  /用户已(?:明确)?(?:要求|说明|表示|指示)/,
  /\b(?:this|the\s+current)\s+turn\s+(?:does\s+not|doesn't)\s+(?:need|require)\b/i,
  /\bthe\s+user\s+(?:has\s+)?(?:explicitly\s+)?(?:asked|requested|said)\s+(?:not\s+to|to\s+stop)\b/i,
];
// A refusal that is the point of the prompt appears at its start. Negations in
// the middle of a long prompt are usually negative visual constraints.
const META_REFUSAL_MAX_MATCH_INDEX = 30;
const META_REFUSAL_SHORT_PROMPT_CHARS = 80;

const MEDIA_CONFIRMATION_CONTEXT_RE = /(?:提示词|生成|出图|作图|做图|图片|图像|视频|调整|修改|重试|再试|继续|重新|参数|prompt|image|picture|video|generate|regenerate|adjust|modify|retry|continue)/i;
const USER_DECISION_QUESTION_RE = /(?:是否|要不要|需不需要|需要(?:我|你|您)?|要我|可否|可以(?:直接)?|你想|您想|你希望|您希望|继续|确认|同意|would\s+you\s+like|do\s+you\s+want|should\s+i|shall\s+i|may\s+i|can\s+i|want\s+me\s+to)/i;
const QUESTION_SIGNAL_RE = /(?:[?？]|(?:吗|么|呢)\s*[?？]?)(?:[\s*_`#>-]|$)/i;
const CONFIRMATION_TAIL_CHARS = 800;

const QUESTION_TOOL_NAME_RE = /^(?:ask[\s_-]*user(?:[\s_-]*question)?)$/i;

/** How many user messages (latest included) are searched for a standing stop request. */
export const STANDING_STOP_LOOKBACK_MESSAGES = 8;

export const MediaGenerationIntentBlockReason = {
  UserStopped: 'USER_STOPPED_MEDIA_GENERATION',
  MetaPrompt: 'META_MEDIA_PROMPT',
  AwaitingUserConfirmation: 'MEDIA_GENERATION_AWAITING_USER_CONFIRMATION',
} as const;
export type MediaGenerationIntentBlockReason =
  typeof MediaGenerationIntentBlockReason[keyof typeof MediaGenerationIntentBlockReason];

export type MediaGenerationIntentGateResult =
  | { allowed: true }
  | { allowed: false; reason: MediaGenerationIntentBlockReason; message: string };

/** Minimal shape of a persisted cowork message used by the intent checks. */
export type MediaIntentMessageLike = {
  type: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};

export type MediaGenerationIntentContext = {
  /** The user message that started the current turn. */
  latestUserPrompt?: string;
  /** Older user messages, newest first. */
  recentUserPrompts: string[];
  /** Assistant text of the current turn that the user has not answered yet. */
  currentTurnAssistantMessages: string[];
};

const normalizePrompt = (value: string): string => value.trim().replace(/\s+/g, ' ');

type DirectiveMatch = { index: number; end: number; isStop: boolean };

const collectMatches = (text: string, patterns: RegExp[], isStop: boolean): DirectiveMatch[] =>
  patterns.flatMap((pattern) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return Array.from(text.matchAll(new RegExp(pattern.source, flags))).map(match => ({
      index: match.index,
      end: match.index + match[0].length,
      isStop,
    }));
  });

const isContained = (inner: DirectiveMatch, outer: DirectiveMatch): boolean =>
  inner.index >= outer.index && inner.end <= outer.end;

/**
 * True when the last media directive in the text asks to stop, pause or avoid
 * image/video generation. "Don't stop generating images" and "stop generating
 * images, actually generate one" are not stop requests.
 */
export const isMediaGenerationStopIntent = (value: string | undefined): boolean => {
  const normalized = normalizePrompt(value ?? '');
  if (!normalized) return false;

  const keepMatches = collectMatches(normalized, [
    ...CHINESE_KEEP_GENERATING_PATTERNS,
    ...ENGLISH_KEEP_GENERATING_PATTERNS,
  ], false);
  const stopMatches = collectMatches(normalized, [
    ...CHINESE_STOP_PATTERNS,
    ...ENGLISH_STOP_PATTERNS,
  ], true).filter(stop => !keepMatches.some(keep => isContained(stop, keep)));
  const generateMatches = collectMatches(normalized, [
    ...CHINESE_GENERATE_PATTERNS,
    ...ENGLISH_GENERATE_PATTERNS,
  ], false).filter(generate => !stopMatches.some(stop => isContained(generate, stop)));
  const latestDirective = [...keepMatches, ...stopMatches, ...generateMatches]
    .sort((left, right) => right.index - left.index)[0];
  return latestDirective?.isStop ?? false;
};

/** True when the text explicitly asks to generate an image or video. */
export const hasExplicitMediaGenerationIntent = (value: string | undefined): boolean => {
  const normalized = normalizePrompt(value ?? '');
  if (!normalized) return false;
  if (isMediaGenerationStopIntent(normalized)) return false;
  return [
    ...CHINESE_GENERATE_PATTERNS,
    ...ENGLISH_GENERATE_PATTERNS,
    ...QUANTIFIED_GENERATE_PATTERNS,
  ].some(pattern => pattern.test(normalized));
};

/** True when the text edits, varies or repeats previously generated media. */
export const isContextualMediaFollowUp = (value: string | undefined): boolean => {
  const normalized = normalizePrompt(value ?? '');
  if (!normalized) return false;
  return CONTEXTUAL_MEDIA_REFERENCE_RE.test(normalized)
    || CONTEXTUAL_MEDIA_REPEAT_RE.test(normalized)
    || CONTEXTUAL_VISUAL_EDIT_RE.test(normalized);
};

/**
 * True when a tool prompt is a refusal, a stop request or an instruction about
 * the conversation instead of a description of the media to generate.
 */
export const isMetaMediaGenerationPrompt = (value: string | undefined): boolean => {
  const normalized = normalizePrompt(value ?? '');
  if (!normalized) return false;
  if (META_MEDIA_ANYWHERE_PATTERNS.some(pattern => pattern.test(normalized))) return true;
  for (const pattern of META_MEDIA_REFUSAL_PATTERNS) {
    const match = pattern.exec(normalized);
    if (!match) continue;
    if (
      match.index <= META_REFUSAL_MAX_MATCH_INDEX
      || normalized.length <= META_REFUSAL_SHORT_PROMPT_CHARS
    ) {
      return true;
    }
  }
  // A bare stop request ("stop generating images") passed as the prompt. Long
  // prompts are skipped because they may contain negative visual constraints.
  return normalized.length <= META_REFUSAL_SHORT_PROMPT_CHARS && isMediaGenerationStopIntent(normalized);
};

/**
 * Returns the user message that paused media generation when that pause is
 * still in effect. User messages are scanned from newest to oldest and the
 * first directive wins: a stop request keeps generation paused, while an
 * explicit generation request or a follow-up on earlier media lifts it.
 */
export const findStandingMediaGenerationStopMessage = (input: {
  latestUserPrompt?: string;
  recentUserPrompts?: string[];
}): string | null => {
  const candidates = [input.latestUserPrompt ?? '', ...(input.recentUserPrompts ?? [])]
    .slice(0, STANDING_STOP_LOOKBACK_MESSAGES);
  for (const candidate of candidates) {
    const normalized = normalizePrompt(candidate);
    if (!normalized) continue;
    if (isMediaGenerationStopIntent(normalized)) return normalized;
    if (hasExplicitMediaGenerationIntent(normalized)) return null;
    if (isContextualMediaFollowUp(normalized)) return null;
  }
  return null;
};

/**
 * Returns the assistant message from the current turn that asks the user to
 * decide whether or how media generation should proceed, if any.
 */
export const findPendingMediaGenerationConfirmation = (
  currentTurnAssistantMessages: string[] | undefined,
): string | null => {
  for (const message of [...(currentTurnAssistantMessages ?? [])].reverse()) {
    const normalized = message.trim();
    if (!normalized) continue;
    const tail = normalized.slice(-CONFIRMATION_TAIL_CHARS);
    if (
      QUESTION_SIGNAL_RE.test(tail)
      && USER_DECISION_QUESTION_RE.test(tail)
      && MEDIA_CONFIRMATION_CONTEXT_RE.test(tail)
    ) {
      return normalized;
    }
  }
  return null;
};

const isQuestionToolName = (value: unknown): boolean =>
  typeof value === 'string' && QUESTION_TOOL_NAME_RE.test(value.trim());

/**
 * Drops every message up to the last question tool call the user already
 * answered in this turn. A confirmation asked before that answer is resolved
 * and must not keep blocking generation; questions asked afterwards still count.
 */
export const messagesAfterLastAnsweredQuestion = <T extends MediaIntentMessageLike>(
  turnMessages: T[],
): T[] => {
  const questionToolUseIds = new Set<string>();
  let answeredAt = -1;
  turnMessages.forEach((message, index) => {
    const metadata = message.metadata ?? {};
    const toolUseId = typeof metadata.toolUseId === 'string' ? metadata.toolUseId : '';
    if (!toolUseId) return;
    if (message.type === 'tool_use' && isQuestionToolName(metadata.toolName)) {
      questionToolUseIds.add(toolUseId);
      return;
    }
    if (message.type === 'tool_result' && questionToolUseIds.has(toolUseId)) {
      answeredAt = index;
    }
  });
  return answeredAt < 0 ? turnMessages : turnMessages.slice(answeredAt + 1);
};

/**
 * Builds the intent context from a session's persisted messages (oldest first).
 */
export const collectMediaGenerationIntentContext = (
  messages: MediaIntentMessageLike[],
): MediaGenerationIntentContext => {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === 'user' && messages[index].content.trim()) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) {
    return { recentUserPrompts: [], currentTurnAssistantMessages: [] };
  }

  const recentUserPrompts: string[] = [];
  for (
    let index = latestUserIndex - 1;
    index >= 0 && recentUserPrompts.length < STANDING_STOP_LOOKBACK_MESSAGES - 1;
    index -= 1
  ) {
    const message = messages[index];
    if (message.type === 'user' && message.content.trim()) {
      recentUserPrompts.push(message.content);
    }
  }

  const currentTurnAssistantMessages = messagesAfterLastAnsweredQuestion(
    messages.slice(latestUserIndex + 1),
  )
    .filter(message => message.type === 'assistant' && message.content.trim())
    .map(message => message.content);

  return {
    latestUserPrompt: messages[latestUserIndex].content,
    recentUserPrompts,
    currentTurnAssistantMessages,
  };
};

/**
 * Decides whether a generate request matches what the user asked for.
 * `conversation` is omitted when the request does not come from a user-driven
 * turn; only the prompt itself is checked then.
 */
export const resolveMediaGenerationIntentGate = (input: {
  prompt: string;
  conversation?: MediaGenerationIntentContext;
}): MediaGenerationIntentGateResult => {
  const { conversation } = input;
  if (conversation) {
    const stopMessage = findStandingMediaGenerationStopMessage(conversation);
    if (stopMessage) {
      const stoppedInLatestMessage = normalizePrompt(conversation.latestUserPrompt ?? '') === stopMessage;
      return {
        allowed: false,
        reason: MediaGenerationIntentBlockReason.UserStopped,
        message: stoppedInLatestMessage
          ? 'Media generation was not started because the latest user message asks to stop media generation. Reply in plain text and do not call a media generation tool again unless the user makes a new explicit generation request.'
          : 'Media generation was not started because the user previously asked to pause media generation and has not requested any media since. Reply in plain text and do not call a media generation tool again until the user explicitly asks for an image or video.',
      };
    }
  }

  if (isMetaMediaGenerationPrompt(input.prompt)) {
    return {
      allowed: false,
      reason: MediaGenerationIntentBlockReason.MetaPrompt,
      message: 'Media generation was not started because the prompt is a refusal or an instruction, not a description of visual content. If no media is needed, reply to the user in plain text. Never call a media generation tool to say that nothing should be generated.',
    };
  }

  if (conversation) {
    const pendingConfirmation = findPendingMediaGenerationConfirmation(
      conversation.currentTurnAssistantMessages,
    );
    if (pendingConfirmation) {
      return {
        allowed: false,
        reason: MediaGenerationIntentBlockReason.AwaitingUserConfirmation,
        message: 'Media generation was not started because you already asked the user a confirmation question about it in this turn. Do not call a media generation tool again in this turn. Wait for the user\'s reply and follow it.',
      };
    }
  }

  return { allowed: true };
};
