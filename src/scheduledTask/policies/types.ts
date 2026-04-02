import type { TaskOrigin, ExecutionBinding } from '../origin';
import type { SessionTarget, WakeMode, DeliveryMode } from '../constants';

export interface WireBinding {
  sessionTarget: SessionTarget;
  sessionKey: string | null;
}

/** Minimal delivery shape (avoids importing renderer types) */
export interface PolicyDelivery {
  mode: DeliveryMode;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
}

/** Minimal ScheduledTaskModel shape for policy operations */
export interface PolicyTaskModel {
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
  origin: TaskOrigin;
  binding: ExecutionBinding;
}

/** Minimal input shape for task creation defaults */
export interface PolicyTaskInput {
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
}

export interface TaskPolicy {
  readonly kind: TaskOrigin['kind'];

  /** Defaults for new task creation */
  getCreateDefaults(origin: TaskOrigin): Partial<PolicyTaskInput>;

  /** Normalize draft before save (validate + auto-fill + binding consistency) */
  normalizeDraft(draft: PolicyTaskModel): PolicyTaskModel;

  /** Update binding when delivery changes */
  onDeliveryChanged(draft: PolicyTaskModel, newDelivery: PolicyDelivery): PolicyTaskModel;

  /** Map ExecutionBinding → wire format sessionTarget/sessionKey */
  toWireBinding(binding: ExecutionBinding): WireBinding;

  /** Human-readable description of run behavior */
  describeRunBehavior(task: PolicyTaskModel): string;

  /** Fields that should be read-only in the UI */
  getReadonlyFields(): string[];
}
