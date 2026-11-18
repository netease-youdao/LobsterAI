import { AgentSource } from '@shared/agent/constants';
import { LogReporterAction } from '@shared/analytics/constants';
import {
  catalogAnalyticsId,
  isUsageId,
  readUsageContext,
  UsageAnalytics,
  type UsageContext,
  UsageEntry,
  usageFailureCode,
  UsageOutcome,
  type UsageParams,
  UsageStage,
} from '@shared/analytics/usage';

import { store } from '../store';
import type { Artifact } from '../types/artifact';
import { getAnalyticsIdentitySnapshot } from './analyticsIdentity';
import { configService } from './config';
import { reportYdAnalyzer } from './logReporter';

let owner: string | null | undefined;
let draft:
  | {
      agentId: string;
      journeyId: string;
      presetId?: string;
      catalogVersion?: string;
      entry: UsageEntry;
    }
  | undefined;
const contexts = new Map<string, UsageContext>();
const artifactIds = new Map<string, string>();
const discoveries = new Set<string>();
const submittedTurns = new Set<string>();
const submissions = new WeakMap<UsageContext, string>();

export function resetDraftAnalytics(): void {
  draft = undefined;
}

function syncOwner(): string | null {
  const next =
    configService.getConfig().usageAnalyticsEnabled === false
      ? null
      : getAnalyticsIdentitySnapshot().userId;
  if (next !== owner) {
    owner = next;
    draft = undefined;
    contexts.clear();
    artifactIds.clear();
    discoveries.clear();
    submittedTurns.clear();
  }
  return next;
}

export function reportExpertJourney(stage: UsageStage, params: UsageParams): void {
  void reportYdAnalyzer({
    action: LogReporterAction.ExpertJourney,
    schemaVersion: UsageAnalytics.SchemaVersion,
    stage,
    ...params,
  });
}

export function prepareExpertAnalytics(
  agentId: string,
  presetId: string | undefined,
  params: {
    journeyId?: string;
    catalogVersion?: string;
    entry: UsageEntry;
  },
): void {
  try {
    if (syncOwner() === null) return;
    draft = {
      agentId,
      presetId: catalogAnalyticsId(presetId),
      journeyId: params.journeyId ?? crypto.randomUUID(),
      catalogVersion: catalogAnalyticsId(params.catalogVersion),
      entry: params.entry,
    };
    const { agentId: _localAgentId, ...fields } = draft;
    reportExpertJourney(UsageStage.Draft, fields);
  } catch {
    /* A telemetry failure must not prevent opening a draft. */
  }
}

export function getDraftAnalytics(agentId: string): UsageParams {
  try {
    syncOwner();
    if (draft?.agentId !== agentId) return {};
    const { agentId: _localAgentId, ...fields } = draft;
    return fields;
  } catch {
    return {};
  }
}

export function getSessionUsageContext(
  sessionId: string,
  messageId?: string,
): UsageContext | undefined {
  const currentOwner = syncOwner();
  if (currentOwner === null) return undefined;
  const session = store.getState().cowork.currentSession;
  if (session?.id === sessionId) {
    const messages = session.messages;
    const index = messageId
      ? messages.findIndex(message => message.id === messageId)
      : messages.length - 1;
    for (let i = index; i >= 0; i -= 1) {
      const value = messages[i].metadata?.usageAnalytics as Record<string, unknown> | undefined;
      if (value?.ownerKey === currentOwner && value.localSessionId === sessionId) {
        const context = readUsageContext(value);
        if (context) return context;
      }
      if (messageId && messages[i].type === 'user') break;
    }
  }
  // Never assign an old artifact to the latest turn in its session.
  return messageId ? undefined : contexts.get(sessionId);
}

export function beginTaskSubmission(
  agentId?: string,
  sessionId?: string,
): UsageContext | undefined {
  try {
    const currentOwner = syncOwner();
    if (currentOwner === null) return undefined;
    const state = store.getState();
    const resolvedAgentId =
      agentId ?? state.cowork.currentSession?.agentId ?? state.agent.currentAgentId;
    const agent = state.agent.agents.find(item => item.id === resolvedAgentId);
    const previous = sessionId ? getSessionUsageContext(sessionId) : undefined;
    const prepared = !sessionId && draft?.agentId === resolvedAgentId ? draft : undefined;
    const context: UsageContext = {
      taskId: previous?.taskId ?? crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      journeyId: prepared?.journeyId ?? previous?.journeyId,
      presetId: agent?.source === AgentSource.Preset ? catalogAnalyticsId(agent.presetId) : undefined,
      catalogVersion: prepared?.catalogVersion ?? previous?.catalogVersion,
      entry: sessionId ? UsageEntry.Continue : (prepared?.entry ?? UsageEntry.Direct),
    };
    submissions.set(context, currentOwner);
    void reportYdAnalyzer({
      action: LogReporterAction.TaskLifecycle,
      schemaVersion: UsageAnalytics.SchemaVersion,
      ...context,
      stage: UsageStage.Submit,
      outcome: UsageOutcome.Started,
    });
    return context;
  } catch {
    return undefined;
  }
}

export function finishTaskSubmission(
  context: UsageContext | undefined,
  sessionId?: string,
  error?: unknown,
): void {
  try {
    if (!context || submissions.get(context) !== syncOwner()) return;
    submissions.delete(context);
    if (sessionId) {
      submittedTurns.add(context.turnId);
      if (submittedTurns.size > UsageAnalytics.MaxTrackedItems) submittedTurns.delete(submittedTurns.values().next().value!);
      contexts.set(sessionId, context);
      if (contexts.size > UsageAnalytics.MaxTrackedItems)
        contexts.delete(contexts.keys().next().value!);
      if (draft?.journeyId === context.journeyId) draft = undefined;
    }
    void reportYdAnalyzer({
      action: LogReporterAction.TaskLifecycle,
      schemaVersion: UsageAnalytics.SchemaVersion,
      ...context,
      stage: UsageStage.Submit,
      outcome: sessionId ? UsageOutcome.Succeeded : UsageOutcome.Failed,
      failureCode: sessionId ? undefined : usageFailureCode(error),
    });
  } catch {
    /* IPC behavior must not depend on telemetry. */
  }
}

export function getArtifactUsageParams(artifact: Artifact | null | undefined): UsageParams {
  if (!artifact) return {};
  try {
    const context = getSessionUsageContext(artifact.sessionId, artifact.messageId);
    const key = `${artifact.sessionId}:${artifact.id}`;
    let artifactId = artifactIds.get(key);
    if (!artifactId) {
      artifactId = crypto.randomUUID();
      artifactIds.set(key, artifactId);
      if (artifactIds.size > UsageAnalytics.MaxTrackedItems)
        artifactIds.delete(artifactIds.keys().next().value!);
    }
    const session = store.getState().cowork.currentSession;
    const mediaJobId = session?.id === artifact.sessionId
      ? session.messages.find(message => message.id === artifact.messageId)?.metadata?.mediaJobId : undefined;
    return { ...context, artifactId, mediaJobId: isUsageId(mediaJobId) ? mediaJobId : undefined, attributionKnown: Boolean(context) };
  } catch {
    return {};
  }
}

/** Only live discoveries count; loading an old conversation is not a new delivery. */
export function reportArtifactDiscovery(artifact: Artifact): void {
  const fields = getArtifactUsageParams(artifact);
  if (!fields.turnId || discoveries.has(String(fields.artifactId))) return;
  if (!submittedTurns.has(String(fields.turnId))) return;
  discoveries.add(String(fields.artifactId));
  if (discoveries.size > UsageAnalytics.MaxTrackedItems)
    discoveries.delete(discoveries.values().next().value!);
  void reportYdAnalyzer({
    action: LogReporterAction.ArtifactDelivery,
    schemaVersion: UsageAnalytics.SchemaVersion,
    ...fields,
    stage: UsageStage.Discovered,
    artifactType: artifact.type,
    artifactSource: artifact.source,
  });
}
