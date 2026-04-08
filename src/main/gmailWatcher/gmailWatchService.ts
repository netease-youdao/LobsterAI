/**
 * Gmail Watch Service — polls Gmail API for new messages and triggers
 * agent sessions when new mail arrives.
 *
 * Uses Gmail API history.list() for incremental change detection.
 * No Google Cloud Pub/Sub infrastructure needed — runs entirely locally.
 */
import {
  GMAIL_API_BASE,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  GmailStorageKey,
  type GmailOAuthTokens,
  type GmailWatcherConfig,
} from './constants';
import { refreshGmailAccessToken } from './gmailOAuth';

interface GmailMessage {
  id: string;
  threadId: string;
}

interface GmailMessageDetail {
  id: string;
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
  };
  internalDate: string;
}

interface GmailHistoryResponse {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{ message: GmailMessage }>;
  }>;
  historyId: string;
  nextPageToken?: string;
}

type StoreGetter = () => {
  get: <T>(key: string) => T | null;
  set: (key: string, value: unknown) => void;
} | null;

type AgentTrigger = (prompt: string) => void;

export class GmailWatchService {
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tokens: GmailOAuthTokens | null = null;
  private config: GmailWatcherConfig | null = null;
  private lastHistoryId: string | null = null;
  private consecutiveErrors = 0;

  constructor(
    private readonly getStore: StoreGetter,
    private readonly onNewEmail: AgentTrigger,
  ) {}

  /**
   * Start the polling loop. Loads config and tokens from the store.
   */
  start(): void {
    if (this.running) return;

    const store = this.getStore();
    if (!store) {
      console.warn('[GmailWatcher] store not available, cannot start');
      return;
    }

    this.config = store.get<GmailWatcherConfig>(GmailStorageKey.Config);
    if (!this.config?.enabled || !this.config.clientId) {
      console.log('[GmailWatcher] not enabled or not configured, skipping start');
      return;
    }

    this.tokens = store.get<GmailOAuthTokens>(GmailStorageKey.OAuthTokens);
    if (!this.tokens?.refreshToken) {
      console.warn('[GmailWatcher] no OAuth tokens found, skipping start');
      return;
    }

    this.lastHistoryId = store.get<string>(GmailStorageKey.LastHistoryId);
    this.running = true;
    this.consecutiveErrors = 0;
    console.log('[GmailWatcher] started polling');
    this.schedulePoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[GmailWatcher] stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): { running: boolean; lastHistoryId: string | null; email?: string } {
    return {
      running: this.running,
      lastHistoryId: this.lastHistoryId,
    };
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.tokens || !this.config) return;

    try {
      await this.ensureValidToken();

      if (!this.lastHistoryId) {
        // First run: get the current historyId as baseline (don't process old mail)
        const profile = await this.gmailFetch('/users/me/profile');
        this.lastHistoryId = profile.historyId;
        this.persistHistoryId();
        console.log(`[GmailWatcher] initialized baseline historyId=${this.lastHistoryId}`);
      } else {
        await this.checkForNewMessages();
      }

      this.consecutiveErrors = 0;
      this.schedulePoll(this.config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
    } catch (error) {
      this.consecutiveErrors++;
      const backoff = Math.min(
        (this.config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS) *
          Math.pow(2, this.consecutiveErrors),
        MAX_POLL_INTERVAL_MS,
      );
      console.error(
        `[GmailWatcher] poll error (attempt ${this.consecutiveErrors}), retrying in ${backoff}ms:`,
        error,
      );
      this.schedulePoll(backoff);
    }
  }

  private async checkForNewMessages(): Promise<void> {
    const labelFilter = this.config?.labelFilter || 'INBOX';
    const params = new URLSearchParams({
      startHistoryId: this.lastHistoryId!,
      historyTypes: 'messageAdded',
      labelId: labelFilter,
    });

    let response: GmailHistoryResponse;
    try {
      response = await this.gmailFetch(`/users/me/history?${params.toString()}`);
    } catch (err: any) {
      // 404 means historyId is too old — reset baseline
      if (err.status === 404) {
        console.warn('[GmailWatcher] historyId expired, resetting baseline');
        const profile = await this.gmailFetch('/users/me/profile');
        this.lastHistoryId = profile.historyId;
        this.persistHistoryId();
        return;
      }
      throw err;
    }

    // Update historyId regardless of whether there are new messages
    if (response.historyId) {
      this.lastHistoryId = response.historyId;
      this.persistHistoryId();
    }

    if (!response.history) return;

    // Collect unique new message IDs
    const newMessageIds = new Set<string>();
    for (const entry of response.history) {
      if (entry.messagesAdded) {
        for (const added of entry.messagesAdded) {
          newMessageIds.add(added.message.id);
        }
      }
    }

    if (newMessageIds.size === 0) return;

    console.log(`[GmailWatcher] found ${newMessageIds.size} new message(s)`);

    // Fetch details for each new message and trigger agent
    for (const msgId of newMessageIds) {
      try {
        const detail = await this.getMessageDetail(msgId);
        if (detail) {
          const prompt = this.buildAgentPrompt(detail);
          this.onNewEmail(prompt);
        }
      } catch (err) {
        console.warn(`[GmailWatcher] failed to fetch message ${msgId}:`, err);
      }
    }
  }

  private async getMessageDetail(messageId: string): Promise<GmailMessageDetail | null> {
    const params = new URLSearchParams({
      format: 'metadata',
      metadataHeaders: 'From,Subject,Date',
    });
    return this.gmailFetch(`/users/me/messages/${messageId}?${params.toString()}`);
  }

  private buildAgentPrompt(detail: GmailMessageDetail): string {
    const headers = detail.payload?.headers || [];
    const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || 'Unknown';
    const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '(no subject)';
    const date =
      headers.find(h => h.name.toLowerCase() === 'date')?.value ||
      new Date(Number(detail.internalDate)).toISOString();

    const template = this.config?.agentPromptTemplate || '';
    return template
      .replace(/\{\{from\}\}/g, from)
      .replace(/\{\{subject\}\}/g, subject)
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{snippet\}\}/g, detail.snippet || '');
  }

  private async ensureValidToken(): Promise<void> {
    if (!this.tokens || !this.config) return;

    // Refresh if within 5 minutes of expiry
    if (Date.now() > this.tokens.expiresAt - 5 * 60_000) {
      console.log('[GmailWatcher] refreshing access token');
      const refreshed = await refreshGmailAccessToken(
        this.config.clientId,
        this.config.clientSecret,
        this.tokens.refreshToken,
      );
      this.tokens.accessToken = refreshed.accessToken;
      this.tokens.expiresAt = refreshed.expiresAt;

      const store = this.getStore();
      if (store) {
        store.set(GmailStorageKey.OAuthTokens, this.tokens);
      }
    }
  }

  private async gmailFetch(path: string): Promise<any> {
    const url = `${GMAIL_API_BASE}${path}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.tokens!.accessToken}` },
    });
    if (!response.ok) {
      const error: any = new Error(`Gmail API error: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  private persistHistoryId(): void {
    const store = this.getStore();
    if (store && this.lastHistoryId) {
      store.set(GmailStorageKey.LastHistoryId, this.lastHistoryId);
    }
  }
}
