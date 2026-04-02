import type { ExecutionBinding } from '../origin';
import type { TaskPolicy, PolicyTaskModel, PolicyTaskInput, PolicyDelivery, WireBinding } from './types';
import { OriginKind, BindingKind, SessionTarget, WakeMode, DeliveryMode, DeliveryChannel, RunBehavior } from '../constants';

export class LegacyTaskPolicy implements TaskPolicy {
  readonly kind = OriginKind.Legacy;

  getCreateDefaults(): Partial<PolicyTaskInput> {
    return {
      sessionTarget: SessionTarget.Main,
      wakeMode: WakeMode.NextHeartbeat,
    };
  }

  normalizeDraft(draft: PolicyTaskModel): PolicyTaskModel {
    if (draft.delivery.mode === DeliveryMode.Announce
        && typeof draft.delivery.channel === 'string'
        && draft.delivery.channel.length > 0
        && draft.delivery.channel !== DeliveryChannel.Last
        && draft.binding.kind === BindingKind.NewSession) {
      return {
        ...draft,
        binding: {
          kind: BindingKind.IMSession,
          platform: draft.delivery.channel,
          conversationId: '',
        },
      };
    }
    return draft;
  }

  onDeliveryChanged(draft: PolicyTaskModel, newDelivery: PolicyDelivery): PolicyTaskModel {
    if (newDelivery.mode === DeliveryMode.None || newDelivery.mode === DeliveryMode.Webhook) {
      return { ...draft, delivery: newDelivery, binding: { kind: BindingKind.NewSession } };
    }
    return { ...draft, delivery: newDelivery };
  }

  toWireBinding(_binding: ExecutionBinding): WireBinding {
    return { sessionTarget: SessionTarget.Main, sessionKey: null };
  }

  describeRunBehavior(_task: PolicyTaskModel): string {
    return RunBehavior.newSession;
  }

  getReadonlyFields(): string[] {
    return ['origin'];
  }
}
