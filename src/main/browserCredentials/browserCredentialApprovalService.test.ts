import { describe, expect, test, vi } from 'vitest';

import {
  type BrowserCredentialSummary,
  BrowserCredentialUseMode,
} from '../../shared/browserCredentials/constants';
import { BrowserCredentialApprovalService } from './browserCredentialApprovalService';

const credential = (id: string, username: string): BrowserCredentialSummary => ({
  id,
  origin: 'https://example.com',
  username,
  createdAt: 1,
  updatedAt: 1,
});

const translations: Record<string, string> = {
  browserCredentialApprovalQuestion: 'Allow login?',
  browserCredentialApprovalHeader: 'Saved login',
  browserCredentialApprovalTitle: 'Allow Agent login',
  browserCredentialApprovalSubtitle: 'The password remains hidden.',
  browserCredentialApprovalReason: 'Reason',
  browserCredentialApprovalAllow: 'Allow',
  browserCredentialApprovalAllowDescription: 'Continue',
  browserCredentialApprovalDeny: 'Deny',
  browserCredentialApprovalDenyDescription: 'Stop',
  browserCredentialSelectionQuestion: 'Select account',
  browserCredentialSelectionTitle: 'Select account',
  browserCredentialSelectionSubtitle: 'Choose one',
  browserCredentialSelectionDescription: 'Use this account',
};

describe('BrowserCredentialApprovalService', () => {
  test('remembers an approved credential for the same task only', async () => {
    const askUser = vi.fn(async (questions) => ({
      behavior: 'allow' as const,
      answers: { [questions[0].question]: 'Allow' },
    }));
    const service = new BrowserCredentialApprovalService({
      askUser,
      translate: key => translations[key] ?? key,
    });
    const request = {
      sessionId: 'task-1',
      origin: 'https://example.com',
      candidates: [credential('one', 'alice')],
      useMode: BrowserCredentialUseMode.OncePerTask,
    };

    expect((await service.requestApproval(request)).approved).toBe(true);
    expect((await service.requestApproval(request)).approved).toBe(true);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect((await service.requestApproval({ ...request, sessionId: 'task-2' })).approved).toBe(true);
    expect(askUser).toHaveBeenCalledTimes(2);
  });

  test('selects an account without exposing a password', async () => {
    const askUser = vi.fn(async (questions) => ({
      behavior: 'allow' as const,
      answers: { [questions[0].question]: 'bob' },
    }));
    const service = new BrowserCredentialApprovalService({
      askUser,
      translate: key => translations[key] ?? key,
    });
    const result = await service.requestApproval({
      sessionId: 'task-1',
      origin: 'https://example.com',
      candidates: [credential('one', 'alice'), credential('two', 'bob')],
      useMode: BrowserCredentialUseMode.AlwaysAsk,
    });

    expect(result.credential?.id).toBe('two');
    expect(JSON.stringify(askUser.mock.calls)).not.toContain('password');
  });

  test('asks again when no task identifier is available', async () => {
    const askUser = vi.fn(async (questions) => ({
      behavior: 'allow' as const,
      answers: { [questions[0].question]: 'Allow' },
    }));
    const service = new BrowserCredentialApprovalService({
      askUser,
      translate: key => translations[key] ?? key,
    });
    const request = {
      origin: 'https://example.com',
      candidates: [credential('one', 'alice')],
      useMode: BrowserCredentialUseMode.OncePerTask,
    };

    expect((await service.requestApproval(request)).approved).toBe(true);
    expect((await service.requestApproval(request)).approved).toBe(true);
    expect(askUser).toHaveBeenCalledTimes(2);
  });

  test('does not ask when saved login use is disabled', async () => {
    const askUser = vi.fn();
    const service = new BrowserCredentialApprovalService({
      askUser,
      translate: key => translations[key] ?? key,
    });
    const result = await service.requestApproval({
      origin: 'https://example.com',
      candidates: [credential('one', 'alice')],
      useMode: BrowserCredentialUseMode.Disabled,
    });
    expect(result).toEqual({ approved: false });
    expect(askUser).not.toHaveBeenCalled();
  });
});
