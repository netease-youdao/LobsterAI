import path from 'node:path';

import { isDesignedAgentAvatarIcon } from '../../shared/agent/avatar';
import { OpenClawProviderId } from '../../shared/providers/constants';
import type { Agent } from '../coworkStore';

type BuildManagedAgentEntriesInput = {
  agents: Agent[];
  fallbackPrimaryModel: string;
  stateDir?: string;
  availableProviders?: ProviderModelCatalog;
};

export type ProviderModelCatalog = Record<string, { models: Array<{ id: string }> }>;

export const OpenClawAgentOwnership = {
  Explicit: 'explicit',
} as const;

export type ManagedSessionModelTarget = {
  providerId: string;
  modelId: string;
  primaryModel: string;
};

export type QualifiedAgentModelRefResolution =
  | { status: 'qualified'; primaryModel: string }
  | { status: 'ambiguous'; modelId: string; providerIds: string[] }
  | { status: 'unresolved'; modelId: string };

export const ServerModelRefResolutionStatus = {
  Server: 'server',
  NonServer: 'non_server',
  Ambiguous: 'ambiguous',
  RefreshRequired: 'refresh_required',
  Unresolved: 'unresolved',
} as const;

export type ServerModelRefResolutionStatus =
  typeof ServerModelRefResolutionStatus[keyof typeof ServerModelRefResolutionStatus];

export type ServerModelRefResolution =
  | {
    status: typeof ServerModelRefResolutionStatus.Server;
    modelId: string;
    primaryModel: string;
  }
  | {
    status: typeof ServerModelRefResolutionStatus.NonServer;
    modelId: string;
    providerIds: string[];
  }
  | {
    status: typeof ServerModelRefResolutionStatus.Ambiguous;
    modelId: string;
    providerIds: string[];
  }
  | {
    status: typeof ServerModelRefResolutionStatus.RefreshRequired;
    modelId: string;
  }
  | {
    status: typeof ServerModelRefResolutionStatus.Unresolved;
    modelId: string;
  };

export function shouldSyncServerModelConfig(options: {
  metadataChanged: boolean;
  modelsMissingFromConfig: boolean;
  forceConfigSync?: boolean;
}): boolean {
  return options.forceConfigSync === true
    || options.metadataChanged
    || options.modelsMissingFromConfig;
}

export async function syncServerModelConfigIfNeeded(options: {
  metadataChanged: boolean;
  modelsMissingFromConfig: boolean;
  forceConfigSync?: boolean;
  sync: () => Promise<{ success: boolean; error?: string }>;
}): Promise<boolean> {
  if (!shouldSyncServerModelConfig(options)) {
    return false;
  }

  const result = await options.sync();
  if (!result.success) {
    throw new Error(result.error || 'Failed to sync server model configuration.');
  }
  return true;
}

const LegacyQualifiedProviderMigration: Record<string, readonly string[]> = {
  [OpenClawProviderId.OpenAI]: [OpenClawProviderId.OpenAICodex],
  [OpenClawProviderId.Minimax]: [OpenClawProviderId.MinimaxPortal],
  [OpenClawProviderId.OpenAICodex]: [OpenClawProviderId.OpenAI],
};

function normalizeSubagentAllowAgentIds(agent: Agent): string[] {
  const seen = new Set<string>();
  const allowAgentIds: string[] = [];
  const selfId = agent.id.trim();
  for (const id of agent.subagentAllowAgentIds ?? []) {
    const normalized = id.trim();
    if (!normalized || normalized === selfId || seen.has(normalized)) continue;
    seen.add(normalized);
    allowAgentIds.push(normalized);
  }
  return allowAgentIds;
}

function buildSubagentConfig(agent: Agent): Record<string, unknown> | undefined {
  const selectedAgentIds = normalizeSubagentAllowAgentIds(agent);
  const selfId = agent.id.trim();
  if (!selfId || selectedAgentIds.length === 0) {
    return undefined;
  }
  return {
    allowAgents: [selfId, ...selectedAgentIds],
    requireAgentId: true,
  };
}

export function parsePrimaryModelRef(primaryModel: string): ManagedSessionModelTarget | null {
  const normalized = primaryModel.trim();
  const slashIndex = normalized.indexOf('/');
  if (!normalized || slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return null;
  }

  const providerId = normalized.slice(0, slashIndex).trim();
  const modelId = normalized.slice(slashIndex + 1).trim();
  if (!providerId || !modelId) {
    return null;
  }

  return {
    providerId,
    modelId,
    primaryModel: `${providerId}/${modelId}`,
  };
}

export function resolveManagedSessionModelTarget(options: {
  agentModel: string;
  fallbackPrimaryModel: string;
  availableProviders: ProviderModelCatalog;
  currentProviderId?: string;
}): ManagedSessionModelTarget {
  const fallbackTarget = parsePrimaryModelRef(options.fallbackPrimaryModel);
  const explicitModel = options.agentModel.trim();
  const currentProviderId = options.currentProviderId?.trim() || '';

  if (!explicitModel) {
    if (fallbackTarget) return fallbackTarget;
    return {
      providerId: currentProviderId,
      modelId: '',
      primaryModel: currentProviderId ? `${currentProviderId}/` : '',
    };
  }

  const explicitTarget = parsePrimaryModelRef(explicitModel);
  if (explicitTarget) {
    return explicitTarget;
  }

  const matchingProviders = Object.entries(options.availableProviders)
    .filter(([, config]) => config.models.some((model) => model.id === explicitModel))
    .map(([providerId]) => providerId);

  if (fallbackTarget && matchingProviders.includes(fallbackTarget.providerId)) {
    return {
      providerId: fallbackTarget.providerId,
      modelId: explicitModel,
      primaryModel: `${fallbackTarget.providerId}/${explicitModel}`,
    };
  }

  if (matchingProviders.length === 1) {
    return {
      providerId: matchingProviders[0],
      modelId: explicitModel,
      primaryModel: `${matchingProviders[0]}/${explicitModel}`,
    };
  }

  if (currentProviderId) {
    return {
      providerId: currentProviderId,
      modelId: explicitModel,
      primaryModel: `${currentProviderId}/${explicitModel}`,
    };
  }

  if (fallbackTarget) {
    return {
      providerId: fallbackTarget.providerId,
      modelId: explicitModel,
      primaryModel: `${fallbackTarget.providerId}/${explicitModel}`,
    };
  }

  return {
    providerId: '',
    modelId: explicitModel,
    primaryModel: explicitModel,
  };
}

export function resolveQualifiedAgentModelRef(options: {
  agentModel: string;
  availableProviders: ProviderModelCatalog;
}): QualifiedAgentModelRefResolution {
  const explicitModel = options.agentModel.trim();
  if (!explicitModel) {
    return { status: 'unresolved', modelId: '' };
  }

  const explicitTarget = parsePrimaryModelRef(explicitModel);
  if (explicitTarget) {
    const providerModels = options.availableProviders[explicitTarget.providerId]?.models ?? [];
    if (providerModels.some((model) => model.id === explicitTarget.modelId)) {
      return {
        status: 'qualified',
        primaryModel: explicitTarget.primaryModel,
      };
    }

    const migrationProviders = LegacyQualifiedProviderMigration[explicitTarget.providerId] ?? [];
    const matchingProviders = Object.entries(options.availableProviders)
      .filter(([providerId, config]) => (
        migrationProviders.includes(providerId)
        && config.models.some((model) => model.id === explicitTarget.modelId)
      ))
      .map(([providerId]) => providerId);

    if (matchingProviders.length === 1) {
      return {
        status: 'qualified',
        primaryModel: `${matchingProviders[0]}/${explicitTarget.modelId}`,
      };
    }

    return {
      status: 'qualified',
      primaryModel: explicitTarget.primaryModel,
    };
  }

  const matchingProviders = Object.entries(options.availableProviders)
    .filter(([, config]) => config.models.some((model) => model.id === explicitModel))
    .map(([providerId]) => providerId);

  if (matchingProviders.length === 1) {
    return {
      status: 'qualified',
      primaryModel: `${matchingProviders[0]}/${explicitModel}`,
    };
  }

  if (matchingProviders.length > 1) {
    return {
      status: 'ambiguous',
      modelId: explicitModel,
      providerIds: matchingProviders,
    };
  }

  return {
    status: 'unresolved',
    modelId: explicitModel,
  };
}

/**
 * Resolve whether a run model reference belongs to lobsterai-server without
 * silently assigning a historical bare id to the wrong provider.
 *
 * The candidate callback is intentionally checked before accepting a custom
 * provider match. This keeps a stale bare package K3 id fail-closed while the
 * authenticated package catalog is still loading.
 */
export function resolveServerModelRefForRun(options: {
  modelRef: string;
  availableProviders: ProviderModelCatalog;
  isKnownServerModelCandidate?: (modelId: string) => boolean;
}): ServerModelRefResolution {
  const modelRef = options.modelRef.trim();
  if (!modelRef) {
    return {
      status: ServerModelRefResolutionStatus.Unresolved,
      modelId: '',
    };
  }

  const explicitTarget = parsePrimaryModelRef(modelRef);
  if (explicitTarget) {
    if (explicitTarget.providerId === OpenClawProviderId.LobsteraiServer) {
      return {
        status: ServerModelRefResolutionStatus.Server,
        modelId: explicitTarget.modelId,
        primaryModel: explicitTarget.primaryModel,
      };
    }
    return {
      status: ServerModelRefResolutionStatus.NonServer,
      modelId: explicitTarget.modelId,
      providerIds: [explicitTarget.providerId],
    };
  }

  const matchingProviders = Object.entries(options.availableProviders)
    .filter(([, config]) => config.models.some(model => model.id === modelRef))
    .map(([providerId]) => providerId);
  const serverMatched = matchingProviders.includes(OpenClawProviderId.LobsteraiServer);

  if (serverMatched && matchingProviders.length === 1) {
    return {
      status: ServerModelRefResolutionStatus.Server,
      modelId: modelRef,
      primaryModel: `${OpenClawProviderId.LobsteraiServer}/${modelRef}`,
    };
  }
  if (serverMatched) {
    return {
      status: ServerModelRefResolutionStatus.Ambiguous,
      modelId: modelRef,
      providerIds: matchingProviders,
    };
  }
  if (options.isKnownServerModelCandidate?.(modelRef)) {
    return {
      status: ServerModelRefResolutionStatus.RefreshRequired,
      modelId: modelRef,
    };
  }
  if (matchingProviders.length === 0) {
    return {
      status: ServerModelRefResolutionStatus.Unresolved,
      modelId: modelRef,
    };
  }
  return {
    status: ServerModelRefResolutionStatus.NonServer,
    modelId: modelRef,
    providerIds: matchingProviders,
  };
}

export function buildAgentEntry(
  agent: Agent,
  fallbackPrimaryModel: string,
  options?: { workspace?: string; availableProviders?: ProviderModelCatalog },
): Record<string, unknown> {
  const qualified = resolveQualifiedAgentModelRef({
    agentModel: agent.model,
    availableProviders: options?.availableProviders ?? {},
  });
  const primaryModel = qualified.status === 'qualified' ? qualified.primaryModel : fallbackPrimaryModel;
  const legacyIcon = isDesignedAgentAvatarIcon(agent.icon) ? '' : agent.icon;
  const subagentConfig = buildSubagentConfig(agent);

  return {
    id: agent.id,
    ...(agent.name ? { name: agent.name } : {}),
    ...(agent.name || legacyIcon ? {
      identity: {
        ...(agent.name ? { name: agent.name } : {}),
        ...(legacyIcon ? { emoji: legacyIcon } : {}),
      },
    } : {}),
    ...(agent.skillIds && agent.skillIds.length > 0 ? { skills: agent.skillIds } : {}),
    ...(subagentConfig ? { subagents: subagentConfig } : {}),
    ...(options?.workspace ? { workspace: options.workspace } : {}),
    ...(agent.workingDirectory?.trim() ? { cwd: path.resolve(agent.workingDirectory.trim()) } : {}),
    model: {
      primary: primaryModel,
    },
  };
}

export function buildManagedAgentEntries({
  agents,
  fallbackPrimaryModel,
  stateDir,
  availableProviders,
}: BuildManagedAgentEntriesInput): Array<Record<string, unknown>> {
  return agents
    .filter((agent) => agent.id !== 'main' && agent.enabled)
    .map((agent) => buildAgentEntry(agent, fallbackPrimaryModel, stateDir
      ? { workspace: path.join(stateDir, `workspace-${agent.id}`), availableProviders }
      : { availableProviders },
    ));
}

// Provider IDs that were renamed in past refactors. Any stored agent model ref
// using an old ID is rewritten to the current ID on startup.
const RENAMED_PROVIDER_IDS: Record<string, string> = {
  'github-copilot': 'lobsterai-copilot',
};

/**
 * Migrate unqualified or renamed agent model refs to fully-qualified form.
 * Returns the number of agents whose model binding was updated.
 */
export function migrateAgentModelRefs(options: {
  defaultModelRef: string;
  availableProviders: ProviderModelCatalog;
  agents: Agent[];
  updateAgent: (id: string, patch: { model: string }) => void;
}): number {
  const { defaultModelRef, availableProviders, agents, updateAgent } = options;
  if (!defaultModelRef) return 0;

  let changed = 0;

  for (const agent of agents) {
    let normalizedModel = agent.model.trim();
    if (!normalizedModel) continue;

    // Apply explicit provider rename map before qualification so that renamed
    // provider IDs (e.g. 'github-copilot' → 'lobsterai-copilot') are corrected
    // even though resolveQualifiedAgentModelRef treats any slash-ref as valid.
    const slashIdx = normalizedModel.indexOf('/');
    if (slashIdx > 0) {
      const storedProviderId = normalizedModel.slice(0, slashIdx);
      const renamedId = RENAMED_PROVIDER_IDS[storedProviderId];
      if (renamedId) {
        normalizedModel = `${renamedId}${normalizedModel.slice(slashIdx)}`;
      }
    }

    const qualification = resolveQualifiedAgentModelRef({
      agentModel: normalizedModel,
      availableProviders,
    });

    if (qualification.status === 'ambiguous') {
      console.warn(
        `[Main] Skipped ambiguous agent model migration for "${agent.id}" because "${qualification.modelId}" matches multiple providers: ${qualification.providerIds.join(', ')}`,
      );
      continue;
    }

    if (qualification.status !== 'qualified' || qualification.primaryModel === agent.model.trim()) {
      continue;
    }

    updateAgent(agent.id, { model: qualification.primaryModel });
    changed += 1;
  }

  return changed;
}
