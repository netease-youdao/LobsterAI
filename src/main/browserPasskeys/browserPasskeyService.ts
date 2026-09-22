import {
  type BrowserWindow,
  dialog,
  type Session,
  type WebContents,
} from 'electron';

import {
  BrowserPasskeyAction,
  BrowserPasskeyChannel,
  type BrowserPasskeyNotice,
  type BrowserPasskeyRequest,
  BrowserPasskeyStatus,
  parseBrowserPasskeyEvent,
} from '../../shared/browserWebAccess/passkeys';
import { t } from '../i18n';
import { configureMacWebAuthn } from './macWebAuthn';

const SELECT_ACCOUNT_EVENT = 'select-webauthn-account';

interface WatchedPage {
  pageId: number;
  webContents: WebContents;
  notice?: BrowserPasskeyNotice;
  dialogs: Set<AbortController>;
}

export class BrowserPasskeyService {
  readonly ready: Promise<void>;
  private readonly pages = new Map<WebContents, WatchedPage>();
  private platformAuthenticatorAvailable: boolean | undefined;

  constructor(private readonly deps: {
    session: Session;
    getMainWindow: () => BrowserWindow | null;
    onChanged: () => void;
  }) {
    this.ready = configureMacWebAuthn().then(available => {
      this.platformAuthenticatorAvailable = available;
    });
    this.deps.session.on(SELECT_ACCOUNT_EVENT, this.selectAccount);
  }

  watch(webContents: WebContents, pageId: number): void {
    if (this.pages.has(webContents)) return;
    const page: WatchedPage = { pageId, webContents, dialogs: new Set() };
    this.pages.set(webContents, page);
    webContents.on('ipc-message', (event, channel, value) => {
      if (channel !== BrowserPasskeyChannel.Event || event.senderFrame !== webContents.mainFrame) return;
      const report = parseBrowserPasskeyEvent(value);
      if (!report) return;
      if (report.status === BrowserPasskeyStatus.Waiting) {
        let origin: string;
        try {
          const url = new URL(webContents.getURL());
          if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
          origin = url.origin;
        } catch { return; }
        page.notice = {
          ...report, pageId, origin,
          platformAuthenticatorAvailable: this.platformAuthenticatorAvailable,
        };
      } else if (page.notice?.requestId === report.requestId) {
        for (const controller of page.dialogs) controller.abort();
        page.dialogs.clear();
        page.notice = report.status === BrowserPasskeyStatus.Succeeded
          ? undefined
          : { ...page.notice, status: report.status };
      } else {
        return;
      }
      this.deps.onChanged();
    });
    webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.clearPage(page);
    });
    webContents.on('did-navigate', () => this.clearPage(page));
    webContents.on('render-process-gone', () => this.clearPage(page));
    webContents.on('destroyed', () => {
      this.clearPage(page);
      this.pages.delete(webContents);
    });
  }

  getNotice(webContents?: WebContents): BrowserPasskeyNotice | undefined {
    return webContents ? this.pages.get(webContents)?.notice : undefined;
  }

  resolve(webContents: WebContents, request: BrowserPasskeyRequest): void {
    const page = this.pages.get(webContents);
    if (!page?.notice || page.pageId !== request.pageId || page.notice.requestId !== request.requestId) return;
    if (!Object.values(BrowserPasskeyAction).includes(request.action)) return;
    this.cancelPage(page);
    page.notice = request.action === BrowserPasskeyAction.Dismiss
      ? undefined
      : { ...page.notice, status: BrowserPasskeyStatus.Cancelled };
    this.deps.onChanged();
  }

  dispose(): void {
    this.deps.session.removeListener(SELECT_ACCOUNT_EVENT, this.selectAccount);
    for (const page of this.pages.values()) this.clearPage(page);
    this.pages.clear();
  }

  private cancelPage(page: WatchedPage): void {
    if (page.notice?.status === BrowserPasskeyStatus.Waiting && !page.webContents.isDestroyed()) {
      page.webContents.send(BrowserPasskeyChannel.Cancel, page.notice.requestId);
    }
    for (const controller of page.dialogs) controller.abort();
    page.dialogs.clear();
  }

  private clearPage(page: WatchedPage): void {
    this.cancelPage(page);
    page.notice = undefined;
    this.deps.onChanged();
  }

  private readonly selectAccount = (
    _event: Electron.Event,
    details: Electron.SelectWebauthnAccountDetails,
    callback: (credentialId?: string | null) => void,
  ): void => {
    if (!details.frame || details.frame.isDestroyed()) {
      callback();
      return;
    }
    const page = Array.from(this.pages.values()).find(candidate => (
      !candidate.webContents.isDestroyed()
      && details.frame?.top === candidate.webContents.mainFrame
    ));
    const owner = this.deps.getMainWindow();
    if (!page || !owner || owner.isDestroyed() || !details.accounts.length) {
      callback();
      return;
    }
    const controller = new AbortController();
    page.dialogs.add(controller);
    let credentialId: string | undefined;
    // Account labels stay in the native chooser. Never expose credential IDs or
    // assertions through browser tools, renderer state, or application logs.
    void (async () => {
      try {
        const result = await dialog.showMessageBox(owner, {
          type: 'question',
          title: t('browserPasskeyChooseAccountTitle'),
          message: t('browserPasskeyChooseAccountMessage', { site: details.relyingPartyId }),
          buttons: [
            ...details.accounts.map(account => account.displayName || account.name || t('browserPasskeyUnnamedAccount')),
            t('browserPasskeyCancel'),
          ],
          defaultId: details.accounts.length,
          cancelId: details.accounts.length,
          noLink: true,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && !page.webContents.isDestroyed() && !details.frame?.isDestroyed()) {
          credentialId = details.accounts[result.response]?.credentialId;
        }
      } catch (error) {
        console.warn('[BrowserPasskeys] Account selection failed:', error);
      } finally {
        page.dialogs.delete(controller);
        callback(credentialId);
      }
    })();
  };
}
