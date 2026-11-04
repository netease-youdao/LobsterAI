import { describe, expect, test, vi } from 'vitest';

import { NeteaseMailAction, NeteaseMailError, NeteaseMailFailure } from '../../shared/neteaseMail/constants';
import { isNeteaseMailConfirmationRequest, NeteaseMailIntegration, type NeteaseMailProvider } from './neteaseMailIntegration';

describe('NetEase Mail integration boundary', () => {
  test('does not simulate authorization or sending before a provider is installed', async () => {
    const integration = new NeteaseMailIntegration();
    expect(await integration.getAvailability()).toEqual({ authorization: false, confirmation: false });
    expect(await integration.authorize()).toEqual({ success: false, code: NeteaseMailFailure.NotReady });
    expect(await integration.resolveConfirmation({ messageId: 'message', toolCallId: 'call', action: NeteaseMailAction.Confirm }))
      .toEqual({ success: false, code: NeteaseMailFailure.NotReady });
  });

  test('rejects malformed confirmation references', () => {
    for (const request of [null, {}, { messageId: 'm', toolCallId: 't', action: 'send' }, { messageId: '', toolCallId: 't', action: NeteaseMailAction.Confirm }]) {
      expect(isNeteaseMailConfirmationRequest(request)).toBe(false);
    }
  });

  test('returns a quota error after one call and does not forward renderer payloads', async () => {
    const resolveConfirmation = vi.fn(async () => ({ success: false as const, code: NeteaseMailError.RateLimited }));
    const provider: NeteaseMailProvider = {
      getAvailability: async () => ({ authorization: false, confirmation: true }),
      authorize: async () => ({ success: false, code: NeteaseMailFailure.NotReady }),
      resolveConfirmation,
    };
    const integration = new NeteaseMailIntegration(provider);
    const request = { messageId: 'message', toolCallId: 'call', action: NeteaseMailAction.Confirm, body: 'changed by renderer', confirmation_token: 'untrusted' };
    expect(await integration.resolveConfirmation(request)).toEqual({ success: false, code: NeteaseMailError.RateLimited });
    expect(resolveConfirmation).toHaveBeenCalledExactlyOnceWith({ messageId: 'message', toolCallId: 'call', action: NeteaseMailAction.Confirm });
  });
});
