import {
  type GenerateSessionTitleRequest,
  SESSION_TITLE_INPUT_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
} from '../../common/sessionTitle';

interface SessionTitleDependencies {
  getAuth: () => { sessionKey: string; accessToken: string; headers: Record<string, string> } | null;
  getBaseUrl: () => string;
  fetch: (url: string, options: RequestInit) => Promise<Response>;
  getSession: (sessionId: string) => { title: string } | null;
  setTitle: (sessionId: string, title: string) => void;
}

/** Best-effort, one-shot title generation, independent of the agent's model and runtime. */
export class SessionTitleGenerator {
  private readonly pending = new Map<string, AbortController>();

  constructor(private readonly deps: SessionTitleDependencies) {}

  cancel(sessionId: string): void {
    this.pending.get(sessionId)?.abort();
    this.pending.delete(sessionId);
  }

  async generate(request: GenerateSessionTitleRequest): Promise<string | null> {
    const auth = this.deps.getAuth();
    if (!auth || !request || typeof request.text !== 'string' || !request.text.trim()
      || Array.from(request.text).length > SESSION_TITLE_INPUT_MAX_CHARS
      || this.pending.has(request.sessionId)
      || this.deps.getSession(request.sessionId)?.title !== request.expectedTitle) return null;

    const controller = new AbortController();
    this.pending.set(request.sessionId, controller);
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      // Deliberately bypass auth-refresh/retry wrappers. This helper never prompts for login.
      const response = await this.deps.fetch(`${this.deps.getBaseUrl()}/api/desktop-tools/session-title`, {
        method: 'POST',
        headers: { ...auth.headers, Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.sessionId, text: request.text }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) return null;
      const result = await response.json() as { code?: number; data?: { title?: unknown } };
      const title = result.data?.title;
      if (result.code !== 0 || typeof title !== 'string' || !title.trim()
        || Array.from(title).length > SESSION_TITLE_MAX_CHARS
        || Array.from(title).some(character => {
          const code = character.codePointAt(0)!;
          return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
        })
        || controller.signal.aborted
        || this.deps.getAuth()?.sessionKey !== auth.sessionKey
        || this.deps.getSession(request.sessionId)?.title !== request.expectedTitle) return null;

      this.deps.setTitle(request.sessionId, title.trim());
      return title.trim();
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      if (this.pending.get(request.sessionId) === controller) this.pending.delete(request.sessionId);
    }
  }
}
