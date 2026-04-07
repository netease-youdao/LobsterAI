import type { TaskOrigin, ExecutionBinding } from '../origin';
import type { TaskPolicy, PolicyTaskModel, PolicyTaskInput, PolicyDelivery, WireBinding } from './types';
import { buildManagedSessionKey } from '../../main/libs/openclawChannelSessionSync';
import { OriginKind, BindingKind, SessionTarget, WakeMode, DeliveryMode, DeliveryChannel, RunBehavior } from '../constants';

export class CoworkTaskPolicy implements TaskPolicy {
  readonly kind = OriginKind.Cowork;

  getCreateDefaults(origin: TaskOrigin): Partial<PolicyTaskInput> {
    if (origin.kind !== OriginKind.Cowork) {
      throw new Error('Invalid origin for CoworkTaskPolicy');
    }
    return {
      sessionTarget: SessionTarget.Main,
      wakeMode: WakeMode.Now,
      delivery: { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last },
    };
  }

  normalizeDraft(draft: PolicyTaskModel): PolicyTaskModel {
    return draft;
  }

  onDeliveryChanged(draft: PolicyTaskModel, newDelivery: PolicyDelivery): PolicyTaskModel {
    // Cowork tasks: delivery change does NOT affect binding (always bound to original session)
    return { ...draft, delivery: newDelivery };
  }

  toWireBinding(binding: ExecutionBinding): WireBinding {
    if (binding.kind === BindingKind.UISession) {
      return { sessionTarget: SessionTarget.Main, sessionKey: buildManagedSessionKey(binding.sessionId) };
    }
    if (binding.kind === BindingKind.SessionKey) {
      return { sessionTarget: SessionTarget.Isolated, sessionKey: binding.sessionKey };
    }
    return { sessionTarget: SessionTarget.Main, sessionKey: null };
  }

  describeRunBehavior(task: PolicyTaskModel): string {
    if (task.binding.kind === BindingKind.UISession) {
      return RunBehavior.uiSession;
    }
    return RunBehavior.newSession;
  }

  getReadonlyFields(): string[] {
    return ['origin'];
  }
}
