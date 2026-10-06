import crypto from 'crypto';

import {
  BrowserCredentialAvailabilityReason,
  BrowserCredentialSaveDecision,
  BrowserCredentialSaveMode,
  type BrowserCredentialSavePrompt,
  type BrowserCredentialSummary,
} from '../../shared/browserCredentials/constants';
import {
  type BrowserCredentialService,
  normalizeBrowserCredentialOrigin,
} from './browserCredentialService';
import type { ManualCredentialFormKind } from './manualCredentialCaptureProtocol';
import {
  ManualCredentialFormKind as ManualCredentialFormKindValue,
} from './manualCredentialCaptureProtocol';

const MAX_USERNAME_LENGTH = 512;
const MAX_PASSWORD_LENGTH = 8_192;
const CANDIDATE_TTL_MS = 30_000;
const PROMPT_TTL_MS = 120_000;
const SUCCESS_CONFIRMATION_MS = 1_200;

type Timer = ReturnType<typeof setTimeout>;

interface PendingCredential {
  requestId: string;
  pageId: number;
  origin: string;
  submittedUrl: string;
  username: string;
  password: string;
  formKind: ManualCredentialFormKind;
  expiresTimer: Timer;
  successTimer?: Timer;
}

interface ActivePrompt {
  prompt: BrowserCredentialSavePrompt;
  password: string;
  expiresTimer: Timer;
}

export interface ManualCredentialSubmission {
  pageId: number;
  url: string;
  username: string;
  password: string;
  formKind: ManualCredentialFormKind;
}

export interface ManualCredentialPageState {
  pageId: number;
  url: string;
  hasPasswordField: boolean;
}

export interface ManualCredentialCaptureServiceDeps {
  credentialService: BrowserCredentialService;
  getSaveMode: () => BrowserCredentialSaveMode;
  onPromptChanged: (prompt: BrowserCredentialSavePrompt | undefined) => void;
}

const armTimer = (callback: () => void, timeoutMs: number): Timer => {
  const timer = setTimeout(callback, timeoutMs);
  timer.unref?.();
  return timer;
};

const normalizedPageUrl = (value: string): string => {
  const parsed = new URL(value);
  normalizeBrowserCredentialOrigin(parsed.origin);
  return parsed.href;
};

export class ManualCredentialCaptureService {
  private readonly pendingByPage = new Map<number, PendingCredential>();
  private activePrompt: ActivePrompt | undefined;

  constructor(private readonly deps: ManualCredentialCaptureServiceDeps) {}

  capture(submission: ManualCredentialSubmission): void {
    if (!this.canCapture()) {
      this.clearPage(submission.pageId);
      return;
    }

    const username = submission.username.trim();
    if (
      !Number.isSafeInteger(submission.pageId)
      || submission.pageId <= 0
      || !username
      || username.length > MAX_USERNAME_LENGTH
      || !submission.password
      || submission.password.length > MAX_PASSWORD_LENGTH
      || !Object.values(ManualCredentialFormKindValue).includes(submission.formKind)
    ) {
      return;
    }

    let submittedUrl: string;
    let origin: string;
    try {
      submittedUrl = normalizedPageUrl(submission.url);
      origin = normalizeBrowserCredentialOrigin(submittedUrl);
    } catch {
      return;
    }

    this.clearPage(submission.pageId);
    const requestId = crypto.randomUUID();
    const pending: PendingCredential = {
      requestId,
      pageId: submission.pageId,
      origin,
      submittedUrl,
      username,
      password: submission.password,
      formKind: submission.formKind,
      expiresTimer: armTimer(() => this.clearPending(requestId), CANDIDATE_TTL_MS),
    };
    this.pendingByPage.set(submission.pageId, pending);
  }

  observePageState(state: ManualCredentialPageState): void {
    const pending = this.pendingByPage.get(state.pageId);
    if (!pending) return;

    let currentUrl: string;
    try {
      currentUrl = normalizedPageUrl(state.url);
    } catch {
      this.clearPage(state.pageId);
      return;
    }

    const registrationRedirected = pending.formKind === ManualCredentialFormKindValue.Registration
      && currentUrl !== pending.submittedUrl;
    const looksSuccessful = !state.hasPasswordField || registrationRedirected;
    if (!looksSuccessful) {
      if (pending.successTimer) clearTimeout(pending.successTimer);
      pending.successTimer = undefined;
      return;
    }
    if (pending.successTimer) return;
    pending.successTimer = armTimer(
      () => this.promotePending(pending.requestId),
      SUCCESS_CONFIRMATION_MS,
    );
  }

  resolvePrompt(
    requestId: string,
    decision: BrowserCredentialSaveDecision,
  ): BrowserCredentialSummary | undefined {
    const active = this.activePrompt;
    if (!active || active.prompt.requestId !== requestId.trim()) {
      throw new Error('The browser credential save prompt is no longer available.');
    }
    if (!Object.values(BrowserCredentialSaveDecision).includes(decision)) {
      throw new Error('A valid browser credential save decision is required.');
    }

    if (decision === BrowserCredentialSaveDecision.Dismiss) {
      this.clearActivePrompt();
      return undefined;
    }

    try {
      return this.deps.credentialService.save({
        origin: active.prompt.origin,
        username: active.prompt.username,
        password: active.password,
      });
    } finally {
      this.clearActivePrompt();
    }
  }

  clearPage(pageId: number): void {
    const pending = this.pendingByPage.get(pageId);
    if (pending) this.clearPending(pending.requestId);
    if (this.activePrompt?.prompt.pageId === pageId) this.clearActivePrompt();
  }

  refreshConfig(): void {
    if (this.canCapture()) return;
    this.dispose();
  }

  dispose(): void {
    for (const pending of this.pendingByPage.values()) this.disposePending(pending);
    this.pendingByPage.clear();
    this.clearActivePrompt();
  }

  private canCapture(): boolean {
    if (this.deps.getSaveMode() !== BrowserCredentialSaveMode.Ask) return false;
    const availability = this.deps.credentialService.getAvailability();
    // A first save can request OS access after the user accepts the save prompt.
    return availability.available
      || availability.reason === BrowserCredentialAvailabilityReason.AccessNotRequested;
  }

  private promotePending(requestId: string): void {
    const pending = Array.from(this.pendingByPage.values())
      .find(candidate => candidate.requestId === requestId);
    if (!pending) return;
    this.pendingByPage.delete(pending.pageId);
    this.disposePending(pending, false);
    if (!this.canCapture()) {
      pending.password = '';
      return;
    }

    this.clearActivePrompt();
    const updatesExisting = this.deps.credentialService.list(pending.origin)
      .some(credential => credential.username.localeCompare(
        pending.username,
        undefined,
        { sensitivity: 'accent' },
      ) === 0);
    const prompt: BrowserCredentialSavePrompt = {
      requestId: pending.requestId,
      pageId: pending.pageId,
      origin: pending.origin,
      username: pending.username,
      updatesExisting,
    };
    this.activePrompt = {
      prompt,
      password: pending.password,
      expiresTimer: armTimer(() => this.clearActivePrompt(), PROMPT_TTL_MS),
    };
    pending.password = '';
    this.deps.onPromptChanged(prompt);
  }

  private clearPending(requestId: string): void {
    const pending = Array.from(this.pendingByPage.values())
      .find(candidate => candidate.requestId === requestId);
    if (!pending) return;
    this.pendingByPage.delete(pending.pageId);
    this.disposePending(pending);
  }

  private disposePending(pending: PendingCredential, clearPassword = true): void {
    clearTimeout(pending.expiresTimer);
    if (pending.successTimer) clearTimeout(pending.successTimer);
    if (clearPassword) pending.password = '';
  }

  private clearActivePrompt(): void {
    if (!this.activePrompt) return;
    clearTimeout(this.activePrompt.expiresTimer);
    this.activePrompt.password = '';
    this.activePrompt = undefined;
    this.deps.onPromptChanged(undefined);
  }
}
