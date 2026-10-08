import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type BrowserCredentialAvailability,
  BrowserCredentialAvailabilityReason,
  BrowserCredentialSaveDecision,
  BrowserCredentialSaveMode,
  type BrowserCredentialSavePrompt,
  type BrowserCredentialSaveRequest,
} from '../../shared/browserCredentials/constants';
import type { BrowserCredentialService } from './browserCredentialService';
import {
  ManualCredentialFormKind,
} from './manualCredentialCaptureProtocol';
import { ManualCredentialCaptureService } from './manualCredentialCaptureService';

describe('ManualCredentialCaptureService', () => {
  let prompts: Array<BrowserCredentialSavePrompt | undefined>;
  let saved: BrowserCredentialSaveRequest[];
  let existingUsernames: string[];
  let saveMode: BrowserCredentialSaveMode;
  let availability: BrowserCredentialAvailability;
  let service: ManualCredentialCaptureService;

  beforeEach(() => {
    vi.useFakeTimers();
    prompts = [];
    saved = [];
    existingUsernames = [];
    saveMode = BrowserCredentialSaveMode.Ask;
    availability = { available: true };
    const credentialService = {
      getAvailability: () => availability,
      list: (origin?: string) => existingUsernames.map((username, index) => ({
        id: String(index),
        origin: origin ?? 'https://example.com',
        username,
        createdAt: 1,
        updatedAt: 1,
      })),
      save: (request: BrowserCredentialSaveRequest) => {
        saved.push(request);
        return {
          id: 'saved-id',
          origin: request.origin,
          username: request.username,
          createdAt: 1,
          updatedAt: 1,
        };
      },
    } as BrowserCredentialService;
    service = new ManualCredentialCaptureService({
      credentialService,
      getSaveMode: () => saveMode,
      onPromptChanged: prompt => prompts.push(prompt),
    });
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  test('offers to save after a same-origin login form disappears', () => {
    service.capture({
      pageId: 1,
      url: 'https://example.com/login',
      username: 'alice',
      password: 'secret-value',
      formKind: ManualCredentialFormKind.Login,
    });
    service.observePageState({
      pageId: 1,
      url: 'https://example.com/account',
      hasPasswordField: false,
    });
    vi.advanceTimersByTime(1_200);

    const prompt = prompts.at(-1);
    expect(prompt).toMatchObject({
      pageId: 1,
      origin: 'https://example.com',
      username: 'alice',
      updatesExisting: false,
    });
    expect(prompt).not.toHaveProperty('password');

    service.resolvePrompt(prompt!.requestId, BrowserCredentialSaveDecision.Save);
    expect(saved).toEqual([{
      origin: 'https://example.com',
      username: 'alice',
      password: 'secret-value',
    }]);
    expect(prompts.at(-1)).toBeUndefined();
  });

  test('does not offer to save when the login form remains visible', () => {
    service.capture({
      pageId: 1,
      url: 'https://example.com/login',
      username: 'alice',
      password: 'wrong-value',
      formKind: ManualCredentialFormKind.Login,
    });
    service.observePageState({
      pageId: 1,
      url: 'https://example.com/login?error=1',
      hasPasswordField: true,
    });
    vi.advanceTimersByTime(30_000);

    expect(prompts).toEqual([]);
    expect(saved).toEqual([]);
  });

  test('offers a first save before OS access has been requested', () => {
    availability = { available: false, reason: BrowserCredentialAvailabilityReason.AccessNotRequested };
    service.capture({
      pageId: 1,
      url: 'https://example.com/login',
      username: 'alice',
      password: 'secret',
      formKind: ManualCredentialFormKind.Login,
    });
    service.observePageState({ pageId: 1, url: 'https://example.com/account', hasPasswordField: false });
    vi.advanceTimersByTime(1_200);
    expect(prompts.at(-1)?.username).toBe('alice');
    expect(saved).toEqual([]);
  });

  test('keeps manual login observation quiet after OS access was denied', () => {
    availability = { available: false, reason: BrowserCredentialAvailabilityReason.EncryptionUnavailable };
    service.capture({
      pageId: 1,
      url: 'https://example.com/login',
      username: 'alice',
      password: 'secret',
      formKind: ManualCredentialFormKind.Login,
    });
    service.observePageState({ pageId: 1, url: 'https://example.com/account', hasPasswordField: false });
    vi.advanceTimersByTime(1_200);
    expect(prompts).toEqual([]);
    expect(saved).toEqual([]);
  });

  test('offers to save registration credentials after redirecting to a login page', () => {
    service.capture({
      pageId: 1,
      url: 'https://example.com/register',
      username: 'new-user',
      password: 'registration-secret',
      formKind: ManualCredentialFormKind.Registration,
    });
    service.observePageState({
      pageId: 1,
      url: 'https://example.com/login',
      hasPasswordField: true,
    });
    vi.advanceTimersByTime(1_200);

    expect(prompts.at(-1)).toMatchObject({
      origin: 'https://example.com',
      username: 'new-user',
    });
  });

  test('marks matching accounts as updates and supports dismissing', () => {
    existingUsernames = ['Alice'];
    service.capture({
      pageId: 2,
      url: 'https://example.com/login',
      username: 'alice',
      password: 'replacement',
      formKind: ManualCredentialFormKind.Login,
    });
    service.observePageState({
      pageId: 2,
      url: 'https://example.com/home',
      hasPasswordField: false,
    });
    vi.advanceTimersByTime(1_200);

    const prompt = prompts.at(-1)!;
    expect(prompt.updatesExisting).toBe(true);
    service.resolvePrompt(prompt.requestId, BrowserCredentialSaveDecision.Dismiss);
    expect(saved).toEqual([]);
    expect(prompts.at(-1)).toBeUndefined();
  });

  test('ignores submissions when save prompts are disabled', () => {
    saveMode = BrowserCredentialSaveMode.Never;
    service.capture({
      pageId: 1,
      url: 'https://example.com/login',
      username: 'alice',
      password: 'secret',
      formKind: ManualCredentialFormKind.Login,
    });
    vi.advanceTimersByTime(30_000);

    expect(prompts).toEqual([]);
  });

  test('keeps the submitted origin across a secure cross-origin sign-in redirect', () => {
    service.capture({
      pageId: 2,
      url: 'https://identity.example.net/login',
      username: 'alice',
      password: 'secret',
      formKind: ManualCredentialFormKind.Login,
    });
    service.observePageState({
      pageId: 2,
      url: 'https://example.com/account',
      hasPasswordField: false,
    });
    vi.advanceTimersByTime(1_200);

    expect(prompts.at(-1)).toMatchObject({
      origin: 'https://identity.example.net',
      username: 'alice',
    });
  });
});
