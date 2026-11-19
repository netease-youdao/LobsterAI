import crypto from 'crypto';
import {
  ipcMain,
  type Session,
  type WebContents,
  WebContentsView,
} from 'electron';
import fs from 'fs';
import path from 'path';

import {
  BrowserCredentialLoginOutcome,
  type BrowserCredentialLoginResult,
  type BrowserCredentialLoginState,
  BrowserCredentialLoginStatus,
  BrowserCredentialTimeout,
  type BrowserCredentialUseMode,
} from '../../shared/browserCredentials/constants';
import type { BrowserCredentialApprovalService } from './browserCredentialApprovalService';
import {
  type BrowserCredentialSecret,
  type BrowserCredentialService,
  normalizeBrowserCredentialOrigin,
} from './browserCredentialService';
import {
  BrowserCredentialGuestChannel,
  type BrowserCredentialGuestCommand,
  BrowserCredentialGuestCommandType,
  type BrowserCredentialGuestResult,
  BrowserCredentialGuestResultKind,
} from './credentialLoginProtocol';

const FORM_DISCOVERY_TIMEOUT_MS = 8_000;
const LOGIN_TRANSITION_TIMEOUT_MS = 12_000;
const GUEST_COMMAND_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 500;

export interface AgentBrowserCredentialLoginRequest {
  signal?: AbortSignal;
  url: string;
  sessionId?: string;
  accountHint?: string;
  reason?: string;
}

export interface AgentBrowserCredentialLoginDeps {
  browserSession: Session;
  credentialService: BrowserCredentialService;
  approvalService: BrowserCredentialApprovalService;
  getUseMode: () => BrowserCredentialUseMode;
  resolveSessionKey: (sessionId?: string) => string | undefined;
  onViewChanged: (view: WebContentsView | null) => void;
  onStateChanged: (state: BrowserCredentialLoginState | undefined) => void;
  preloadPath?: string;
}

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, milliseconds);
});

const abortable = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = (): void => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
});

const readOrigin = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

const resolveCredentialPreloadPath = (): string => {
  const candidates = [
    path.join(__dirname, '..', 'agentBrowserCredentialPreload.js'),
    path.join(__dirname, 'agentBrowserCredentialPreload.js'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[1];
};

const outcomeMessage = (outcome: BrowserCredentialLoginOutcome): string => {
  switch (outcome) {
    case BrowserCredentialLoginOutcome.Authenticated:
      return 'The saved credential was submitted and the shared browser session appears to be signed in.';
    case BrowserCredentialLoginOutcome.Submitted:
      return 'The saved credential was submitted. Inspect the page to confirm whether sign-in completed.';
    case BrowserCredentialLoginOutcome.NeedsMfa:
      return 'The website requires a verification code or another authentication factor before sign-in can continue.';
    case BrowserCredentialLoginOutcome.NeedsCaptcha:
      return 'The website requires a CAPTCHA before sign-in can continue.';
    case BrowserCredentialLoginOutcome.Denied:
      return 'The user did not allow the Agent to use a saved credential.';
    case BrowserCredentialLoginOutcome.Failed:
      return 'LobsterAI could not complete the saved-credential sign-in.';
  }
};

export class AgentBrowserCredentialLogin {
  private secureView: WebContentsView | null = null;
  private active = false;
  private activeController: AbortController | null = null;
  private crossOriginNavigationBlocked = false;

  constructor(private readonly deps: AgentBrowserCredentialLoginDeps) {}

  get isActive(): boolean {
    return this.active;
  }

  async login(request: AgentBrowserCredentialLoginRequest): Promise<BrowserCredentialLoginResult> {
    if (this.active) {
      return this.failedResult(request.url, 'Another saved-credential sign-in is already in progress.');
    }
    if (request.signal?.aborted) return this.failedResult(request.url, 'Saved-credential sign-in was cancelled.');

    let origin: string;
    try {
      origin = normalizeBrowserCredentialOrigin(request.url);
    } catch (error) {
      return this.failedResult(
        request.url,
        error instanceof Error ? error.message : 'The current page cannot use saved credentials.',
      );
    }

    if (!this.deps.credentialService.getAvailability().available) {
      return this.failedResult(origin, 'Secure browser credential storage is unavailable on this device.');
    }

    const candidates = this.deps.credentialService.list(origin);
    if (candidates.length === 0) {
      return this.failedResult(origin, 'No saved credential matches the current website.');
    }

    this.active = true;
    const startedAt = Date.now();
    const diagnostic = { sessionId: request.sessionId };
    console.debug('[BrowserCredentialLogin] Awaiting approval', diagnostic);
    const controller = new AbortController();
    this.activeController = controller;
    const cancel = (): void => controller.abort(new Error('Saved-credential sign-in was cancelled.'));
    const destroyView = (): void => {
      const view = this.secureView;
      this.secureView = null;
      try {
        this.deps.onViewChanged(null);
      } catch {
        console.warn('[BrowserCredentialLogin] Failed to detach cancelled login view', diagnostic);
      }
      this.closeView(view);
    };
    request.signal?.addEventListener('abort', cancel, { once: true });
    controller.signal.addEventListener('abort', destroyView, { once: true });
    let executionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.setState({ status: BrowserCredentialLoginStatus.AwaitingApproval, origin });
      const approval = await this.deps.approvalService.requestApproval({
        signal: controller.signal,
        sessionId: request.sessionId,
        sessionKey: this.deps.resolveSessionKey(request.sessionId),
        origin,
        candidates,
        accountHint: request.accountHint,
        reason: request.reason,
        useMode: this.deps.getUseMode(),
      });
      controller.signal.throwIfAborted();
      if (!approval.approved || !approval.credential) {
        console.debug('[BrowserCredentialLogin] Approval not granted', { ...diagnostic, elapsedMs: Date.now() - startedAt });
        return this.finishResult(BrowserCredentialLoginOutcome.Denied, origin);
      }

      console.debug('[BrowserCredentialLogin] Approval granted; starting login', { ...diagnostic, approvalMs: Date.now() - startedAt });
      executionTimer = setTimeout(() => {
        console.warn('[BrowserCredentialLogin] Execution deadline reached', diagnostic);
        controller.abort(new Error('Saved-credential sign-in execution timed out.'));
      }, BrowserCredentialTimeout.Execution);
      const secret = this.deps.credentialService.getSecret(approval.credential.id, origin);
      this.setState({
        status: BrowserCredentialLoginStatus.SigningIn,
        origin,
        username: secret.summary.username,
      });
      const outcome = await abortable(this.runSecureLogin(request.url, origin, secret, controller.signal), controller.signal);
      controller.signal.throwIfAborted();
      if (
        outcome === BrowserCredentialLoginOutcome.Authenticated
        || outcome === BrowserCredentialLoginOutcome.Submitted
        || outcome === BrowserCredentialLoginOutcome.NeedsMfa
      ) {
        this.deps.credentialService.markUsed(secret.summary.id);
        this.deps.browserSession.flushStorageData();
        await abortable(this.deps.browserSession.cookies.flushStore(), controller.signal);
      }
      console.debug('[BrowserCredentialLogin] Login finished', { ...diagnostic, outcome, elapsedMs: Date.now() - startedAt });
      return this.finishResult(outcome, origin, secret.summary.username);
    } catch (error) {
      // Page/navigation errors can include URLs; do not log their payloads or credentials.
      console.warn('[BrowserCredentialLogin] Login interrupted', { ...diagnostic, aborted: controller.signal.aborted, elapsedMs: Date.now() - startedAt });
      return this.failedResult(
        origin,
        error instanceof Error ? error.message : 'Saved-credential sign-in failed.',
      );
    } finally {
      clearTimeout(executionTimer);
      try {
        await this.closeSecureView();
      } finally {
        request.signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', destroyView);
        this.activeController = null;
        this.active = false;
      }
    }
  }

  async dispose(): Promise<void> {
    this.activeController?.abort(new Error('Saved-credential sign-in was cancelled.'));
    await this.closeSecureView();
  }

  private async runSecureLogin(
    url: string,
    expectedOrigin: string,
    secret: BrowserCredentialSecret,
    signal: AbortSignal,
  ): Promise<BrowserCredentialLoginOutcome> {
    signal.throwIfAborted();
    const view = this.createSecureView(expectedOrigin);
    this.secureView = view;
    this.deps.onViewChanged(view);
    await view.webContents.loadURL(url);
    signal.throwIfAborted();
    this.assertNoCrossOriginNavigation();

    let inspection = await this.waitForLoginForm(view.webContents, signal);
    signal.throwIfAborted();
    this.assertNoCrossOriginNavigation();
    if (inspection.kind === BrowserCredentialGuestResultKind.Captcha) {
      return BrowserCredentialLoginOutcome.NeedsCaptcha;
    }
    if (inspection.kind === BrowserCredentialGuestResultKind.MfaForm) {
      return BrowserCredentialLoginOutcome.NeedsMfa;
    }
    if (
      inspection.kind !== BrowserCredentialGuestResultKind.PasswordForm
      && inspection.kind !== BrowserCredentialGuestResultKind.UsernameForm
    ) {
      throw new Error('No supported username or password form was found on the current page.');
    }

    let submission = await this.sendGuestCommand(view.webContents, {
      requestId: crypto.randomUUID(),
      type: BrowserCredentialGuestCommandType.FillAndSubmit,
      username: secret.summary.username,
      password: secret.password,
    }, signal);

    if (submission.kind === BrowserCredentialGuestResultKind.SubmittedUsername) {
      inspection = await this.waitForLoginForm(
        view.webContents,
        signal,
        LOGIN_TRANSITION_TIMEOUT_MS,
        BrowserCredentialGuestResultKind.UsernameForm,
      );
      signal.throwIfAborted();
      this.assertNoCrossOriginNavigation();
      if (inspection.kind === BrowserCredentialGuestResultKind.Captcha) {
        return BrowserCredentialLoginOutcome.NeedsCaptcha;
      }
      if (inspection.kind === BrowserCredentialGuestResultKind.MfaForm) {
        return BrowserCredentialLoginOutcome.NeedsMfa;
      }
      if (inspection.kind !== BrowserCredentialGuestResultKind.PasswordForm) {
        return inspection.kind === BrowserCredentialGuestResultKind.NoLoginForm
          ? BrowserCredentialLoginOutcome.Submitted
          : BrowserCredentialLoginOutcome.Failed;
      }
      submission = await this.sendGuestCommand(view.webContents, {
        requestId: crypto.randomUUID(),
        type: BrowserCredentialGuestCommandType.FillAndSubmit,
        username: secret.summary.username,
        password: secret.password,
      }, signal);
    }

    if (submission.kind === BrowserCredentialGuestResultKind.Captcha) {
      return BrowserCredentialLoginOutcome.NeedsCaptcha;
    }
    if (submission.kind === BrowserCredentialGuestResultKind.MfaForm) {
      return BrowserCredentialLoginOutcome.NeedsMfa;
    }
    if (submission.kind !== BrowserCredentialGuestResultKind.SubmittedPassword) {
      throw new Error(submission.message || 'The login form could not be submitted.');
    }

    const deadline = Date.now() + LOGIN_TRANSITION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS);
      signal.throwIfAborted();
      this.assertNoCrossOriginNavigation();
      const currentOrigin = readOrigin(view.webContents.getURL());
      if (currentOrigin && currentOrigin !== expectedOrigin) {
        throw new Error('Cross-origin sign-in redirects are not supported yet.');
      }
      const current = await this.sendGuestCommand(view.webContents, {
        requestId: crypto.randomUUID(),
        type: BrowserCredentialGuestCommandType.Inspect,
      }, signal).catch((): null => null);
      if (!current) continue;
      if (current.kind === BrowserCredentialGuestResultKind.Captcha) {
        return BrowserCredentialLoginOutcome.NeedsCaptcha;
      }
      if (current.kind === BrowserCredentialGuestResultKind.MfaForm) {
        return BrowserCredentialLoginOutcome.NeedsMfa;
      }
      if (current.kind === BrowserCredentialGuestResultKind.NoLoginForm) {
        return BrowserCredentialLoginOutcome.Authenticated;
      }
    }
    return BrowserCredentialLoginOutcome.Submitted;
  }

  private createSecureView(expectedOrigin: string): WebContentsView {
    this.crossOriginNavigationBlocked = false;
    const view = new WebContentsView({
      webPreferences: {
        session: this.deps.browserSession,
        preload: this.deps.preloadPath ?? resolveCredentialPreloadPath(),
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        plugins: false,
        devTools: false,
        spellcheck: false,
        navigateOnDragDrop: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const blockCrossOrigin = (event: Electron.Event, targetUrl: string): void => {
      const targetOrigin = readOrigin(targetUrl);
      if (targetOrigin && targetOrigin !== expectedOrigin) {
        this.crossOriginNavigationBlocked = true;
        event.preventDefault();
      }
    };
    view.webContents.on('will-navigate', blockCrossOrigin);
    view.webContents.on('will-redirect', blockCrossOrigin);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return view;
  }

  private async waitForLoginForm(
    webContents: WebContents,
    signal: AbortSignal,
    timeoutMs = FORM_DISCOVERY_TIMEOUT_MS,
    ignoredKind?: BrowserCredentialGuestResultKind,
  ): Promise<BrowserCredentialGuestResult> {
    const deadline = Date.now() + timeoutMs;
    let lastResult: BrowserCredentialGuestResult | null = null;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (webContents.isLoading()) {
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      lastResult = await this.sendGuestCommand(webContents, {
        requestId: crypto.randomUUID(),
        type: BrowserCredentialGuestCommandType.Inspect,
      }, signal).catch((): null => null);
      if (
        lastResult
        && lastResult.kind !== BrowserCredentialGuestResultKind.NoLoginForm
        && lastResult.kind !== ignoredKind
      ) {
        return lastResult;
      }
      await delay(POLL_INTERVAL_MS);
    }
    return lastResult ?? {
      requestId: crypto.randomUUID(),
      kind: BrowserCredentialGuestResultKind.NoLoginForm,
      url: webContents.getURL(),
    };
  }

  private sendGuestCommand(
    webContents: WebContents,
    command: BrowserCredentialGuestCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCredentialGuestResult> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('The secure login page did not respond.'));
      }, command.type === BrowserCredentialGuestCommandType.ClearPasswordFields ? BrowserCredentialTimeout.Cleanup : GUEST_COMMAND_TIMEOUT_MS);
      const abort = (): void => { cleanup(); reject(signal?.reason); };
      const handler = (
        event: Electron.IpcMainEvent,
        result: BrowserCredentialGuestResult,
      ): void => {
        if (event.sender.id !== webContents.id || result?.requestId !== command.requestId) return;
        cleanup();
        resolve(result);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        ipcMain.removeListener(BrowserCredentialGuestChannel.Result, handler);
        signal?.removeEventListener('abort', abort);
      };
      signal?.addEventListener('abort', abort, { once: true });
      ipcMain.on(BrowserCredentialGuestChannel.Result, handler);
      try { webContents.send(BrowserCredentialGuestChannel.Command, command); }
      catch (error) { cleanup(); reject(error); }
    });
  }

  private async closeSecureView(): Promise<void> {
    const view = this.secureView;
    if (!view) return;
    this.secureView = null;
    try {
      this.deps.onViewChanged(null);
      if (view.webContents.isDestroyed()) return;
      await this.sendGuestCommand(view.webContents, {
        requestId: crypto.randomUUID(),
        type: BrowserCredentialGuestCommandType.ClearPasswordFields,
      });
    } catch {
      // Navigation or shutdown can make the isolated preload unavailable.
      console.debug('[BrowserCredentialLogin] Clearing the login view was unavailable');
    } finally {
      this.closeView(view);
    }
  }

  private closeView(view: WebContentsView | null): void {
    try {
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    } catch {
      // Electron may tear down the WebContents between the check and close on quit.
      console.warn('[BrowserCredentialLogin] Login view close failed during teardown');
    }
  }

  private assertNoCrossOriginNavigation(): void {
    if (this.crossOriginNavigationBlocked) {
      throw new Error('Cross-origin sign-in redirects are not supported yet.');
    }
  }

  private finishResult(
    outcome: BrowserCredentialLoginOutcome,
    origin: string,
    username?: string,
  ): BrowserCredentialLoginResult {
    const statusByOutcome: Record<BrowserCredentialLoginOutcome, BrowserCredentialLoginStatus> = {
      [BrowserCredentialLoginOutcome.Authenticated]: BrowserCredentialLoginStatus.Authenticated,
      [BrowserCredentialLoginOutcome.Submitted]: BrowserCredentialLoginStatus.Submitted,
      [BrowserCredentialLoginOutcome.NeedsMfa]: BrowserCredentialLoginStatus.NeedsMfa,
      [BrowserCredentialLoginOutcome.NeedsCaptcha]: BrowserCredentialLoginStatus.NeedsCaptcha,
      [BrowserCredentialLoginOutcome.Denied]: BrowserCredentialLoginStatus.Denied,
      [BrowserCredentialLoginOutcome.Failed]: BrowserCredentialLoginStatus.Failed,
    };
    const message = outcomeMessage(outcome);
    this.setState({ status: statusByOutcome[outcome], origin, username, message });
    return { outcome, origin, username, message };
  }

  private failedResult(urlOrOrigin: string, message: string): BrowserCredentialLoginResult {
    const origin = readOrigin(urlOrOrigin) ?? urlOrOrigin;
    this.setState({ status: BrowserCredentialLoginStatus.Failed, origin, message });
    return {
      outcome: BrowserCredentialLoginOutcome.Failed,
      origin,
      message,
    };
  }

  private setState(state: BrowserCredentialLoginState): void {
    this.deps.onStateChanged(state);
  }
}
