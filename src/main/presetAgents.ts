import { AgentSource } from '../shared/agent/constants';
import type { PresetAgent } from '../shared/agent/presets';
import type { CreateAgentRequest } from './coworkStore';
import { getLanguage } from './i18n';

export type { PresetAgent } from '../shared/agent/presets';

/** Create a localized agent snapshot; future catalog updates never overwrite it. */
export function presetToCreateRequest(preset: PresetAgent): CreateAgentRequest {
  const isEn = getLanguage() === 'en';
  return {
    id: preset.id,
    name: isEn ? preset.nameEn : preset.name,
    description: isEn ? preset.descriptionEn : preset.description,
    identity: isEn ? preset.identityEn : preset.identity,
    systemPrompt: isEn ? preset.systemPromptEn : preset.systemPrompt,
    icon: preset.icon,
    skillIds: preset.skillIds,
    source: AgentSource.Preset,
    presetId: preset.id,
  };
}
