import { inferOriginAndBinding } from './origin';
import type { TaskOrigin, ExecutionBinding } from './origin';
import type { TaskPolicy, PolicyTaskModel, PolicyTaskInput, PolicyDelivery } from './policies/types';
import type { SessionTarget, WakeMode } from './constants';
import { BindingKind, ScheduleKind, PayloadKind, DeliveryMode, SessionTarget as ST, WakeMode as WM } from './constants';

/** Minimal wire task shape for mapping (avoids importing renderer types) */
export interface WireTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: unknown;
  sessionTarget: SessionTarget;
  wakeMode: WakeMode;
  payload: unknown;
  delivery: PolicyDelivery;
  agentId: string | null;
  sessionKey: string | null;
  state: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TaskModelMapperResult {
  wire: WireTask;
  origin: TaskOrigin;
  binding: ExecutionBinding;
}

export class TaskModelMapper {
  fromWire(
    wire: WireTask,
    meta?: { origin: TaskOrigin; binding: ExecutionBinding },
  ): PolicyTaskModel {
    const resolved = meta ?? inferOriginAndBinding(wire);
    return {
      ...wire,
      origin: resolved.origin,
      binding: resolved.binding,
    };
  }

  toWireInput(model: PolicyTaskModel, policy: TaskPolicy): PolicyTaskInput {
    const wireBinding = policy.toWireBinding(model.binding);
    return {
      name: model.name,
      description: model.description,
      enabled: model.enabled,
      schedule: model.schedule,
      sessionTarget: wireBinding.sessionTarget,
      wakeMode: model.wakeMode,
      payload: model.payload,
      delivery: model.delivery,
      agentId: model.agentId,
      sessionKey: wireBinding.sessionKey,
    };
  }

  createDraft(origin: TaskOrigin, defaults: Partial<PolicyTaskInput>): PolicyTaskModel {
    const now = new Date().toISOString();
    const defaultBinding: ExecutionBinding = { kind: BindingKind.NewSession };

    return {
      id: `draft-${Date.now()}`,
      name: defaults.name ?? '',
      description: defaults.description ?? '',
      enabled: defaults.enabled ?? true,
      schedule: defaults.schedule ?? { kind: ScheduleKind.Every, everyMs: 3600000 },
      sessionTarget: defaults.sessionTarget ?? ST.Main,
      wakeMode: defaults.wakeMode ?? WM.Now,
      payload: defaults.payload ?? { kind: PayloadKind.SystemEvent, text: '' },
      delivery: defaults.delivery ?? { mode: DeliveryMode.None },
      agentId: defaults.agentId ?? null,
      sessionKey: defaults.sessionKey ?? null,
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: now,
      updatedAt: now,
      origin,
      binding: defaultBinding,
    };
  }
}
