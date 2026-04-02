import {
  isManagedSessionKey,
  parseManagedSessionKey,
  parseChannelSessionKey,
} from '../main/libs/openclawChannelSessionSync';
import {
  OriginKind,
  BindingKind,
  DeliveryMode,
  DeliveryChannel,
} from './constants';

// Re-declare origin/binding types here so common/ doesn't depend on renderer/
// These MUST be kept in sync with src/renderer/types/scheduledTask.ts

export type TaskOriginKind = OriginKind;

export type TaskOrigin =
  | { kind: typeof OriginKind.Legacy }
  | { kind: typeof OriginKind.IM; platform: string; conversationId: string }
  | { kind: typeof OriginKind.Cowork; sessionId: string }
  | { kind: typeof OriginKind.Manual };

export type ExecutionBinding =
  | { kind: typeof BindingKind.NewSession }
  | { kind: typeof BindingKind.UISession; sessionId: string }
  | { kind: typeof BindingKind.IMSession; platform: string; conversationId: string; sessionId?: string }
  | { kind: typeof BindingKind.SessionKey; sessionKey: string };

/** Minimal ScheduledTask shape needed for inference (avoids importing renderer types) */
interface InferableTask {
  sessionKey?: string | null;
  delivery?: { mode?: string; channel?: string };
  agentId?: string | null;
}

/**
 * Infer origin and binding from a ScheduledTask's wire fields.
 * Used for backward compatibility with tasks that have no stored metadata.
 * Pure function — no side effects.
 */
export function inferOriginAndBinding(task: InferableTask): {
  origin: TaskOrigin;
  binding: ExecutionBinding;
} {
  const sk = (task.sessionKey ?? '').trim();

  // 1. Managed session key: "agent:main:lobsterai:{sessionId}"
  if (sk && isManagedSessionKey(sk)) {
    const parsed = parseManagedSessionKey(sk);
    if (parsed) {
      const channel = task.delivery?.channel;
      const isIMChannel = task.delivery?.mode === DeliveryMode.Announce
        && typeof channel === 'string'
        && channel.length > 0
        && channel !== DeliveryChannel.Last;

      if (isIMChannel) {
        return {
          origin: { kind: OriginKind.IM, platform: channel!, conversationId: '' },
          binding: {
            kind: BindingKind.IMSession,
            platform: channel!,
            conversationId: '',
            sessionId: parsed.sessionId,
          },
        };
      }

      return {
        origin: { kind: OriginKind.Cowork, sessionId: parsed.sessionId },
        binding: { kind: BindingKind.UISession, sessionId: parsed.sessionId },
      };
    }
  }

  // 2. Channel session key: "agent:{agentId}:{platform}:{conversationId}"
  if (sk) {
    const channelInfo = parseChannelSessionKey(sk);
    if (channelInfo) {
      return {
        origin: { kind: OriginKind.IM, platform: channelInfo.platform, conversationId: channelInfo.conversationId },
        binding: {
          kind: BindingKind.IMSession,
          platform: channelInfo.platform,
          conversationId: channelInfo.conversationId,
        },
      };
    }

    // 2b. Has sessionKey but unknown format → session_key binding
    return {
      origin: { kind: OriginKind.Cowork, sessionId: '' },
      binding: { kind: BindingKind.SessionKey, sessionKey: sk },
    };
  }

  // 3. No sessionKey → manual origin
  return {
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
  };
}
