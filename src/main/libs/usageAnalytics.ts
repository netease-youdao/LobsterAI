import { randomUUID } from 'crypto';

import { AgentId, AgentSource } from '../../shared/agent/constants';
import { LogReporterAction } from '../../shared/analytics/constants';
import {
  catalogAnalyticsId,
  readUsageContext,
  UsageAnalytics,
  type UsageContext,
  UsageEntry,
  usageFailureCode,
  usageFailureDetails,
  UsageOrigin,
  UsageOutcome,
  type UsageParams,
  UsageStage,
} from '../../shared/analytics/usage';
import type { CoworkMessage } from '../coworkStore';
import type { CoworkStartOptions, PermissionRequest } from './agentEngine/types';
import {
  type AnalyticsSkill,
  CapabilityKind,
  classifyCapability,
  resourceAnalyticsId,
} from './capabilityUsage';
import type { MainLogEventParams } from './mainLogReporter';

interface Turn {
  sessionId: string;
  context: UsageContext;
  owner: string;
  origin: UsageOrigin;
  startedAt: number;
  firstResponse: boolean;
  timedOut: boolean;
  toolErrors: number;
  tools: Map<string, { id: string; startedAt: number; fields: UsageParams; ended: boolean }>;
  skills?: AnalyticsSkill[];
  messages: Set<string>;
  permissions: Map<string, number>;
}

export interface UsageAnalyticsDeps {
  report: (event: MainLogEventParams) => void;
  /** null means disabled/unavailable. Changing accounts discards old in-flight attribution. */
  getOwner: () => string | null;
  getSession: (id: string) => {
    agentId: string;
    messages: CoworkMessage[];
    scheduledTaskId?: string | null;
  } | null;
  getAgent: (id: string) => { source: string; presetId?: string } | null;
  updateMessage: (sessionId: string, id: string, metadata: Record<string, unknown>) => void;
  now?: () => number;
  getSkills?: () => AnalyticsSkill[];
  getResourceSalt?: () => string;
}

/** Runtime observer: counts only live turns, never history loads or streaming chunks. */
export class TaskUsageAnalytics {
  private readonly turns = new Map<string, Turn>();
  private readonly recent = new Map<string, { context: UsageContext; owner: string }>();
  private readonly now: () => number;
  private readonly fallbackSalt = randomUUID();

  constructor(private readonly deps: UsageAnalyticsDeps) {
    this.now = deps.now ?? Date.now;
  }

  begin(
    sessionId: string,
    options: CoworkStartOptions,
    continuing: boolean,
    origin: UsageOrigin = UsageOrigin.Desktop,
  ): boolean {
    let started = false;
    this.safe(() => {
      const owner = this.deps.getOwner();
      if (owner === null) {
        this.turns.clear();
        this.recent.clear();
        return;
      }
      // A duplicate/rejected submission must not replace the running turn's attribution.
      if (this.active(sessionId)) return;
      const session = this.deps.getSession(sessionId);
      if (!session) return;
      const previous = [...session.messages]
        .reverse()
        .map(message => message.metadata?.usageAnalytics)
        .find(
          value =>
            value &&
            typeof value === 'object' &&
            (value as { ownerKey?: string }).ownerKey === owner &&
            (value as { localSessionId?: string }).localSessionId === sessionId,
        );
      const prior = readUsageContext(previous);
      const supplied = readUsageContext(options.analytics);
      const agent = this.deps.getAgent(session.agentId);
      const presetId =
        agent?.source === AgentSource.Preset ? catalogAnalyticsId(agent.presetId) : undefined;
      const context: UsageContext = {
        taskId: continuing && prior ? prior.taskId : (supplied?.taskId ?? randomUUID()),
        turnId: supplied?.turnId ?? randomUUID(),
        journeyId: supplied?.journeyId ?? prior?.journeyId,
        presetId,
        catalogVersion: supplied?.catalogVersion ?? prior?.catalogVersion,
        entry: supplied?.entry ?? (continuing ? UsageEntry.Continue : UsageEntry.Runtime),
      };
      const turn: Turn = {
        sessionId,
        context,
        owner,
        origin,
        startedAt: this.now(),
        firstResponse: false,
        timedOut: false,
        toolErrors: 0,
        tools: new Map(),
        messages: new Set(),
        permissions: new Map(),
      };
      this.turns.set(sessionId, turn);
      started = true;
      this.recent.set(sessionId, { context, owner });
      if (this.recent.size > UsageAnalytics.MaxTrackedItems)
        this.recent.delete(this.recent.keys().next().value!);
      if (options.skipInitialUserMessage) {
        const user = [...session.messages].reverse().find(message => message.type === 'user');
        if (user) this.annotate(turn, user);
      }
      this.emit(turn, LogReporterAction.TaskLifecycle, UsageStage.Start, {
        outcome: UsageOutcome.Started,
        continuing,
        agentSource: agent?.source ?? 'unknown',
        isMainAgent: session.agentId === AgentId.Main,
        scheduled: Boolean(session.scheduledTaskId),
        selectedSkillCount: options.messageSkillIds?.length ?? options.skillIds?.length ?? 0,
        runtimeSkillCount: options.skillIds?.length ?? 0,
        kitCount: options.kitIds?.length ?? 0,
        mediaMode: options.mediaSelection?.mode ?? 'none',
      });
      // These are supplied capabilities, not evidence that a skill or kit was executed.
      const salt = this.deps.getResourceSalt?.() || this.fallbackSalt;
      for (const [kind, ids] of [
        [CapabilityKind.Skill, options.skillIds],
        [CapabilityKind.Kit, options.kitIds],
      ] as const) {
        for (const id of new Set(ids ?? []))
          this.emit(turn, LogReporterAction.CapabilityUse, UsageStage.Select, {
            capabilityKind: kind,
            capabilityId: resourceAnalyticsId(salt, kind, id),
            kitId: kind === CapabilityKind.Kit ? catalogAnalyticsId(id) : undefined,
          });
      }
    });
    return started;
  }

  context(sessionId: string): UsageContext | undefined {
    try {
      const recent = this.recent.get(sessionId);
      return recent && recent.owner === this.deps.getOwner() ? recent.context : undefined;
    } catch {
      return undefined;
    }
  }

  message(sessionId: string, message: CoworkMessage): void {
    this.safe(() => {
      const turn = this.active(sessionId);
      if (!turn || message.timestamp < turn.startedAt || turn.messages.has(message.id)) return;
      const previous = readUsageContext(message.metadata?.usageAnalytics);
      if (previous && previous.turnId !== turn.context.turnId) return;
      turn.messages.add(message.id);
      this.annotate(turn, message);
      this.observe(turn, message.type, message.id, message.metadata ?? {});
    });
  }

  update(sessionId: string, messageId: string, metadata?: Record<string, unknown>): void {
    this.safe(() => {
      const turn = this.active(sessionId);
      if (!turn || !turn.messages.has(messageId) || !metadata) return;
      // The adapter replaces metadata on final updates. Preserve attribution for reloads.
      if (metadata.isFinal === true || metadata.isStreaming === false || metadata.isGenerating === false) {
        metadata.usageAnalytics = { ...turn.context, ownerKey: turn.owner, localSessionId: sessionId };
        this.deps.updateMessage(sessionId, messageId, metadata);
      }
      this.observe(turn, 'update', messageId, metadata);
    });
  }

  attachDelivery(sessionId: string, message: CoworkMessage, context: UsageContext, mediaJobId: string): void {
    this.safe(() => {
      const ownerKey = this.deps.getOwner();
      if (ownerKey === null) return;
      message.metadata = { ...message.metadata, mediaJobId,
        usageAnalytics: { ...context, ownerKey, localSessionId: sessionId } };
      this.deps.updateMessage(sessionId, message.id, message.metadata);
    });
  }

  permission(sessionId: string, request: PermissionRequest): void {
    this.safe(() => {
      const turn = this.active(sessionId);
      if (!turn || turn.permissions.has(request.requestId)) return;
      turn.permissions.set(request.requestId, this.now());
      this.emit(turn, LogReporterAction.TaskLifecycle, UsageStage.Permission, {
        outcome: UsageOutcome.Requested,
      });
    });
  }

  permissionResolved(sessionId: string, requestId: string, behavior?: string): void {
    this.safe(() => {
      const turn = this.active(sessionId);
      const start = turn?.permissions.get(requestId);
      if (!turn || start === undefined) return;
      if (!behavior) turn.permissions.delete(requestId);
      this.emit(
        turn,
        LogReporterAction.TaskLifecycle,
        behavior ? UsageStage.PermissionDecision : UsageStage.Permission,
        {
          outcome:
            behavior === 'deny'
              ? UsageOutcome.Denied
              : behavior === 'allow'
                ? UsageOutcome.Allowed
                : UsageOutcome.Resolved,
          durationMs: Math.max(0, this.now() - start),
        },
      );
    });
  }

  end(sessionId: string, outcome: UsageOutcome, error?: unknown): void {
    this.safe(() => {
      const turn = this.active(sessionId);
      if (!turn) return;
      this.turns.delete(sessionId);
      const finalOutcome = turn.timedOut || (error && usageFailureCode(error) === 'timeout')
        ? UsageOutcome.Timeout
        : outcome === UsageOutcome.Completed && turn.toolErrors > 0
          ? UsageOutcome.CompletedWithToolErrors
          : outcome;
      for (const tool of turn.tools.values()) {
        if (!tool.ended)
          this.emit(turn, LogReporterAction.CapabilityUse, UsageStage.End, {
            callId: tool.id,
            ...tool.fields,
            outcome: outcome === UsageOutcome.Cancelled ? outcome : UsageOutcome.Interrupted,
            durationMs: Math.max(0, this.now() - tool.startedAt),
          });
      }
      this.emit(turn, LogReporterAction.TaskLifecycle, UsageStage.End, {
        outcome: finalOutcome,
        durationMs: Math.max(0, this.now() - turn.startedAt),
        toolCount: turn.tools.size,
        toolErrorCount: turn.toolErrors,
        pendingPermissionCount: turn.permissions.size,
        hadResponse: turn.firstResponse,
        failureCode: error ? usageFailureCode(error) : turn.timedOut ? 'timeout' : undefined,
      });
    });
  }

  stopAll(): void {
    for (const sessionId of this.turns.keys()) this.end(sessionId, UsageOutcome.Cancelled);
  }

  private active(sessionId: string): Turn | undefined {
    const turn = this.turns.get(sessionId);
    if (turn && this.deps.getOwner() !== turn.owner) {
      this.turns.delete(sessionId);
      this.recent.delete(sessionId);
      return undefined;
    }
    return turn;
  }

  private annotate(turn: Turn, message: CoworkMessage): void {
    message.metadata = {
      ...message.metadata,
      usageAnalytics: { ...turn.context, ownerKey: turn.owner, localSessionId: turn.sessionId },
    };
    this.deps.updateMessage(turn.sessionId, message.id, message.metadata);
  }

  private observe(
    turn: Turn,
    type: string,
    messageId: string,
    metadata: Record<string, unknown>,
  ): void {
    if (metadata.isTimeout === true) turn.timedOut = true;
    if (
      !turn.firstResponse &&
      (type === 'assistant' || type === 'tool_use') &&
      metadata.isTimeout !== true
    ) {
      turn.firstResponse = true;
      this.emit(turn, LogReporterAction.TaskLifecycle, UsageStage.FirstResponse, {
        durationMs: this.now() - turn.startedAt,
      });
    }
    const toolKey = typeof metadata.toolUseId === 'string' ? metadata.toolUseId : messageId;
    if (
      (type === 'tool_use' || (type === 'update' && metadata.isGenerating === false)) &&
      metadata.isGenerating !== true &&
      !turn.tools.has(toolKey)
    ) {
      const name = typeof metadata.toolName === 'string' ? metadata.toolName : '';
      if (name.toLowerCase() === 'read') turn.skills ??= this.deps.getSkills?.() ?? [];
      const fields = classifyCapability(
        name,
        metadata.toolInput,
        turn.skills ?? [],
        this.deps.getResourceSalt?.() || this.fallbackSalt,
      );
      const tool = { id: randomUUID(), startedAt: this.now(), fields, ended: false };
      turn.tools.set(toolKey, tool);
      this.emit(turn, LogReporterAction.CapabilityUse, UsageStage.Start, {
        callId: tool.id,
        ...fields,
      });
    }
    const tool = turn.tools.get(toolKey);
    if (
      tool &&
      !tool.ended &&
      (type === 'tool_result' || type === 'update') &&
      metadata.isStreaming !== true &&
      metadata.isGenerating !== true &&
      (type === 'tool_result' || metadata.isStreaming === false)
    ) {
      tool.ended = true;
      if (metadata.isError === true) turn.toolErrors += 1;
      this.emit(turn, LogReporterAction.CapabilityUse, UsageStage.End, {
        callId: tool.id,
        ...tool.fields,
        outcome: metadata.isError === true ? UsageOutcome.Failed : UsageOutcome.Succeeded,
        ...(metadata.isError === true ? usageFailureDetails(metadata.error ?? metadata.toolResult) : {}),
        durationMs: Math.max(0, this.now() - tool.startedAt),
      });
    }
  }

  private emit(
    turn: Turn,
    action: MainLogEventParams['action'],
    stage: UsageStage,
    fields: UsageParams,
  ): void {
    if (this.deps.getOwner() !== turn.owner) return;
    this.deps.report({
      action,
      schemaVersion: UsageAnalytics.SchemaVersion,
      ...turn.context,
      origin: turn.origin,
      stage,
      ...fields,
    });
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* Analytics must never prevent a task, tool or permission from proceeding. */
    }
  }
}
