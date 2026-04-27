import path from 'node:path';

import type { Agent } from '../coworkStore';

type BuildManagedAgentEntriesInput = {
  agents: Agent[];
  fallbackPrimaryModel: string;
  stateDir?: string;
};

type ProviderModelCatalog = Record<string, { models: Array<{ id: string }> }>;

export type ManagedSessionModelTarget = {
  providerId: string;
  modelId: string;
  primaryModel: string;
};

export type QualifiedAgentModelRefResolution =
  | { status: 'qualified'; primaryModel: string }
  | { status: 'ambiguous'; modelId: string; providerIds: string[] }
  | { status: 'unresolved'; modelId: string };

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
  options?: { workspace?: string },
): Record<string, unknown> {
  const primaryModel = parsePrimaryModelRef(agent.model.trim())?.primaryModel || fallbackPrimaryModel;

  return {
    id: agent.id,
    ...(agent.isDefault ? { default: true } : {}),
    ...(agent.name || agent.icon ? {
      identity: {
        ...(agent.name ? { name: agent.name } : {}),
        ...(agent.icon ? { emoji: agent.icon } : {}),
      },
    } : {}),
    ...(agent.skillIds && agent.skillIds.length > 0 ? { skills: agent.skillIds } : {}),
    ...(options?.workspace ? { workspace: options.workspace } : {}),
    model: {
      primary: primaryModel,
    },
  };
}

export function buildManagedAgentEntries({
  agents,
  fallbackPrimaryModel,
  stateDir,
}: BuildManagedAgentEntriesInput): Array<Record<string, unknown>> {
  return agents
    .filter((agent) => agent.id !== 'main' && agent.enabled)
    .map((agent) => buildAgentEntry(agent, fallbackPrimaryModel, stateDir
      ? { workspace: path.join(stateDir, `workspace-${agent.id}`) }
      : undefined,
    ));
}
