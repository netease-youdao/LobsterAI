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

export type ManagedSessionModelTarget = {
  providerId: string;
  modelId: string;
  primaryModel: string;
};

export type QualifiedAgentModelRefResolution =
  | { status: 'qualified'; primaryModel: string }
  | { status: 'ambiguous'; modelId: string; providerIds: string[] }
  | { status: 'unresolved'; modelId: string };

const LegacyQualifiedProviderMigration: Record<string, readonly string[]> = {
  [OpenClawProviderId.OpenAI]: [OpenClawProviderId.OpenAICodex],
  [OpenClawProviderId.Minimax]: [OpenClawProviderId.MinimaxPortal],
  [OpenClawProviderId.OpenAICodex]: [OpenClawProviderId.OpenAI],
};

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

  return {
    id: agent.id,
    ...(agent.isDefault ? { default: true } : {}),
    ...(agent.name || legacyIcon ? {
      identity: {
        ...(agent.name ? { name: agent.name } : {}),
        ...(legacyIcon ? { emoji: legacyIcon } : {}),
      },
    } : {}),
    ...(agent.skillIds && agent.skillIds.length > 0 ? { skills: agent.skillIds } : {}),
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
