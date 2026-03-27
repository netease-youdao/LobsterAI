import type { ExecutionBinding } from '../origin';
import type { TaskPolicy, PolicyTaskModel, PolicyTaskInput, PolicyDelivery, WireBinding } from './types';
import { buildManagedSessionKey } from '../../main/libs/openclawChannelSessionSync';
import { BindingKind, SessionTarget, WakeMode, DeliveryMode, DeliveryChannel, OriginKind, RunBehavior } from '../constants';

export class ManualTaskPolicy implements TaskPolicy {
  readonly kind = OriginKind.Manual;

  getCreateDefaults(): Partial<PolicyTaskInput> {
    return {
      sessionTarget: SessionTarget.Isolated,
      wakeMode: WakeMode.Now,
      delivery: { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last },
    };
  }

  normalizeDraft(draft: PolicyTaskModel): PolicyTaskModel {
    // If IM announce channel selected but binding isn't im_session, auto-link
    if (draft.delivery.mode === DeliveryMode.Announce
        && typeof draft.delivery.channel === 'string'
        && draft.delivery.channel.length > 0
        && draft.delivery.channel !== DeliveryChannel.Last
        && draft.binding.kind !== BindingKind.IMSession) {
      return {
        ...draft,
        binding: {
          kind: BindingKind.IMSession,
          platform: draft.delivery.channel,
          conversationId: '',
        },
      };
    }
    // If binding is im_session but delivery is not announce, reset
    if (draft.binding.kind === BindingKind.IMSession
        && draft.delivery.mode !== DeliveryMode.Announce) {
      return { ...draft, binding: { kind: BindingKind.NewSession } };
    }
    return draft;
  }

  onDeliveryChanged(draft: PolicyTaskModel, newDelivery: PolicyDelivery): PolicyTaskModel {
    if (newDelivery.mode === DeliveryMode.Announce
        && typeof newDelivery.channel === 'string'
        && newDelivery.channel.length > 0
        && newDelivery.channel !== DeliveryChannel.Last) {
      return {
        ...draft,
        delivery: newDelivery,
        binding: {
          kind: BindingKind.IMSession,
          platform: newDelivery.channel,
          conversationId: '',
        },
      };
    }
    if (newDelivery.mode === DeliveryMode.None || newDelivery.mode === DeliveryMode.Webhook) {
      return { ...draft, delivery: newDelivery, binding: { kind: BindingKind.NewSession } };
    }
    return { ...draft, delivery: newDelivery };
  }

  toWireBinding(binding: ExecutionBinding): WireBinding {
    switch (binding.kind) {
      case BindingKind.NewSession:
        return { sessionTarget: SessionTarget.Main, sessionKey: null };
      case BindingKind.UISession:
        return { sessionTarget: SessionTarget.Main, sessionKey: buildManagedSessionKey(binding.sessionId) };
      case BindingKind.IMSession:
        if (binding.sessionId) {
          return { sessionTarget: SessionTarget.Main, sessionKey: buildManagedSessionKey(binding.sessionId) };
        }
        return { sessionTarget: SessionTarget.Main, sessionKey: null };
      case BindingKind.SessionKey:
        return { sessionTarget: SessionTarget.Isolated, sessionKey: binding.sessionKey };
    }
  }

  describeRunBehavior(task: PolicyTaskModel): string {
    switch (task.binding.kind) {
      case BindingKind.NewSession: return RunBehavior.newSession;
      case BindingKind.UISession: return RunBehavior.uiSession;
      case BindingKind.IMSession: return RunBehavior.imSession(task.binding.platform);
      case BindingKind.SessionKey: return RunBehavior.sessionKey;
    }
  }

  getReadonlyFields(): string[] {
    return [];
  }
}
