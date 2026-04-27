import { OriginKind } from '../constants';
import type { TaskOrigin } from '../origin';
import { CoworkTaskPolicy } from './coworkPolicy';
import { IMTaskPolicy } from './imPolicy';
import { LegacyTaskPolicy } from './legacyPolicy';
import { ManualTaskPolicy } from './manualPolicy';
import type { TaskPolicy } from './types';

export class TaskPolicyRegistry {
  private readonly policies: Map<string, TaskPolicy>;

  constructor(policies: TaskPolicy[]) {
    this.policies = new Map(policies.map(p => [p.kind, p]));
  }

  get(origin: TaskOrigin): TaskPolicy {
    return this.policies.get(origin.kind) ?? this.policies.get(OriginKind.Manual)!;
  }
}

export const taskPolicyRegistry = new TaskPolicyRegistry([
  new LegacyTaskPolicy(),
  new IMTaskPolicy(),
  new CoworkTaskPolicy(),
  new ManualTaskPolicy(),
]);
