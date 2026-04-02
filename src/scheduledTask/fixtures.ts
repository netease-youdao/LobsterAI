import type { PolicyTaskModel, PolicyDelivery } from './policies/types';
import type { TaskOrigin, ExecutionBinding } from './origin';
import type { SessionTarget, WakeMode } from './constants';
import {
  SessionTarget as ST,
  WakeMode as WM,
  ScheduleKind,
  PayloadKind,
  DeliveryMode,
  DefaultAgentId,
  OriginKind,
  BindingKind,
} from './constants';

interface TaskOverrides {
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: unknown;
  sessionTarget?: SessionTarget;
  wakeMode?: WakeMode;
  payload?: unknown;
  delivery?: PolicyDelivery;
  agentId?: string | null;
  sessionKey?: string | null;
  state?: unknown;
  createdAt?: string;
  updatedAt?: string;
  origin?: TaskOrigin;
  binding?: ExecutionBinding;
}

/** Create a minimal wire-format ScheduledTask with sensible defaults. */
export function makeTask(overrides: TaskOverrides = {}) {
  return {
    id: overrides.id ?? 'task-test-001',
    name: overrides.name ?? 'Test Task',
    description: overrides.description ?? '',
    enabled: overrides.enabled ?? true,
    schedule: overrides.schedule ?? { kind: ScheduleKind.Every, everyMs: 3600000 },
    sessionTarget: overrides.sessionTarget ?? ST.Main,
    wakeMode: overrides.wakeMode ?? WM.Now,
    payload: overrides.payload ?? { kind: PayloadKind.SystemEvent, text: 'test' },
    delivery: overrides.delivery ?? { mode: DeliveryMode.None as const },
    agentId: overrides.agentId ?? DefaultAgentId,
    sessionKey: overrides.sessionKey ?? null,
    state: overrides.state ?? {
      nextRunAtMs: 0,
      lastRunAtMs: 0,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      runningAtMs: null,
      consecutiveErrors: 0,
    },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

/** Create a minimal ScheduledTaskModel (domain model) with origin + binding. */
export function makeModel(overrides: TaskOverrides = {}): PolicyTaskModel {
  const base = makeTask(overrides);
  return {
    ...base,
    origin: overrides.origin ?? { kind: OriginKind.Manual },
    binding: overrides.binding ?? { kind: BindingKind.NewSession },
  } as PolicyTaskModel;
}
