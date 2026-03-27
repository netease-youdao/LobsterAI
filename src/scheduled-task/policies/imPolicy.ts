import type { TaskOrigin, ExecutionBinding } from '../origin';
import type { TaskPolicy, PolicyTaskModel, PolicyTaskInput, PolicyDelivery, WireBinding } from './types';
import { buildManagedSessionKey } from '../../main/libs/openclawChannelSessionSync';
import { OriginKind, BindingKind, SessionTarget, WakeMode, DeliveryMode, RunBehavior } from '../constants';

export class IMTaskPolicy implements TaskPolicy {
  readonly kind = OriginKind.IM;

  getCreateDefaults(origin: TaskOrigin): Partial<PolicyTaskInput> {
    if (origin.kind !== OriginKind.IM) {
      throw new Error('Invalid origin for IMTaskPolicy');
    }
    return {
      sessionTarget: SessionTarget.Main,
      wakeMode: WakeMode.Now,
      delivery: { mode: DeliveryMode.Announce, channel: origin.platform },
    };
  }

  normalizeDraft(draft: PolicyTaskModel): PolicyTaskModel {
    if (draft.binding.kind === BindingKind.IMSession
        && draft.delivery.mode === DeliveryMode.Announce
        && draft.delivery.channel !== draft.binding.platform) {
      return {
        ...draft,
        delivery: { ...draft.delivery, channel: draft.binding.platform },
      };
    }
    return draft;
  }

  onDeliveryChanged(draft: PolicyTaskModel, newDelivery: PolicyDelivery): PolicyTaskModel {
    if (newDelivery.mode === DeliveryMode.None || newDelivery.mode === DeliveryMode.Webhook) {
      return { ...draft, delivery: newDelivery, binding: { kind: BindingKind.NewSession } };
    }
    if (newDelivery.mode === DeliveryMode.Announce && newDelivery.channel) {
      return {
        ...draft,
        delivery: newDelivery,
        binding: {
          kind: BindingKind.IMSession,
          platform: newDelivery.channel,
          conversationId: draft.binding.kind === BindingKind.IMSession ? draft.binding.conversationId : '',
        },
      };
    }
    return { ...draft, delivery: newDelivery };
  }

  toWireBinding(binding: ExecutionBinding): WireBinding {
    if (binding.kind === BindingKind.IMSession && binding.sessionId) {
      return { sessionTarget: SessionTarget.Main, sessionKey: buildManagedSessionKey(binding.sessionId) };
    }
    return { sessionTarget: SessionTarget.Main, sessionKey: null };
  }

  describeRunBehavior(task: PolicyTaskModel): string {
    if (task.binding.kind === BindingKind.IMSession) {
      return RunBehavior.imSession(task.binding.platform);
    }
    return RunBehavior.newSession;
  }

  getReadonlyFields(): string[] {
    return ['origin'];
  }
}
