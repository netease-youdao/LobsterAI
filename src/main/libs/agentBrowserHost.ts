import {
  type BrowserWindow,
  type Session,
  session,
  WebContentsView,
} from 'electron';
import fs from 'fs';
import path from 'path';

import {
  BrowserCredentialLoginOutcome,
  type BrowserCredentialLoginState,
  BrowserCredentialLoginTool,
  type BrowserCredentialSaveDecision,
  type BrowserCredentialSavePrompt,
} from '../../shared/browserCredentials/constants';
import {
  type AgentBrowserHostState,
  type AgentBrowserHostStateEvent,
  AgentBrowserPartition,
  type AgentBrowserToolEvent,
  BrowserDisplayMode,
  type BrowserWebAccessConfig,
  normalizeBrowserHostnamePolicyList,
  normalizeBrowserWebAccessConfig,
} from '../../shared/browserWebAccess/constants';
import {
  AgentBrowserCredentialLogin,
} from '../browserCredentials/agentBrowserCredentialLogin';
import type { BrowserCredentialApprovalService } from '../browserCredentials/browserCredentialApprovalService';
import type { BrowserCredentialService } from '../browserCredentials/browserCredentialService';
import {
  ManualCredentialCaptureChannel,
  ManualCredentialCaptureEventType,
  parseManualCredentialCaptureEvent,
} from '../browserCredentials/manualCredentialCaptureProtocol';
import {
  ManualCredentialCaptureService,
} from '../browserCredentials/manualCredentialCaptureService';
import type {
  BrowserToolRequest,
  BrowserToolResponse,
} from './mcpBridgeServer';

const BrowserMcpTool = {
  ListPages: 'list_pages',
  NewPage: 'new_page',
  SelectPage: 'select_page',
  ClosePage: 'close_page',
  NavigatePage: 'navigate_page',
  TakeSnapshot: 'take_snapshot',
  TakeScreenshot: 'take_screenshot',
  Click: 'click',
  Fill: 'fill',
  FillForm: 'fill_form',
  Hover: 'hover',
  Drag: 'drag',
  UploadFile: 'upload_file',
  PressKey: 'press_key',
  ResizePage: 'resize_page',
  HandleDialog: 'handle_dialog',
  EvaluateScript: 'evaluate_script',
  WaitFor: 'wait_for',
  LoginWithSavedCredential: BrowserCredentialLoginTool.Name,
} as const;

const DEFAULT_PAGE_URL = 'about:blank';
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_OPERATION_TIMEOUT_MS = 60_000;
const MAX_SNAPSHOT_NODES = 2_000;

type AxValue = {
  value?: unknown;
};

type AxNode = {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
};

type SnapshotNode = {
  id?: string;
  role?: string;
  name?: string;
  value?: string | number | boolean;
  description?: string;
  children?: SnapshotNode[];
};

type BrowserPage = {
  pageId: number;
  view: WebContentsView;
  loading: boolean;
  refs: Map<string, number>;
};

type AgentBrowserHostDeps = {
  getMainWindow: () => BrowserWindow | null;
  getBrowserConfig: () => Partial<BrowserWebAccessConfig> | null | undefined;
  useSystemProxy: () => boolean;
  emitState: (event: AgentBrowserHostStateEvent) => void;
  credentialService: BrowserCredentialService;
  credentialApprovalService: BrowserCredentialApprovalService;
  resolveSessionKey: (sessionId?: string) => string | undefined;
  manualCredentialPreloadPath?: string;
};

const textResult = (
  text: string,
  structuredContent?: Record<string, unknown>,
): BrowserToolResponse => ({
  content: [{ type: 'text', text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const errorResult = (message: string): BrowserToolResponse => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

const readString = (value: unknown): string => typeof value === 'string' ? value : '';

const readPageId = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
);

const readTimeout = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_OPERATION_TIMEOUT_MS;
  }
  return Math.min(Math.round(value), MAX_OPERATION_TIMEOUT_MS);
};

const resolveManualCredentialPreloadPath = (): string => {
  const candidates = [
    path.join(__dirname, '..', 'manualCredentialCapturePreload.js'),
    path.join(__dirname, 'manualCredentialCapturePreload.js'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[1];
};

const normalizeAddress = (rawValue: string): string => {
  const value = rawValue.trim();
  if (!value) return DEFAULT_PAGE_URL;
  if (/^(?:https?:\/\/|about:blank$)/i.test(value)) return value;
  if (
    /^(?:localhost(?::\d+)?|[\w-]+:\d+|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?|[\w-]+(?:\.[\w-]+)+(?::\d+)?)(?:[/?#]|$)/i.test(value)
    && !/\s/.test(value)
  ) {
    return `https://${value}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
};

const isBlockedHostname = (url: string, config: BrowserWebAccessConfig): boolean => {
  if (url === DEFAULT_PAGE_URL) return false;
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return true;
  }

  return normalizeBrowserHostnamePolicyList(config.blockedHostnames).some(entry => {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return hostname === entry;
  });
};

const toSnapshotScalar = (value: unknown): string | number | boolean | undefined => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
};

const resolveKeyInput = (rawKey: string): { keyCode: string; modifiers: string[] } => {
  const parts = rawKey.split('+').map(part => part.trim()).filter(Boolean);
  const keyPart = parts.pop() || rawKey;
  const modifiers = parts.map(part => {
    switch (part.toUpperCase()) {
      case 'CTRL':
      case 'CONTROL':
        return 'control';
      case 'CMD':
      case 'COMMAND':
      case 'META':
        return 'meta';
      case 'ALT':
      case 'OPTION':
        return 'alt';
      case 'SHIFT':
        return 'shift';
      default:
        return part.toLowerCase();
    }
  });
  const normalizedKey = keyPart.toUpperCase().replace(/[_\s-]+/g, '');
  const keyCodeByName: Record<string, string> = {
    ENTER: 'Enter',
    RETURN: 'Enter',
    TAB: 'Tab',
    ESC: 'Escape',
    ESCAPE: 'Escape',
    BACKSPACE: 'Backspace',
    DELETE: 'Delete',
    SPACE: 'Space',
    ARROWUP: 'Up',
    ARROWDOWN: 'Down',
    ARROWLEFT: 'Left',
    ARROWRIGHT: 'Right',
    HOME: 'Home',
    END: 'End',
    PAGEUP: 'PageUp',
    PAGEDOWN: 'PageDown',
  };
  return {
    keyCode: keyCodeByName[normalizedKey] ?? keyPart,
    modifiers,
  };
};

export class AgentBrowserHost {
  private readonly pages = new Map<number, BrowserPage>();
  private readonly browserSession: Session;
  private nextPageId = 1;
  private selectedPageId: number | undefined;
  private attachedPageId: number | undefined;
  private credentialLoginView: WebContentsView | null = null;
  private credentialLoginViewAttached = false;
  private credentialLoginState: BrowserCredentialLoginState | undefined;
  private readonly credentialLogin: AgentBrowserCredentialLogin;
  private credentialSavePrompt: BrowserCredentialSavePrompt | undefined;
  private readonly manualCredentialCapture: ManualCredentialCaptureService;
  private readonly manualCredentialPreloadPath: string;
  private desiredVisible = false;
  private windowVisible = false;
  private bounds = { x: 0, y: 0, width: 1, height: 1 };
  private activeSessionId: string | undefined;
  private lastError: string | undefined;
  private proxyReady: Promise<void> = Promise.resolve();
  private browserToolBootstrapPagePromise: Promise<BrowserPage> | null = null;
  private reusableBrowserToolBootstrapPageId: number | undefined;

  constructor(private readonly deps: AgentBrowserHostDeps) {
    this.windowVisible = Boolean(this.deps.getMainWindow()?.isVisible());
    this.browserSession = session.fromPartition(AgentBrowserPartition.Default, { cache: true });
    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    this.manualCredentialPreloadPath = this.deps.manualCredentialPreloadPath
      ?? resolveManualCredentialPreloadPath();
    this.manualCredentialCapture = new ManualCredentialCaptureService({
      credentialService: this.deps.credentialService,
      getSaveMode: () => normalizeBrowserWebAccessConfig(
        this.deps.getBrowserConfig(),
      ).credentialSaveMode,
      onPromptChanged: prompt => {
        this.credentialSavePrompt = prompt;
        this.emitState();
      },
    });
    this.credentialLogin = new AgentBrowserCredentialLogin({
      browserSession: this.browserSession,
      credentialService: this.deps.credentialService,
      approvalService: this.deps.credentialApprovalService,
      getUseMode: () => normalizeBrowserWebAccessConfig(
        this.deps.getBrowserConfig(),
      ).credentialUseMode,
      resolveSessionKey: this.deps.resolveSessionKey,
      onViewChanged: view => {
        this.setCredentialLoginView(view);
      },
      onStateChanged: state => {
        this.credentialLoginState = state;
        this.emitState();
      },
    });
    this.refreshProxy();
  }

  getState(): AgentBrowserHostState {
    const tabs = Array.from(this.pages.values()).map(page => {
      const webContents = page.view.webContents;
      const navigationHistory = webContents.navigationHistory;
      return {
        pageId: page.pageId,
        title: webContents.getTitle() || webContents.getURL() || 'New tab',
        url: webContents.getURL() || DEFAULT_PAGE_URL,
        selected: page.pageId === this.selectedPageId,
        loading: page.loading,
        canGoBack: navigationHistory.canGoBack(),
        canGoForward: navigationHistory.canGoForward(),
      };
    });
    return {
      tabs,
      ...(this.selectedPageId ? { selectedPageId: this.selectedPageId } : {}),
      visible: this.attachedPageId !== undefined || this.credentialLoginViewAttached,
      updatedAt: Date.now(),
      ...(this.credentialLoginState ? { credentialLogin: this.credentialLoginState } : {}),
      ...(this.credentialSavePrompt ? { credentialSavePrompt: this.credentialSavePrompt } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  setView(options: {
    sessionId?: string;
    visible: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
  }): AgentBrowserHostState {
    if (options.sessionId?.trim()) {
      this.activeSessionId = options.sessionId.trim();
    }
    this.desiredVisible = options.visible;
    if (options.bounds) {
      this.bounds = this.normalizeBounds(options.bounds);
    }
    this.syncAttachment();
    return this.getState();
  }

  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible;
    this.syncAttachment();
  }

  refreshConfig(): void {
    const config = normalizeBrowserWebAccessConfig(this.deps.getBrowserConfig());
    if (config.displayMode !== BrowserDisplayMode.InApp) {
      this.desiredVisible = false;
      this.syncAttachment();
    }
    this.manualCredentialCapture.refreshConfig();
    this.refreshProxy();
  }

  handleToolEvent(event: AgentBrowserToolEvent): void {
    this.activeSessionId = event.sessionId;
    const targetPageId = readPageId(Number(event.targetId));
    if (targetPageId && this.pages.has(targetPageId)) {
      if (this.credentialLogin.isActive) {
        this.selectedPageId = targetPageId;
        this.emitState(event.sessionId);
        return;
      }
      this.selectPage(targetPageId, event.sessionId);
      return;
    }
    this.emitState(event.sessionId);
  }

  async navigate(url: string, sessionId?: string): Promise<AgentBrowserHostState> {
    this.assertCredentialLoginInactive();
    if (sessionId?.trim()) this.activeSessionId = sessionId.trim();
    const page = this.getSelectedPage() ?? await this.createPage(DEFAULT_PAGE_URL);
    this.markBrowserToolBootstrapPageUsed(page.pageId);
    await this.navigatePage(page, normalizeAddress(url), DEFAULT_OPERATION_TIMEOUT_MS);
    return this.getState();
  }

  goBack(): AgentBrowserHostState {
    this.assertCredentialLoginInactive();
    const page = this.requireSelectedPage();
    if (page.view.webContents.navigationHistory.canGoBack()) {
      page.view.webContents.navigationHistory.goBack();
    }
    return this.getState();
  }

  goForward(): AgentBrowserHostState {
    this.assertCredentialLoginInactive();
    const page = this.requireSelectedPage();
    if (page.view.webContents.navigationHistory.canGoForward()) {
      page.view.webContents.navigationHistory.goForward();
    }
    return this.getState();
  }

  reload(): AgentBrowserHostState {
    this.assertCredentialLoginInactive();
    this.requireSelectedPage().view.webContents.reload();
    return this.getState();
  }

  stop(): AgentBrowserHostState {
    this.assertCredentialLoginInactive();
    this.requireSelectedPage().view.webContents.stop();
    return this.getState();
  }

  selectPage(pageId: number, sessionId?: string): AgentBrowserHostState {
    this.assertCredentialLoginInactive();
    if (!this.pages.has(pageId)) {
      throw new Error(`Browser page ${pageId} does not exist.`);
    }
    if (sessionId?.trim()) this.activeSessionId = sessionId.trim();
    this.selectedPageId = pageId;
    this.syncAttachment();
    this.emitState(sessionId);
    return this.getState();
  }

  closePage(pageId: number): AgentBrowserHostState {
    this.assertCredentialLoginInactive();
    const page = this.requirePage(pageId);
    this.markBrowserToolBootstrapPageUsed(pageId);
    this.manualCredentialCapture.clearPage(pageId);
    this.detachPage(pageId);
    if (page.view.webContents.debugger.isAttached()) {
      page.view.webContents.debugger.detach();
    }
    page.view.webContents.close();
    this.pages.delete(pageId);
    if (this.selectedPageId === pageId) {
      this.selectedPageId = this.pages.keys().next().value as number | undefined;
    }
    this.syncAttachment();
    this.emitState();
    return this.getState();
  }

  resolveCredentialSavePrompt(
    requestId: string,
    decision: BrowserCredentialSaveDecision,
  ): AgentBrowserHostState {
    this.manualCredentialCapture.resolvePrompt(requestId, decision);
    this.lastError = undefined;
    this.emitState();
    return this.getState();
  }

  async handleToolRequest(request: BrowserToolRequest): Promise<BrowserToolResponse> {
    const config = normalizeBrowserWebAccessConfig(this.deps.getBrowserConfig());
    if (config.displayMode !== BrowserDisplayMode.InApp) {
      return errorResult('The LobsterAI in-app browser mode is not enabled.');
    }
    if (request.tool === BrowserMcpTool.EvaluateScript && !config.evaluateEnabled) {
      return errorResult('Browser script evaluation is disabled in LobsterAI settings.');
    }
    if (this.credentialLogin.isActive && request.tool !== BrowserMcpTool.LoginWithSavedCredential) {
      return errorResult('A secure saved-credential sign-in is in progress. Wait for it to finish.');
    }

    try {
      return await this.dispatchTool(request.tool, request.args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.emitState();
      return errorResult(message);
    }
  }

  async dispose(): Promise<void> {
    this.desiredVisible = false;
    await this.credentialLogin.dispose();
    this.manualCredentialCapture.dispose();
    this.detachCredentialLoginView();
    this.detachPage(this.attachedPageId);
    for (const page of this.pages.values()) {
      if (page.view.webContents.isDestroyed()) continue;
      if (page.view.webContents.debugger.isAttached()) {
        page.view.webContents.debugger.detach();
      }
      page.view.webContents.close();
    }
    this.pages.clear();
    this.selectedPageId = undefined;

    // The app's graceful cleanup ends with app.exit(), which does not give
    // Chromium its normal shutdown window. Explicitly flush the persistent
    // partition so recently issued login cookies and DOM storage survive an
    // immediate app restart.
    this.browserSession.flushStorageData();
    await this.browserSession.cookies.flushStore();
    console.log('[AgentBrowserHost] Persistent browser storage flushed on quit.');
  }

  private async dispatchTool(tool: string, args: Record<string, unknown>): Promise<BrowserToolResponse> {
    switch (tool) {
      case BrowserMcpTool.ListPages:
        await this.ensureBrowserToolPageBaseline();
        return this.pagesResult();
      case BrowserMcpTool.NewPage: {
        if (this.browserToolBootstrapPagePromise) {
          await this.browserToolBootstrapPagePromise;
        }
        const url = normalizeAddress(readString(args.url) || DEFAULT_PAGE_URL);
        const timeoutMs = readTimeout(args.timeout);
        const bootstrapPage = this.takeReusableBrowserToolBootstrapPage();
        if (bootstrapPage) {
          this.selectedPageId = bootstrapPage.pageId;
          if ((bootstrapPage.view.webContents.getURL() || DEFAULT_PAGE_URL) !== url) {
            await this.navigatePage(bootstrapPage, url, timeoutMs);
          }
          this.syncAttachment();
          this.emitState();
        } else {
          await this.createPage(url, timeoutMs);
        }
        return this.pagesResult();
      }
      case BrowserMcpTool.SelectPage:
        this.selectPage(this.requirePageId(args.pageId));
        return this.pagesResult();
      case BrowserMcpTool.ClosePage:
        this.closePage(this.requirePageId(args.pageId));
        return this.pagesResult();
      case BrowserMcpTool.NavigatePage: {
        const page = this.requirePage(this.requirePageId(args.pageId));
        this.markBrowserToolBootstrapPageUsed(page.pageId);
        await this.navigatePage(page, normalizeAddress(readString(args.url)), readTimeout(args.timeout));
        return textResult('Page navigated.', { message: 'Page navigated.' });
      }
      case BrowserMcpTool.TakeSnapshot:
        return this.takeSnapshot(this.resolvePage(args.pageId));
      case BrowserMcpTool.TakeScreenshot:
        return this.takeScreenshot(this.resolvePage(args.pageId), args);
      case BrowserMcpTool.Click:
        await this.click(this.resolvePage(args.pageId), readString(args.uid), args.dblClick === true);
        return textResult('Element clicked.');
      case BrowserMcpTool.Fill:
        await this.fill(this.resolvePage(args.pageId), readString(args.uid), readString(args.value));
        return textResult('Element filled.');
      case BrowserMcpTool.FillForm:
        await this.fillForm(this.resolvePage(args.pageId), args.elements);
        return textResult('Form filled.');
      case BrowserMcpTool.Hover:
        await this.hover(this.resolvePage(args.pageId), readString(args.uid));
        return textResult('Element hovered.');
      case BrowserMcpTool.Drag:
        await this.drag(
          this.resolvePage(args.pageId),
          readString(args.from_uid),
          readString(args.to_uid),
        );
        return textResult('Element dragged.');
      case BrowserMcpTool.UploadFile:
        await this.uploadFile(this.resolvePage(args.pageId), readString(args.uid), readString(args.filePath));
        return textResult('File uploaded.');
      case BrowserMcpTool.PressKey:
        this.pressKey(this.resolvePage(args.pageId), readString(args.key));
        return textResult('Key pressed.');
      case BrowserMcpTool.ResizePage:
        return textResult('The in-app browser size is controlled by the LobsterAI panel.');
      case BrowserMcpTool.HandleDialog:
        await this.handleDialog(this.resolvePage(args.pageId), readString(args.action), readString(args.promptText));
        return textResult('Dialog handled.');
      case BrowserMcpTool.EvaluateScript:
        return this.evaluateScript(this.resolvePage(args.pageId), readString(args.function), args.args);
      case BrowserMcpTool.WaitFor:
        await this.waitForText(this.resolvePage(args.pageId), readString(args.text), readTimeout(args.timeout));
        return textResult('Text found.');
      case BrowserMcpTool.LoginWithSavedCredential: {
        const page = this.resolvePage(args.pageId);
        const result = await this.credentialLogin.login({
          url: page.view.webContents.getURL(),
          sessionId: this.activeSessionId,
          accountHint: readString(args.accountHint) || undefined,
          reason: readString(args.reason) || undefined,
        });
        if (
          result.outcome === BrowserCredentialLoginOutcome.Authenticated
          || result.outcome === BrowserCredentialLoginOutcome.Submitted
          || result.outcome === BrowserCredentialLoginOutcome.NeedsMfa
          || result.outcome === BrowserCredentialLoginOutcome.NeedsCaptcha
        ) {
          page.view.webContents.reload();
        }
        return {
          ...textResult(result.message, { ...result }),
          ...(result.outcome === BrowserCredentialLoginOutcome.Failed
            || result.outcome === BrowserCredentialLoginOutcome.Denied
            ? { isError: true }
            : {}),
        };
      }
      default:
        throw new Error(`Unsupported LobsterAI browser tool: ${tool}`);
    }
  }

  private async createPage(
    url: string,
    timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  ): Promise<BrowserPage> {
    const pageId = this.nextPageId++;
    const view = new WebContentsView({
      webPreferences: {
        partition: AgentBrowserPartition.Default,
        preload: this.manualCredentialPreloadPath,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        plugins: false,
        devTools: false,
        spellcheck: false,
        navigateOnDragDrop: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const page: BrowserPage = {
      pageId,
      view,
      loading: false,
      refs: new Map(),
    };
    this.pages.set(pageId, page);
    this.selectedPageId = pageId;
    this.installPageHandlers(page);
    this.syncAttachment();
    this.emitState();

    try {
      await this.navigatePage(page, url, timeoutMs);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emitState();
      throw error;
    }
    return page;
  }

  private installPageHandlers(page: BrowserPage): void {
    const webContents = page.view.webContents;
    const emit = () => this.emitState();
    webContents.on('did-start-loading', () => {
      page.loading = true;
      this.lastError = undefined;
      emit();
    });
    webContents.on('did-stop-loading', () => {
      page.loading = false;
      emit();
    });
    webContents.on('page-title-updated', emit);
    webContents.on('did-navigate', emit);
    webContents.on('did-navigate-in-page', emit);
    webContents.on('ipc-message', (_event, channel, ...args) => {
      if (channel !== ManualCredentialCaptureChannel.Event) return;
      const captureEvent = parseManualCredentialCaptureEvent(args[0]);
      if (!captureEvent) return;
      const url = webContents.getURL();
      if (captureEvent.type === ManualCredentialCaptureEventType.Submitted) {
        this.manualCredentialCapture.capture({
          pageId: page.pageId,
          url,
          username: captureEvent.username,
          password: captureEvent.password,
          formKind: captureEvent.formKind,
        });
        return;
      }
      this.manualCredentialCapture.observePageState({
        pageId: page.pageId,
        url,
        hasPasswordField: captureEvent.hasPasswordField,
      });
    });
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      page.loading = false;
      this.lastError = `${errorDescription} (${validatedURL})`;
      emit();
    });
    webContents.on('destroyed', () => {
      this.markBrowserToolBootstrapPageUsed(page.pageId);
      this.manualCredentialCapture.clearPage(page.pageId);
      this.pages.delete(page.pageId);
      if (this.selectedPageId === page.pageId) {
        this.selectedPageId = this.pages.keys().next().value as number | undefined;
      }
      if (this.attachedPageId === page.pageId) this.attachedPageId = undefined;
      this.syncAttachment();
      emit();
    });
    const preventBlockedNavigation = (event: Electron.Event, targetUrl: string) => {
      if (!this.isAllowedUrl(targetUrl)) {
        event.preventDefault();
        this.lastError = 'Navigation was blocked by the LobsterAI browser access policy.';
        emit();
      }
    };
    webContents.on('will-navigate', preventBlockedNavigation);
    webContents.on('will-redirect', preventBlockedNavigation);
    webContents.setWindowOpenHandler(({ url }) => {
      if (this.isAllowedUrl(url)) {
        void this.createPage(url).catch(error => {
          console.warn('[AgentBrowserHost] Failed to open child page:', error);
        });
      }
      return { action: 'deny' };
    });
  }

  private async navigatePage(page: BrowserPage, url: string, timeoutMs: number): Promise<void> {
    if (!this.isAllowedUrl(url)) {
      throw new Error('Navigation was blocked by the LobsterAI browser access policy.');
    }
    this.lastError = undefined;
    await this.proxyReady;
    const loadPromise = page.view.webContents.loadURL(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        loadPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Browser navigation timed out after ${timeoutMs}ms.`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private isAllowedUrl(url: string): boolean {
    return !isBlockedHostname(
      url,
      normalizeBrowserWebAccessConfig(this.deps.getBrowserConfig()),
    );
  }

  private refreshProxy(): void {
    this.proxyReady = this.browserSession
      .setProxy({ mode: this.deps.useSystemProxy() ? 'system' : 'direct' })
      .catch(error => {
        console.warn('[AgentBrowserHost] Failed to configure proxy:', error);
      });
  }

  /**
   * OpenClaw 2026.8.1 refuses to create the first page for an existing-session
   * profile without a CDP endpoint. LobsterAI intentionally uses its authenticated
   * MCP bridge instead of exposing Electron CDP, so provide one blank baseline page
   * before list_pages returns. Concurrent probes share the same initialization.
   */
  private async ensureBrowserToolPageBaseline(): Promise<void> {
    if (this.browserToolBootstrapPagePromise) {
      await this.browserToolBootstrapPagePromise;
      return;
    }
    if (this.pages.size > 0) return;

    const pendingPage = this.createPage(DEFAULT_PAGE_URL);
    this.browserToolBootstrapPagePromise = pendingPage;
    try {
      const page = await pendingPage;
      if (
        this.pages.get(page.pageId) === page
        && !page.view.webContents.isDestroyed()
        && (page.view.webContents.getURL() || DEFAULT_PAGE_URL) === DEFAULT_PAGE_URL
      ) {
        this.reusableBrowserToolBootstrapPageId = page.pageId;
      }
    } finally {
      if (this.browserToolBootstrapPagePromise === pendingPage) {
        this.browserToolBootstrapPagePromise = null;
      }
    }
  }

  private takeReusableBrowserToolBootstrapPage(): BrowserPage | undefined {
    const pageId = this.reusableBrowserToolBootstrapPageId;
    this.reusableBrowserToolBootstrapPageId = undefined;
    if (!pageId) return undefined;

    const page = this.pages.get(pageId);
    if (
      !page
      || page.view.webContents.isDestroyed()
      || (page.view.webContents.getURL() || DEFAULT_PAGE_URL) !== DEFAULT_PAGE_URL
    ) {
      return undefined;
    }
    return page;
  }

  private markBrowserToolBootstrapPageUsed(pageId: number): void {
    if (this.reusableBrowserToolBootstrapPageId === pageId) {
      this.reusableBrowserToolBootstrapPageId = undefined;
    }
  }

  private pagesResult(): BrowserToolResponse {
    const pages = Array.from(this.pages.values()).map(page => ({
      id: page.pageId,
      url: page.view.webContents.getURL() || DEFAULT_PAGE_URL,
      selected: page.pageId === this.selectedPageId,
    }));
    return textResult(JSON.stringify({ pages }), { pages });
  }

  private async takeSnapshot(page: BrowserPage): Promise<BrowserToolResponse> {
    await this.ensureDebugger(page);
    const result = await page.view.webContents.debugger.sendCommand('Accessibility.getFullAXTree') as {
      nodes?: AxNode[];
    };
    const nodes = (result.nodes ?? [])
      .filter(node => !node.ignored)
      .slice(0, MAX_SNAPSHOT_NODES);
    const nodeById = new Map(nodes.map(node => [node.nodeId, node]));
    page.refs.clear();

    const buildNode = (node: AxNode, ancestors: Set<string>): SnapshotNode | null => {
      if (ancestors.has(node.nodeId)) return null;
      const nextAncestors = new Set(ancestors).add(node.nodeId);
      const ref = `ax-${page.pageId}-${node.nodeId}`;
      if (typeof node.backendDOMNodeId === 'number') {
        page.refs.set(ref, node.backendDOMNodeId);
      }
      const children = (node.childIds ?? [])
        .map(childId => nodeById.get(childId))
        .filter((child): child is AxNode => Boolean(child))
        .map(child => buildNode(child, nextAncestors))
        .filter((child): child is SnapshotNode => Boolean(child));
      const role = toSnapshotScalar(node.role?.value);
      const name = toSnapshotScalar(node.name?.value);
      const value = toSnapshotScalar(node.value?.value);
      const description = toSnapshotScalar(node.description?.value);
      return {
        ...(node.backendDOMNodeId ? { id: ref } : {}),
        ...(role !== undefined ? { role: String(role) } : {}),
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(children.length > 0 ? { children } : {}),
      };
    };

    const rootNodes = nodes.filter(node => !node.parentId || !nodeById.has(node.parentId));
    const roots = rootNodes
      .map(node => buildNode(node, new Set()))
      .filter((node): node is SnapshotNode => Boolean(node));
    const snapshot: SnapshotNode = roots.length === 1
      ? roots[0]
      : { role: 'RootWebArea', name: page.view.webContents.getTitle(), children: roots };
    return textResult('Accessibility snapshot captured.', { snapshot });
  }

  private async takeScreenshot(
    page: BrowserPage,
    args: Record<string, unknown>,
  ): Promise<BrowserToolResponse> {
    await this.ensureDebugger(page);
    const format = readString(args.format).toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
    const uid = readString(args.uid);
    const clip = uid ? await this.getElementClip(page, uid) : undefined;
    const result = await page.view.webContents.debugger.sendCommand('Page.captureScreenshot', {
      format,
      fromSurface: true,
      captureBeyondViewport: args.fullPage === true,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    }) as { data: string };
    return textResult('Screenshot captured.', {
      imageBase64: result.data,
      format,
    });
  }

  private async click(page: BrowserPage, uid: string, doubleClick: boolean): Promise<void> {
    const backendNodeId = this.requireBackendNodeId(page, uid);
    await this.ensureDebugger(page);
    page.view.webContents.focus();
    const debuggerApi = page.view.webContents.debugger;
    const objectId = await this.resolveObjectId(page, backendNodeId);
    await debuggerApi.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(shouldDoubleClick) {
        this.focus();
        this.click();
        if (shouldDoubleClick) {
          this.click();
          this.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            view: window,
          }));
        }
      }`,
      arguments: [{ value: doubleClick }],
      awaitPromise: true,
      userGesture: true,
    });
  }

  private async fill(page: BrowserPage, uid: string, value: string): Promise<void> {
    const backendNodeId = this.requireBackendNodeId(page, uid);
    await this.ensureDebugger(page);
    const debuggerApi = page.view.webContents.debugger;
    page.view.webContents.focus();
    const objectId = await this.resolveObjectId(page, backendNodeId);
    await debuggerApi.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(nextValue) {
        this.focus();
        if ('value' in this) {
          const prototype = Object.getPrototypeOf(this);
          const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
          if (descriptor && descriptor.set) descriptor.set.call(this, nextValue);
          else this.value = nextValue;
        } else {
          this.textContent = nextValue;
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value }],
      awaitPromise: true,
      userGesture: true,
    });
  }

  private async fillForm(page: BrowserPage, value: unknown): Promise<void> {
    if (!Array.isArray(value)) throw new Error('Browser form elements are missing.');
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const element = item as Record<string, unknown>;
      await this.fill(page, readString(element.uid), readString(element.value));
    }
  }

  private async hover(page: BrowserPage, uid: string): Promise<void> {
    const point = await this.getElementCenter(page, uid);
    await this.ensureDebugger(page);
    page.view.webContents.focus();
    await page.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
  }

  private async drag(page: BrowserPage, fromUid: string, toUid: string): Promise<void> {
    const from = await this.getElementCenter(page, fromUid);
    const to = await this.getElementCenter(page, toUid);
    await this.ensureDebugger(page);
    page.view.webContents.focus();
    const debuggerApi = page.view.webContents.debugger;
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x, y: from.y,
    });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1,
    });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1,
    });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1,
    });
  }

  private async uploadFile(page: BrowserPage, uid: string, filePath: string): Promise<void> {
    if (!filePath) throw new Error('Browser upload file path is missing.');
    const backendNodeId = this.requireBackendNodeId(page, uid);
    await this.ensureDebugger(page);
    await page.view.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
      files: [filePath],
      backendNodeId,
    });
  }

  private pressKey(page: BrowserPage, key: string): void {
    if (!key) throw new Error('Browser key is missing.');
    const input = resolveKeyInput(key);
    const modifiers = input.modifiers as Electron.KeyboardInputEvent['modifiers'];
    page.view.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: input.keyCode,
      modifiers,
    });
    if (input.keyCode.length === 1 && modifiers.length === 0) {
      page.view.webContents.sendInputEvent({
        type: 'char',
        keyCode: input.keyCode,
      });
    }
    page.view.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: input.keyCode,
      modifiers,
    });
  }

  private async handleDialog(page: BrowserPage, action: string, promptText: string): Promise<void> {
    await this.ensureDebugger(page);
    await page.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', {
      accept: action === 'accept',
      ...(promptText ? { promptText } : {}),
    });
  }

  private async evaluateScript(
    page: BrowserPage,
    source: string,
    rawArgs: unknown,
  ): Promise<BrowserToolResponse> {
    if (!source) throw new Error('Browser evaluation function is missing.');
    const functionArgs = Array.isArray(rawArgs) ? rawArgs : [];
    await this.ensureDebugger(page);
    const expression = `Promise.resolve((${source})(...${JSON.stringify(functionArgs)}))`;
    const result = await page.view.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string };
    };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || result.result?.description || 'Browser evaluation failed.');
    }
    const message = JSON.stringify(result.result?.value ?? null);
    return textResult(message, { message });
  }

  private async waitForText(page: BrowserPage, text: string, timeoutMs: number): Promise<void> {
    if (!text) throw new Error('Browser wait text is missing.');
    const expression = `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(text)}))`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await page.view.webContents.executeJavaScript(expression, false) as boolean;
      if (found) return;
      await new Promise(resolve => { setTimeout(resolve, 100); });
    }
    throw new Error(`Timed out waiting for browser text after ${timeoutMs}ms.`);
  }

  private async ensureDebugger(page: BrowserPage): Promise<void> {
    const debuggerApi = page.view.webContents.debugger;
    if (!debuggerApi.isAttached()) {
      debuggerApi.attach('1.3');
    }
    await debuggerApi.sendCommand('DOM.enable');
    await debuggerApi.sendCommand('Page.enable');
  }

  private async getElementClip(
    page: BrowserPage,
    uid: string,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const backendNodeId = this.requireBackendNodeId(page, uid);
    await this.ensureDebugger(page);
    const box = await page.view.webContents.debugger.sendCommand('DOM.getBoxModel', {
      backendNodeId,
    }) as { model?: { border?: number[]; content?: number[] } };
    const quad = box.model?.border ?? box.model?.content;
    if (!quad || quad.length < 8) throw new Error(`Browser element ${uid} has no visible box.`);
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
      x,
      y,
      width: Math.max(1, Math.max(...xs) - x),
      height: Math.max(1, Math.max(...ys) - y),
    };
  }

  private async getElementCenter(page: BrowserPage, uid: string): Promise<{ x: number; y: number }> {
    const clip = await this.getElementClip(page, uid);
    return {
      x: clip.x + clip.width / 2,
      y: clip.y + clip.height / 2,
    };
  }

  private requireBackendNodeId(page: BrowserPage, uid: string): number {
    if (!uid) throw new Error('Browser element reference is missing.');
    const backendNodeId = page.refs.get(uid);
    if (!backendNodeId) {
      throw new Error(`Browser element ${uid} is stale. Take a new snapshot and try again.`);
    }
    return backendNodeId;
  }

  private async resolveObjectId(page: BrowserPage, backendNodeId: number): Promise<string> {
    const resolved = await page.view.webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId,
    }) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error('Browser element could not be resolved.');
    return objectId;
  }

  private requirePageId(value: unknown): number {
    const pageId = readPageId(value);
    if (!pageId) throw new Error('A positive browser page ID is required.');
    return pageId;
  }

  private resolvePage(value: unknown): BrowserPage {
    const pageId = readPageId(value) ?? this.selectedPageId;
    if (!pageId) throw new Error('No LobsterAI browser page is open.');
    return this.requirePage(pageId);
  }

  private requirePage(pageId: number): BrowserPage {
    const page = this.pages.get(pageId);
    if (!page || page.view.webContents.isDestroyed()) {
      throw new Error(`Browser page ${pageId} does not exist.`);
    }
    return page;
  }

  private getSelectedPage(): BrowserPage | undefined {
    return this.selectedPageId ? this.pages.get(this.selectedPageId) : undefined;
  }

  private requireSelectedPage(): BrowserPage {
    const page = this.getSelectedPage();
    if (!page) throw new Error('No LobsterAI browser page is open.');
    return page;
  }

  private normalizeBounds(bounds: { x: number; y: number; width: number; height: number }) {
    const mainWindow = this.deps.getMainWindow();
    const contentBounds = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getContentBounds()
      : { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER };
    const x = Math.max(0, Math.round(Number.isFinite(bounds.x) ? bounds.x : 0));
    const y = Math.max(0, Math.round(Number.isFinite(bounds.y) ? bounds.y : 0));
    const width = Math.max(1, Math.min(
      Math.round(Number.isFinite(bounds.width) ? bounds.width : 1),
      Math.max(1, contentBounds.width - x),
    ));
    const height = Math.max(1, Math.min(
      Math.round(Number.isFinite(bounds.height) ? bounds.height : 1),
      Math.max(1, contentBounds.height - y),
    ));
    return { x, y, width, height };
  }

  private syncAttachment(): void {
    const mainWindow = this.deps.getMainWindow();
    const shouldAttach = this.desiredVisible
      && this.windowVisible
      && (this.credentialLoginView !== null || this.selectedPageId !== undefined)
      && mainWindow
      && !mainWindow.isDestroyed();
    if (!shouldAttach) {
      this.detachCredentialLoginView();
      this.detachPage(this.attachedPageId);
      return;
    }

    if (this.credentialLoginView) {
      this.detachPage(this.attachedPageId);
      if (!this.credentialLoginViewAttached) {
        mainWindow.contentView.addChildView(this.credentialLoginView);
        this.credentialLoginViewAttached = true;
      }
      this.credentialLoginView.setBounds(this.normalizeBounds(this.bounds));
      return;
    }

    this.detachCredentialLoginView();

    if (this.attachedPageId !== this.selectedPageId) {
      this.detachPage(this.attachedPageId);
      const page = this.requirePage(this.selectedPageId!);
      mainWindow.contentView.addChildView(page.view);
      this.attachedPageId = page.pageId;
    }
    this.pages.get(this.attachedPageId!)?.view.setBounds(this.normalizeBounds(this.bounds));
  }

  private detachPage(pageId: number | undefined): void {
    if (!pageId) return;
    const page = this.pages.get(pageId);
    const mainWindow = this.deps.getMainWindow();
    if (page && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.contentView.removeChildView(page.view);
      } catch {
        // The view may already have been detached while the window was closing.
      }
    }
    if (this.attachedPageId === pageId) this.attachedPageId = undefined;
  }

  private setCredentialLoginView(view: WebContentsView | null): void {
    if (this.credentialLoginView !== view) this.detachCredentialLoginView();
    this.credentialLoginView = view;
    this.syncAttachment();
    this.emitState();
  }

  private detachCredentialLoginView(): void {
    if (!this.credentialLoginView || !this.credentialLoginViewAttached) return;
    const mainWindow = this.deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.contentView.removeChildView(this.credentialLoginView);
      } catch {
        // The view may already be detached while the window is closing.
      }
    }
    this.credentialLoginViewAttached = false;
  }

  private assertCredentialLoginInactive(): void {
    if (this.credentialLogin.isActive) {
      throw new Error('A secure saved-credential sign-in is in progress.');
    }
  }

  private emitState(sessionId = this.activeSessionId): void {
    this.deps.emitState({
      ...(sessionId ? { sessionId } : {}),
      state: this.getState(),
    });
  }
}
