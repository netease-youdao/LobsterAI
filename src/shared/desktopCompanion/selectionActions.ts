export const CompanionSelectionAction = {
  Translate: 'translate',
  Explain: 'explain',
  Summarize: 'summarize',
  Polish: 'polish',
  Ask: 'ask',
} as const;
export type CompanionSelectionAction = typeof CompanionSelectionAction[keyof typeof CompanionSelectionAction];

export type CompanionLanguage = 'zh' | 'en';

export const COMPANION_SELECTION_MAX_CHARS = 20_000;
const SHORT_SELECTION_CHARS = 24;
const LONG_SELECTION_CHARS = 200;

const A = CompanionSelectionAction;

export function isCompanionSelectionAction(value: unknown): value is CompanionSelectionAction {
  return typeof value === 'string' && (Object.values(A) as string[]).includes(value);
}

/** Share of CJK ideographs among letters and ideographs. */
export function cjkRatio(text: string): number {
  let cjk = 0;
  let letters = 0;
  for (const char of text) {
    if (/\p{Script=Han}/u.test(char)) { cjk += 1; letters += 1; } else if (/\p{L}/u.test(char)) letters += 1;
  }
  return letters ? cjk / letters : 0;
}

export function isMostlyChinese(text: string): boolean {
  return cjkRatio(text) >= 0.3;
}

/**
 * Put the most likely action first: foreign text wants a translation, a short
 * term wants an explanation, and a long passage wants a summary.
 */
export function rankCompanionSelectionActions(text: string): CompanionSelectionAction[] {
  const trimmed = text.trim();
  const length = [...trimmed].length;
  const chinese = isMostlyChinese(trimmed);
  if (length <= SHORT_SELECTION_CHARS) {
    return chinese ? [A.Explain, A.Translate, A.Polish, A.Ask] : [A.Translate, A.Explain, A.Ask];
  }
  if (length > LONG_SELECTION_CHARS) {
    return chinese
      ? [A.Summarize, A.Explain, A.Polish, A.Translate, A.Ask]
      : [A.Translate, A.Summarize, A.Explain, A.Polish, A.Ask];
  }
  return chinese
    ? [A.Explain, A.Polish, A.Summarize, A.Translate, A.Ask]
    : [A.Translate, A.Explain, A.Summarize, A.Polish, A.Ask];
}

export function companionTranslationTarget(text: string): CompanionLanguage {
  return isMostlyChinese(text) ? 'en' : 'zh';
}

export interface CompanionQuickAnswerPromptInput {
  action: CompanionSelectionAction;
  text: string;
  question?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  language: CompanionLanguage;
}

export interface CompanionQuickAnswerPrompt {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

const SYSTEM: Record<CompanionLanguage, Record<CompanionSelectionAction, string>> = {
  zh: {
    translate: '你是专业译者。把 <selected_text> 中的内容翻译成{target}。只输出译文，保留原有段落、列表和格式，不要解释、不要加引号。如果原文只是一个词或短语，先给最常用的译法，再用一两行补充词性与常见含义。',
    explain: '你是知识渊博、表达简洁的助手。用中文解释 <selected_text> 中的内容：先用一句话说清它是什么或意味着什么，再用 2–4 个要点补充背景、例子或需要注意的地方。不要复述原文，不要客套。',
    summarize: '用中文总结 <selected_text> 中的内容：先给一句话结论，再列出 3–5 个要点，保留关键数字、时间与专有名词。不要客套。',
    polish: '你是资深编辑。润色 <selected_text> 中的文字，让它更通顺、准确、得体，保持原意、原语言与语气。只输出润色后的文本；如果改动较大，最后另起一行用「修改要点：」简述。',
    ask: '基于 <selected_text> 中的内容回答用户的问题，用中文，简洁直接。如果内容不足以回答，说明还需要什么信息。',
  },
  en: {
    translate: 'You are a professional translator. Translate the content of <selected_text> into {target}. Output only the translation, keeping paragraphs, lists, and formatting. No explanations or quotes. If it is a single word or phrase, give the most common translation first, then one or two lines on part of speech and common meanings.',
    explain: 'You are a knowledgeable, concise assistant. Explain the content of <selected_text> in English: one sentence on what it is or means, then 2–4 bullet points with context, examples, or caveats. Do not repeat the text or add pleasantries.',
    summarize: 'Summarize the content of <selected_text> in English: a one-sentence takeaway, then 3–5 bullet points that keep key numbers, dates, and names. No pleasantries.',
    polish: 'You are a senior editor. Polish the text in <selected_text> so it reads clearly, accurately, and appropriately, keeping its meaning, language, and tone. Output only the polished text; if the changes are substantial, add a final line starting with "Changes:".',
    ask: 'Answer the user\'s question using the content of <selected_text>. Be concise and direct, in English. If the content is not enough, say what information is missing.',
  },
};

// Follow-up questions should not inherit a format-only instruction such as
// "output only the translation".
const FOLLOW_UP: Record<CompanionLanguage, string> = {
  zh: '你刚才处理了 <selected_text> 中的内容。现在回答用户的追问：用中文，简洁直接，必要时引用原文。',
  en: 'You just worked on the content of <selected_text>. Now answer the user\'s follow-up in English, concisely, quoting the text when useful.',
};

const TARGET_NAME: Record<CompanionLanguage, Record<CompanionLanguage, string>> = {
  zh: { zh: '简体中文', en: '英文' },
  en: { zh: 'Simplified Chinese', en: 'English' },
};

export function buildCompanionQuickAnswerPrompt(input: CompanionQuickAnswerPromptInput): CompanionQuickAnswerPrompt {
  const language = input.language === 'en' ? 'en' : 'zh';
  const text = [...input.text.trim()].slice(0, COMPANION_SELECTION_MAX_CHARS).join('');
  const target = TARGET_NAME[language][companionTranslationTarget(text)];
  const isFollowUp = (input.history ?? []).some(turn => turn.role === 'user' && turn.content.trim());
  const system = isFollowUp ? FOLLOW_UP[language] : SYSTEM[language][input.action].replace('{target}', target);
  const questionLabel = language === 'zh' ? '问题' : 'Question';
  const firstQuestion = input.action === A.Ask && input.question?.trim()
    ? `\n\n${questionLabel}: ${input.question.trim()}`
    : '';
  const messages: CompanionQuickAnswerPrompt['messages'] = [
    { role: 'user', content: `<selected_text>\n${text}\n</selected_text>${firstQuestion}` },
  ];
  for (const turn of input.history ?? []) {
    if ((turn.role === 'user' || turn.role === 'assistant') && turn.content.trim()) {
      messages.push({ role: turn.role, content: turn.content.slice(0, 8_000) });
    }
  }
  // A follow-up arrives as the latest history turn; keep the conversation alternating.
  if (messages[messages.length - 1].role === 'assistant') {
    messages.push({ role: 'user', content: language === 'zh' ? '请继续。' : 'Please continue.' });
  }
  return { system, messages };
}
