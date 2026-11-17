import { type ModelThinkingLevel, parseModelThinkingLevel } from '../providers/modelThinking';
import { AgentId, AgentModelSelectionMode, AgentSource } from './constants';

export interface AgentModelSelection {
  /** Qualified provider/model ref, including virtual plan models such as yd-fast. */
  model: string;
  thinkingLevel: ModelThinkingLevel | '';
}

export function usesInheritedAgentModel(agent: {
  id: string;
  source: AgentSource;
  modelSelectionMode?: AgentModelSelectionMode;
}): boolean {
  return agent.id !== AgentId.Main
    && agent.source === AgentSource.Preset
    && agent.modelSelectionMode === AgentModelSelectionMode.Inherit;
}

export function parseAgentModelSelection(value: unknown): AgentModelSelection | undefined {
  if (value === undefined) return undefined;
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!record || typeof record.model !== 'string') throw new Error('Invalid agent model selection.');
  const thinkingLevel = parseModelThinkingLevel(record.thinkingLevel);
  if (record.thinkingLevel && !thinkingLevel) throw new Error('Invalid agent thinking level.');
  return { model: record.model.trim(), thinkingLevel: thinkingLevel ?? '' };
}
