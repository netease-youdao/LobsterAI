import {
  AgentDraftErrorCode,
  AgentDraftLanguage,
  AgentDraftMode,
  type AgentDraftStreamPreview,
  detectPreferredAgentLanguage,
  type GenerateAgentDraftRequest,
  type GenerateAgentDraftResult,
} from '../../shared/agent';
import type { AgentManager } from '../agentManager';
import type { Agent, UpdateAgentRequest } from '../coworkStore';
import { readFolderContextSnippet } from './agentDraftGenerator';

export const AgentDescriptionBackfillTrigger = {
  Create: 'create',
  Update: 'update',
} as const;

export type AgentDescriptionBackfillTrigger =
  typeof AgentDescriptionBackfillTrigger[keyof typeof AgentDescriptionBackfillTrigger];

const CONTENT_BACKFILL_UPDATE_KEYS: ReadonlyArray<keyof UpdateAgentRequest> = [
  'systemPrompt',
  'identity',
  'workingDirectory',
  'skillIds',
  'description',
];

export interface ShouldBackfillAgentDescriptionInput {
  trigger: AgentDescriptionBackfillTrigger;
  previousAgent: Agent | null;
  nextAgent: Agent;
  updates?: UpdateAgentRequest;
  hasFolderContext?: boolean;
}

/**
 * Decide whether an agent with a blank description should trigger a background
 * one-line summary generation. Respects explicit user clears and avoids
 * hallucinating summaries when the agent has neither rules nor folder context.
 */
export function shouldBackfillAgentDescription(
  input: ShouldBackfillAgentDescriptionInput,
): boolean {
  const { trigger, previousAgent, nextAgent, updates, hasFolderContext = false } = input;
  if (nextAgent.description?.trim()) return false;

  if (trigger === AgentDescriptionBackfillTrigger.Update) {
    const userExplicitlyClearedDescription = Boolean(previousAgent?.description?.trim())
      && updates?.description !== undefined
      && !updates.description.trim();
    if (userExplicitlyClearedDescription) return false;

    const hasRelevantContentUpdate = Boolean(
      updates && CONTENT_BACKFILL_UPDATE_KEYS.some(key => key in updates),
    );
    if (!hasRelevantContentUpdate) return false;
  }

  const hasRules = Boolean(nextAgent.systemPrompt?.trim() || nextAgent.identity?.trim());
  if (hasRules) return true;

  return Boolean(nextAgent.workingDirectory?.trim() && hasFolderContext);
}

export interface AgentDescriptionBackfillerDeps {
  getAgentManager: () => Pick<AgentManager, 'getAgent' | 'updateAgent'>;
  generateAgentDraft?: (
    request: GenerateAgentDraftRequest,
    options?: {
      signal?: AbortSignal;
      onProgress?: (preview: AgentDraftStreamPreview) => void;
    },
  ) => Promise<GenerateAgentDraftResult>;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
  }) => Promise<{
    success: boolean;
    changed: boolean;
    error?: string;
  }>;
  onAgentDescriptionUpdated: () => void;
  getLanguage?: () => 'zh' | 'en';
  readFolderContext?: (workingDirectory: string | undefined) => string;
}

export interface AgentDescriptionBackfiller {
  scheduleForCreatedAgent: (agent: Agent) => void;
  scheduleForUpdatedAgent: (input: {
    previousAgent: Agent | null;
    nextAgent: Agent;
    updates: UpdateAgentRequest;
  }) => void;
  cancel: (agentId: string) => void;
}

export function createAgentDescriptionBackfiller(
  deps: AgentDescriptionBackfillerDeps,
): AgentDescriptionBackfiller {
  const inFlight = new Map<string, AbortController>();
  const readFolderContext = deps.readFolderContext ?? readFolderContextSnippet;

  const cancel = (agentId: string): void => {
    const existing = inFlight.get(agentId);
    if (!existing) return;
    existing.abort();
    inFlight.delete(agentId);
  };

  const runBackfill = (agent: Agent): void => {
    if (!deps.generateAgentDraft) return;
    const generateAgentDraft = deps.generateAgentDraft;
    const agentId = agent.id;
    const expectedUpdatedAt = agent.updatedAt;

    cancel(agentId);
    const controller = new AbortController();
    inFlight.set(agentId, controller);

    const rulesText = [agent.identity?.trim(), agent.systemPrompt?.trim()]
      .filter(Boolean)
      .join('\n\n');
    const appLanguage = deps.getLanguage?.() === 'en'
      ? AgentDraftLanguage.En
      : AgentDraftLanguage.Zh;
    const language = detectPreferredAgentLanguage(rulesText || agent.name || '', appLanguage);

    void (async () => {
      try {
        const result = await generateAgentDraft(
          {
            mode: AgentDraftMode.Summary,
            name: agent.name?.trim() || undefined,
            goal: agent.name?.trim() || '',
            existingInstructions: rulesText || undefined,
            workingDirectory: agent.workingDirectory?.trim() || undefined,
            language,
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        if (!result.success) {
          if ('errorCode' in result) {
            if (
              result.errorCode === AgentDraftErrorCode.NoModel
              || result.errorCode === AgentDraftErrorCode.UnsupportedModel
              || result.errorCode === AgentDraftErrorCode.Cancelled
              || result.errorCode === AgentDraftErrorCode.Timeout
            ) {
              console.debug(`[AgentDescriptionBackfill] Skipped for ${agentId}: ${result.errorCode}`);
            } else {
              console.warn(`[AgentDescriptionBackfill] Failed for ${agentId} (${result.errorCode}): ${result.error}`);
            }
          }
          return;
        }

        const generatedDescription = result.draft.description.trim();
        if (!generatedDescription) return;

        const latest = deps.getAgentManager().getAgent(agentId);
        if (!latest || latest.description?.trim() || latest.updatedAt !== expectedUpdatedAt) {
          return;
        }

        const updated = deps.getAgentManager().updateAgent(agentId, {
          description: generatedDescription,
        });
        if (!updated) return;

        deps.syncOpenClawConfig({ reason: 'agent-description-backfilled' }).catch(err => {
          console.warn(`[AgentDescriptionBackfill] Config sync failed for ${agentId}:`, err);
        });
        deps.onAgentDescriptionUpdated();
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(`[AgentDescriptionBackfill] Unexpected error for ${agentId}:`, error);
        }
      } finally {
        if (inFlight.get(agentId) === controller) {
          inFlight.delete(agentId);
        }
      }
    })();
  };

  const evaluateAndSchedule = (
    trigger: AgentDescriptionBackfillTrigger,
    previousAgent: Agent | null,
    nextAgent: Agent,
    updates?: UpdateAgentRequest,
  ): void => {
    if (!deps.generateAgentDraft) return;
    if (nextAgent.description?.trim()) {
      cancel(nextAgent.id);
      return;
    }

    const hasRules = Boolean(nextAgent.systemPrompt?.trim() || nextAgent.identity?.trim());
    const hasFolderContext = !hasRules && Boolean(nextAgent.workingDirectory?.trim())
      ? Boolean(readFolderContext(nextAgent.workingDirectory))
      : false;

    const eligible = shouldBackfillAgentDescription({
      trigger,
      previousAgent,
      nextAgent,
      updates,
      hasFolderContext,
    });
    if (!eligible) {
      if (trigger === AgentDescriptionBackfillTrigger.Update) {
        const userCleared = Boolean(previousAgent?.description?.trim())
          && updates?.description !== undefined
          && !updates.description.trim();
        if (userCleared) {
          cancel(nextAgent.id);
        }
      }
      return;
    }

    runBackfill(nextAgent);
  };

  return {
    scheduleForCreatedAgent: (agent) => {
      evaluateAndSchedule(AgentDescriptionBackfillTrigger.Create, null, agent);
    },
    scheduleForUpdatedAgent: ({ previousAgent, nextAgent, updates }) => {
      evaluateAndSchedule(AgentDescriptionBackfillTrigger.Update, previousAgent, nextAgent, updates);
    },
    cancel,
  };
}
