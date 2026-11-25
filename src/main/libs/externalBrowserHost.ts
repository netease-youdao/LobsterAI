import path from 'node:path';

import { type BrowserContext, chromium, type Dialog, type Page, type Route } from 'playwright-core';

import {
  AgentBrowserNavigation,
  AgentBrowserPageUrl,
  type BrowserWebAccessConfig,
} from '../../shared/browserWebAccess/constants';
import { BrowserMcpTool, isBlockedAgentBrowserUrl } from './agentBrowserHost';
import type { BrowserToolRequest, BrowserToolResponse } from './mcpBridgeServer';

interface ExternalBrowserHostDeps {
  profilePath: string;
  getConfig(): BrowserWebAccessConfig;
  useSystemProxy(): boolean;
}

interface BrowserConnection {
  context: BrowserContext;
  close: () => Promise<void>;
}

const START_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_SNAPSHOT_LENGTH = 90_000;
const HTTP_ROUTE = /^https?:\/\//i;
const DEFAULT_URL = AgentBrowserPageUrl.Blank;

const timeout = (value: unknown): number => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(1, Math.min(value, MAX_TIMEOUT_MS))
  : ACTION_TIMEOUT_MS;
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const result = (message: string, structuredContent?: BrowserToolResponse['structuredContent']): BrowserToolResponse => ({
  content: [{ type: 'text', text: message }],
  ...(structuredContent ? { structuredContent } : {}),
});

export class ExternalBrowserHost {
  private connection?: Promise<BrowserConnection>;
  private connectionKey?: string;
  private readonly pageIds = new WeakMap<Page, number>();
  private readonly dialogs = new WeakMap<Page, Dialog>();
  private selected?: Page;
  private nextPageId = 1;

  constructor(private readonly deps: ExternalBrowserHostDeps) {}

  private readonly interceptBlockedHost = async (route: Route): Promise<void> => {
    if (isBlockedAgentBrowserUrl(route.request().url(), this.deps.getConfig())) await route.abort('blockedbyclient');
    else await route.continue();
  };

  private async launch(config: BrowserWebAccessConfig, useSystemProxy: boolean): Promise<BrowserConnection> {
    if (config.cdpUrl) {
      const browser = await chromium.connectOverCDP(config.cdpUrl, {
        timeout: START_TIMEOUT_MS,
      });
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close();
        throw new Error('The external browser did not provide a persistent context.');
      }
      return { context, close: () => browser.close() };
    }

    const customExecutable = config.executablePath;
    const launchOptions: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]> = {
      headless: false,
      chromiumSandbox: true,
      viewport: null,
      serviceWorkers: 'block',
      timeout: START_TIMEOUT_MS,
      args: useSystemProxy ? [] : ['--no-proxy-server'],
    };
    let context: BrowserContext;
    if (customExecutable) {
      context = await chromium.launchPersistentContext(this.deps.profilePath, { ...launchOptions, executablePath: customExecutable });
    } else {
      try {
        context = await chromium.launchPersistentContext(this.deps.profilePath, { ...launchOptions, channel: 'chrome' });
      } catch (chromeError) {
        try {
          context = await chromium.launchPersistentContext(this.deps.profilePath, { ...launchOptions, channel: 'msedge' });
        } catch (edgeError) {
          throw new AggregateError([chromeError, edgeError], 'Could not open Chrome or Edge. Set the browser executable in Settings.');
        }
      }
    }
    return { context, close: () => context.close() };
  }

  private async getContext(): Promise<BrowserContext> {
    const config = this.deps.getConfig();
    const useSystemProxy = this.deps.useSystemProxy();
    const key = JSON.stringify([config.executablePath, config.cdpUrl, useSystemProxy]);
    if (this.connection && this.connectionKey !== key) await this.dispose();
    if (!this.connection) {
      this.connectionKey = key;
      const connection = this.launch(config, useSystemProxy).then(async opened => {
        try {
          await opened.context.route(HTTP_ROUTE, this.interceptBlockedHost);
          opened.context.setDefaultTimeout(ACTION_TIMEOUT_MS);
          opened.context.pages().forEach(page => this.registerPage(page));
          opened.context.on('page', this.registerPage);
          opened.context.once('close', () => this.forgetConnection(connection));
          return opened;
        } catch (error) {
          await opened.close().catch((): void => undefined);
          throw error;
        }
      });
      this.connection = connection;
      void connection.catch(() => this.forgetConnection(connection));
    }
    return (await this.connection).context;
  }

  private forgetConnection(connection: Promise<BrowserConnection>): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.connectionKey = undefined;
    this.selected = undefined;
  }

  private readonly registerPage = (page: Page): number => {
    const existing = this.pageIds.get(page);
    if (existing !== undefined) return existing;
    const id = this.nextPageId++;
    this.pageIds.set(page, id);
    page.on('dialog', dialog => this.dialogs.set(page, dialog));
    page.on('close', () => {
      if (this.selected === page) this.selected = undefined;
    });
    return id;
  };

  async dispose(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    const opened = await connection.catch((): null => null);
    try {
      if (opened) {
        opened.context.off('page', this.registerPage);
        await opened.context.unroute(HTTP_ROUTE, this.interceptBlockedHost).catch((): void => undefined);
        await opened.close();
      }
    } finally {
      this.forgetConnection(connection);
    }
  }

  private requireAllowedUrl(url: string): void {
    if (isBlockedAgentBrowserUrl(url, this.deps.getConfig())) {
      throw new Error('This URL is blocked by LobsterAI browser settings.');
    }
  }

  private async pages(context: BrowserContext): Promise<BrowserToolResponse> {
    const contents = await Promise.all(context.pages().map(async page => {
      const url = page.url();
      if (isBlockedAgentBrowserUrl(url, this.deps.getConfig())) return undefined;
      return {
        pageId: this.registerPage(page),
        url,
        title: await page.title().catch(() => ''),
        selected: this.selected === page,
      };
    }));
    const pages = contents.filter(item => item !== undefined);
    return result(pages.map(page => `${page.pageId}: ${page.url}${page.selected ? ' [selected]' : ''}`).join('\n'), { pages });
  }

  private getPage(context: BrowserContext, requestedId: unknown): Page {
    const page = requestedId !== undefined
      ? context.pages().find(candidate => this.pageIds.get(candidate) === Number(requestedId))
      : this.selected ?? context.pages()[0];
    if (!page || page.isClosed()) throw new Error('The browser page is unavailable. Open a page first.');
    return page;
  }

  private async navigate(page: Page, args: Record<string, unknown>): Promise<void> {
    const load = { waitUntil: 'domcontentloaded' as const, timeout: timeout(args.timeout) };
    switch (args.type ?? AgentBrowserNavigation.Url) {
      case AgentBrowserNavigation.Url: {
        const url = text(args.url).trim();
        this.requireAllowedUrl(url);
        await page.goto(url, load);
        break;
      }
      case AgentBrowserNavigation.Back:
        await page.goBack(load);
        break;
      case AgentBrowserNavigation.Forward:
        await page.goForward(load);
        break;
      case AgentBrowserNavigation.Reload:
        await page.reload(load);
        break;
      default:
        throw new Error('Unsupported browser navigation.');
    }
    this.requireAllowedUrl(page.url());
  }

  private async fill(page: Page, uid: string, value: string): Promise<void> {
    const element = page.getByRef(uid);
    const kind = await element.evaluate(node => node instanceof HTMLSelectElement
      ? 'select'
      : node instanceof HTMLInputElement ? node.type : '');
    if (kind === 'select') await element.selectOption(value);
    else if (kind === 'checkbox' || kind === 'radio') await element.setChecked(value === 'true' || value === '1');
    else await element.fill(value);
  }

  private async operate(context: BrowserContext, { tool, args, signal }: BrowserToolRequest): Promise<BrowserToolResponse> {
    if (tool === BrowserMcpTool.ListPages) {
      if (!context.pages().length) this.selected = await context.newPage();
      return this.pages(context);
    }
    if (tool === BrowserMcpTool.NewPage) {
      const url = text(args.url).trim() || DEFAULT_URL;
      this.requireAllowedUrl(url);
      this.selected = await context.newPage();
      if (url !== DEFAULT_URL) await this.navigate(this.selected, { ...args, url, type: AgentBrowserNavigation.Url });
      return this.pages(context);
    }
    const page = this.getPage(context, args.pageId);
    if (tool === BrowserMcpTool.NavigatePage) {
      await this.navigate(page, args);
      return result('Page navigated.', { url: page.url() });
    }
    if (tool === BrowserMcpTool.ClosePage) {
      await page.close();
      return this.pages(context);
    }
    this.requireAllowedUrl(page.url());
    const uid = text(args.uid);
    switch (tool) {
      case BrowserMcpTool.SelectPage:
        this.selected = page;
        if (args.bringToFront !== false) await page.bringToFront();
        return this.pages(context);
      case BrowserMcpTool.TakeSnapshot:
        return result((await page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS, signal })).slice(0, MAX_SNAPSHOT_LENGTH));
      case BrowserMcpTool.TakeScreenshot: {
        const format = args.format === 'jpeg' ? 'jpeg' : 'png';
        const bytes = uid ? await page.getByRef(uid).screenshot({ type: format })
          : await page.screenshot({ type: format, fullPage: args.fullPage === true });
        return result('Page screenshot captured.', { format, imageBase64: bytes.toString('base64') });
      }
      case BrowserMcpTool.Click:
        if (args.dblClick === true) await page.getByRef(uid).dblclick();
        else await page.getByRef(uid).click();
        break;
      case BrowserMcpTool.Fill:
        await this.fill(page, uid, text(args.value));
        break;
      case BrowserMcpTool.FillForm:
        for (const element of Array.isArray(args.elements) ? args.elements : []) {
          await this.fill(page, text(element?.uid), String(element?.value ?? ''));
        }
        break;
      case BrowserMcpTool.Hover:
        await page.getByRef(uid).hover();
        break;
      case BrowserMcpTool.Drag:
        await page.getByRef(text(args.from_uid)).dragTo(page.getByRef(text(args.to_uid)));
        break;
      case BrowserMcpTool.UploadFile: {
        const file = text(args.filePath);
        if (!path.isAbsolute(file)) throw new Error('An absolute upload file path is required.');
        await page.getByRef(uid).setInputFiles(file);
        break;
      }
      case BrowserMcpTool.PressKey:
        await page.keyboard.press(text(args.key));
        break;
      case BrowserMcpTool.ResizePage:
        await page.setViewportSize({ width: Number(args.width), height: Number(args.height) });
        break;
      case BrowserMcpTool.HandleDialog: {
        const dialog = this.dialogs.get(page);
        if (!dialog) throw new Error('There is no browser dialog to resolve.');
        if (args.action === 'accept') await dialog.accept(text(args.promptText));
        else await dialog.dismiss();
        this.dialogs.delete(page);
        break;
      }
      case BrowserMcpTool.EvaluateScript: {
        const source = text(args.function);
        if (!source) throw new Error('A browser function is required.');
        const values = Array.isArray(args.args) ? args.args : [];
        const value: unknown = await page.evaluate(`(${source})(...${JSON.stringify(values)})`);
        return result(JSON.stringify(value) ?? '', { value });
      }
      case BrowserMcpTool.WaitFor:
        await page.getByText(text(args.text)).first().waitFor({ timeout: timeout(args.timeout) });
        break;
      case BrowserMcpTool.LoginWithSavedCredential:
        throw new Error('Use the external browser window to sign in.');
      default:
        throw new Error('Unknown external browser tool.');
    }
    return result('Browser action completed.');
  }

  async handleToolRequest(request: BrowserToolRequest): Promise<BrowserToolResponse> {
    try {
      request.signal?.throwIfAborted();
      const context = await this.getContext();
      request.signal?.throwIfAborted();
      return await this.operate(context, request);
    } catch (error) {
      return { ...result(error instanceof Error ? error.message : String(error)), isError: true };
    }
  }
}
