import { WEIXIN_QR_ACTIVATION_TIMEOUT_MS } from '../../shared/im/weixin';
import { t } from '../i18n';

interface LoginSession {
  sessionKey?: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** A QR login may load the plugin without persisting an enabled channel. */
export class WeixinPluginActivation {
  private session: LoginSession | null = null;

  constructor(private readonly sync: () => Promise<void>) {}

  isActive(): boolean {
    return this.session !== null;
  }

  private assertCurrent(session: LoginSession): void {
    if (this.session !== session) throw new Error(t('imWeixinQrSessionExpired'));
  }

  async start<T extends { qrDataUrl?: string; sessionKey?: string }>(run: () => Promise<T>): Promise<T> {
    this.cancel();
    const session: LoginSession = {};
    this.session = session;
    session.timer = setTimeout(() => {
      void this.finish(session);
    }, WEIXIN_QR_ACTIVATION_TIMEOUT_MS);
    session.timer.unref?.();
    try {
      await this.sync();
      this.assertCurrent(session);
      const result = await run();
      this.assertCurrent(session);
      session.sessionKey = result.sessionKey;
      if (!result.qrDataUrl || !result.sessionKey) await this.finish(session);
      return result;
    } catch (error) {
      await this.finish(session);
      throw error;
    }
  }

  async wait<T>(sessionKey: string | undefined, run: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    const session = this.session;
    if (!session || !sessionKey || session.sessionKey !== sessionKey) {
      throw new Error(t('imWeixinQrSessionExpired'));
    }
    try {
      const result = await run(() => this.assertCurrent(session));
      this.assertCurrent(session);
      return result;
    } finally {
      await this.finish(session);
    }
  }

  /** Settings disable/shutdown already owns its config sync; only invalidate pending work here. */
  cancel(): void {
    if (this.session?.timer) clearTimeout(this.session.timer);
    this.session = null;
  }

  private async finish(session: LoginSession): Promise<void> {
    if (this.session !== session) return;
    this.cancel();
    try {
      await this.sync();
    } catch (error) {
      // The next config sync or cold start also derives the disabled state from
      // the stored channel config. Preserve the original login outcome.
      console.error('[WeixinPluginActivation] Failed to restore plugin activation:', error);
    }
  }
}
