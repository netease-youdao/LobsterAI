import defaultPersona from '../identity/personas/default.md?raw';
import businessPersona from '../identity/personas/business.md?raw';
import techExpertPersona from '../identity/personas/tech_expert.md?raw';
import butlerPersona from '../identity/personas/butler.md?raw';
import girlfriendPersona from '../identity/personas/girlfriend.md?raw';
import boyfriendPersona from '../identity/personas/boyfriend.md?raw';
import familyPersona from '../identity/personas/family.md?raw';
import jarvisPersona from '../identity/personas/jarvis.md?raw';

export interface PersonaPreset {
  readonly id: string;
  /** i18n key for the display name */
  readonly nameKey: string;
  readonly desc: string;
  readonly style: string;
}

export const PERSONA_PRESETS: readonly PersonaPreset[] = [
  { id: 'default', nameKey: 'agentPersonaDefault', desc: '专业友好、平衡得体', style: '适合日常使用，万能型角色' },
  { id: 'business', nameKey: 'agentPersonaBusiness', desc: '正式专业、数据驱动', style: '适合工作场景，正式汇报、数据分析' },
  { id: 'tech_expert', nameKey: 'agentPersonaTech', desc: '简洁精准、代码导向', style: '适合编程开发，技术问答' },
  { id: 'butler', nameKey: 'agentPersonaButler', desc: '周到细致、礼貌正式', style: '适合生活服务，日程安排、出行规划' },
  { id: 'girlfriend', nameKey: 'agentPersonaGirlfriend', desc: '温柔体贴、情感丰富', style: '适合情感陪伴，倾听与关怀' },
  { id: 'boyfriend', nameKey: 'agentPersonaBoyfriend', desc: '阳光开朗、幽默风趣', style: '适合情感陪伴，轻松有趣' },
  { id: 'family', nameKey: 'agentPersonaFamily', desc: '亲切关怀、唠叨温暖', style: '适合家庭场景，长辈式温暖关怀' },
  { id: 'jarvis', nameKey: 'agentPersonaJarvis', desc: '冷静睿智、英式幽默', style: '适合科技极客，像钢铁侠的 AI 管家' },
] as const;

/**
 * Mapping from preset id to the raw content of the corresponding persona .md file.
 */
const PERSONA_CONTENT_MAP: Record<string, string> = {
  default: defaultPersona,
  business: businessPersona,
  tech_expert: techExpertPersona,
  butler: butlerPersona,
  girlfriend: girlfriendPersona,
  boyfriend: boyfriendPersona,
  family: familyPersona,
  jarvis: jarvisPersona,
};

/**
 * Build a SOUL.md persona prompt from a preset.
 * Returns the full content from the corresponding identity/personas/*.md file.
 * Falls back to a concise template if the file content is unavailable.
 */
export function buildPersonaPrompt(preset: PersonaPreset): string {
  const content = PERSONA_CONTENT_MAP[preset.id]?.trim();
  if (content) {
    return content;
  }
  // Fallback: generate a concise template (should not normally be reached)
  return [
    `# Agent 人设：${preset.nameKey}`,
    '',
    `**性格特征**：${preset.desc}`,
    `**适用场景**：${preset.style}`,
    '',
    `请始终以此身份和语气与用户交流。`,
  ].join('\n');
}