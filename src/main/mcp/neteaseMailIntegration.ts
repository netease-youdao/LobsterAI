import { NeteaseMailAction, NeteaseMailFailure } from '../../shared/neteaseMail/constants';
import type {
  NeteaseMailActionResult, NeteaseMailAvailability, NeteaseMailBridge, NeteaseMailConfirmationRequest,
} from '../../shared/neteaseMail/types';

/**
 * Provider seam for managed OAuth and future sending contracts. The read-only
 * provider leaves confirmation unavailable until a sending contract is integrated.
 */
export type NeteaseMailProvider = NeteaseMailBridge;

export const isNeteaseMailConfirmationRequest = (value: unknown): value is NeteaseMailConfirmationRequest => {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<NeteaseMailConfirmationRequest>;
  return [request.messageId, request.toolCallId].every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 256)
    && (request.action === NeteaseMailAction.Confirm || request.action === NeteaseMailAction.Cancel);
};

/** One user action makes at most one provider call. No retry, queue or mail cache. */
export class NeteaseMailIntegration implements NeteaseMailBridge {
  constructor(private readonly provider?: NeteaseMailProvider) {}

  async getAvailability(): Promise<NeteaseMailAvailability> {
    return this.provider?.getAvailability() ?? { authorization: false, confirmation: false };
  }

  async authorize(): Promise<NeteaseMailActionResult> {
    if (!this.provider) return { success: false, code: NeteaseMailFailure.NotReady };
    return this.provider.authorize();
  }

  async cancelAuthorization(): Promise<NeteaseMailActionResult> {
    return this.provider?.cancelAuthorization?.() ?? { success: false, code: NeteaseMailFailure.NotReady };
  }

  async disconnect(): Promise<NeteaseMailActionResult> {
    return this.provider?.disconnect?.() ?? { success: false, code: NeteaseMailFailure.NotReady };
  }

  async resolveConfirmation(request: NeteaseMailConfirmationRequest): Promise<NeteaseMailActionResult> {
    if (!isNeteaseMailConfirmationRequest(request)) return { success: false, code: NeteaseMailFailure.InvalidRequest };
    if (!this.provider) return { success: false, code: NeteaseMailFailure.NotReady };
    // Only identifiers cross this boundary; never accept a renderer-provided body/token.
    return this.provider.resolveConfirmation({
      messageId: request.messageId, toolCallId: request.toolCallId, action: request.action,
    });
  }
}
