import { AgentAvatarSvg, DefaultAgentAvatarIcon, encodeAgentAvatarIcon } from './avatar';
import { AgentId, AgentSource } from './constants';

// Compatibility metadata only, not an expert catalog. These are the shipped
// template defaults before avatar ownership was recorded explicitly.
const LEGACY_PRESET_AVATARS: Record<string, string> = {
  'data-advisor': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Data }),
  stockexpert: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Data }),
  'content-writer': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Creation }),
  'wechat-editor': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Creation }),
  'content-summarizer': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Document }),
  'presentation-planner': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Document }),
  'lesson-planner': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.GraduationCap }),
  'academic-writing-coach': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.GraduationCap }),
  'miniapp-advisor': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Code }),
  'social-content-planner': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Inspiration }),
  'industry-researcher': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Books }),
  'interface-designer': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Artboard }),
  'product-planner': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Brain }),
  'career-coach': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Briefcase }),
  'contract-reader': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Scales }),
  'health-interpreter': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Diagnosis }),
  'pet-care': encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Pet }),
  'app-builder': 'https://ydhardwarecommon.nosdn.127.net/5b9dcdd34d648e2071c8998b2b09da22.webp',
  'xiaohongshu-editor': 'https://ydhardwarecommon.nosdn.127.net/e0abcf84d9f028faee2e003548828abc.webp',
  'campus-career-guide': 'https://ydhardwarecommon.nosdn.127.net/a7486a10faebacfeaab142f1675da8eb.webp',
};

export interface PresetAvatarSource {
  id: string;
  source?: AgentSource;
  presetId?: string;
  icon?: string | null;
  iconCustomized?: boolean;
}

/** Unknown historical values are user-owned; only exact shipped defaults migrate. */
export function usesManagedPresetAvatar(agent?: PresetAvatarSource | null): boolean {
  if (!agent || agent.id.trim() === AgentId.Main || agent.source !== AgentSource.Preset) return false;
  if (agent.iconCustomized !== undefined) return !agent.iconCustomized;
  const icon = agent.icon?.trim() || DefaultAgentAvatarIcon;
  return icon === DefaultAgentAvatarIcon || icon === LEGACY_PRESET_AVATARS[agent.presetId || agent.id];
}
