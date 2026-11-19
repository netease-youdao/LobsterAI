import { isDeepStrictEqual } from 'node:util';

import { AgentId, AgentSource } from '../../../shared/agent/constants';
import { ExpertUpgradeStatus, hasExpertUpdate } from '../../../shared/agent/presets';
import { replaceAgentPersonaForUpgrade } from '../../libs/agentPersonaFiles';
import { presetToCreateRequest } from '../../presetAgents';
import type { AgentHandlerDeps } from './handlers';

type UpgradeDeps = Pick<AgentHandlerDeps, 'getAgentManager' | 'getCoworkStore'
  | 'resolveAgentWorkspacePath' | 'syncOpenClawConfig' | 'hasPendingMediaTask'> & {
    getCoworkEngineRouter: () => Pick<ReturnType<AgentHandlerDeps['getCoworkEngineRouter']>, 'isSessionActive'>;
  };

/** A revision is selected on the card. Never silently substitute a newer offer or another instance. */
export async function upgradePreset(agentId: string, revision: number, deps: UpgradeDeps): Promise<ExpertUpgradeStatus> {
  const manager = deps.getAgentManager();
  const catalog = await manager.getExpertCatalog();
  const agent = manager.getAgent(agentId);
  if (!agent || agent.id === AgentId.Main || agent.source !== AgentSource.Preset) return ExpertUpgradeStatus.Unavailable;
  const preset = catalog.experts.find(expert => expert.id === agent.presetId);
  if (!preset?.revision || preset.revision !== revision) return ExpertUpgradeStatus.Unavailable;
  if (agent.presetRevision === revision) return ExpertUpgradeStatus.Updated;
  if (!hasExpertUpdate(agent.presetRevision, revision)) return ExpertUpgradeStatus.Unavailable;

  const store = deps.getCoworkStore();
  const router = deps.getCoworkEngineRouter();
  if (store.hasRunningExpertTask(agentId) || store.listSessionIdsByAgent(agentId).some(id =>
    router.isSessionActive(id) || deps.hasPendingMediaTask?.(id))) {
    return ExpertUpgradeStatus.Busy;
  }

  const defaults = presetToCreateRequest(preset);
  const target = { ...defaults, id: agentId, iconCustomized: false, presetRevision: agent.presetRevision };
  const restorePersona = replaceAgentPersonaForUpgrade(deps.resolveAgentWorkspacePath(agentId), defaults);
  let saved = false;
  try {
    // Keep the installed revision pending until the gateway configuration has also been written.
    store.saveExpertDefaults(target);
    saved = true;
    const result = await deps.syncOpenClawConfig({ reason: 'expert-upgraded' });
    if (!result.success) throw new Error(result.error || 'Failed to apply expert configuration');
    return store.setExpertRevision(agentId, revision) ? ExpertUpgradeStatus.Updated : ExpertUpgradeStatus.Unavailable;
  } catch (error) {
    restorePersona();
    const current = saved && manager.getAgent(agentId);
    if (current) {
      // A settings edit made while the gateway was applying the config still belongs to the user.
      const restore = <K extends 'name' | 'description' | 'identity' | 'systemPrompt' | 'skillIds'>(key: K) =>
        isDeepStrictEqual(current[key], target[key]) ? agent[key] : current[key];
      store.saveExpertDefaults({
        ...current, name: restore('name'), description: restore('description'), identity: restore('identity'),
        systemPrompt: restore('systemPrompt'), skillIds: restore('skillIds'),
        ...(current.icon === target.icon && !current.iconCustomized ? { icon: agent.icon, iconCustomized: agent.iconCustomized } : {}),
      });
      await deps.syncOpenClawConfig({ reason: 'expert-upgrade-rollback' });
    }
    throw error;
  }
}
