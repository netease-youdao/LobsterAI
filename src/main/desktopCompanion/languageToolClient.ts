import {
  LANGUAGE_TRANSLATION_MAX_CHARS, LANGUAGE_TTS_MAX_CHARS,   LanguageTool, LanguageToolCode, type LanguageToolEvent,
LanguageToolEventType,   type LanguageToolQuotas, type LanguageToolRequest, type LanguageToolResult,
TranslationTarget,
} from '../../shared/desktopCompanion/languageTools';
import { splitSseEvents } from './sse';

interface LanguageClientDeps {
  fetchWithAuth(url: string, options?: RequestInit): Promise<Response>;
  getServerApiBaseUrl(): string;
  getSessionKey(): string | null;
}

export class CompanionLanguageClient {
  private running = new Map<string, AbortController>();
  constructor(private readonly deps: LanguageClientDeps) {}

  async quota(): Promise<LanguageToolResult> {
    const session = this.deps.getSessionKey();
    if (!session) return { success: false, code: LanguageToolCode.Unauthorized };
    try {
      const response = await this.deps.fetchWithAuth(`${this.deps.getServerApiBaseUrl()}/api/desktop-tools/quota`);
      const body = await response.json() as { code?: number; data?: LanguageToolQuotas };
      if (session !== this.deps.getSessionKey()) return { success: false, code: LanguageToolCode.Unauthorized };
      return response.ok && body.code === 0 && body.data
        ? { success: true, data: body.data }
        : { success: false, code: body.code ?? LanguageToolCode.Unavailable };
    } catch { return { success: false, code: this.deps.getSessionKey() ? LanguageToolCode.Unavailable : LanguageToolCode.Unauthorized }; }
  }

  start(request: LanguageToolRequest, send: (event: LanguageToolEvent) => void): LanguageToolResult {
    const session = this.deps.getSessionKey();
    if (!session) return { success: false, code: LanguageToolCode.Unauthorized };
    if (!request || !Object.values(LanguageTool).includes(request.tool)
      || typeof request.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.requestId)
      || typeof request.text !== 'string' || !request.text.trim()
      || (request.targetLanguage !== undefined && !Object.values(TranslationTarget).includes(request.targetLanguage))) {
      return { success: false, code: LanguageToolCode.InvalidInput };
    }
    if ([...request.text].length > (request.tool === LanguageTool.Translate ? LANGUAGE_TRANSLATION_MAX_CHARS : LANGUAGE_TTS_MAX_CHARS)) {
      return { success: false, code: LanguageToolCode.TooLong };
    }
    if (this.running.has(request.requestId)) return { success: false, code: LanguageToolCode.Duplicate };
    const controller = new AbortController();
    this.running.set(request.requestId, controller);
    void this.stream(request, session, controller, send);
    return { success: true };
  }

  abort(id: string): void { this.running.get(id)?.abort(); this.running.delete(id); }
  reset(): void { for (const id of this.running.keys()) this.abort(id); }

  private async stream(request: LanguageToolRequest, session: string, controller: AbortController, send: (event: LanguageToolEvent) => void): Promise<void> {
    const emit = (event: LanguageToolEvent) => {
      if (session !== this.deps.getSessionKey()) { controller.abort(); return; }
      if (!controller.signal.aborted) send(event);
    };
    let ended = false;
    let timer = setTimeout(() => controller.abort(), 90_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.deps.fetchWithAuth(`${this.deps.getServerApiBaseUrl()}/api/desktop-tools/${request.tool}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.requestId, text: request.text, targetLanguage: request.targetLanguage ?? TranslationTarget.Auto }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        const body = await response.json().catch((): null => null) as { code?: number } | null;
        emit({ requestId: request.requestId, type: LanguageToolEventType.Error,
          code: body?.code ?? (response.status === 401 ? LanguageToolCode.Unauthorized : LanguageToolCode.Unavailable) });
        return;
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), 90_000);
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 12 * 1024 * 1024) throw new Error('Language event exceeds size limit');
        const parsed = splitSseEvents(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (!Object.values(LanguageToolEventType).includes(event.event as LanguageToolEvent['type'])) continue;
          const data = JSON.parse(event.data) as Record<string, unknown>;
          const type = event.event as LanguageToolEvent['type'];
          if (type === LanguageToolEventType.Done) ended = true;
          emit({ ...data, requestId: request.requestId, type } as LanguageToolEvent);
        }
      }
      if (!ended && !controller.signal.aborted) throw new Error('Language stream ended without completion');
    } catch {
      // Explicit cancellation removes the request; timeouts still surface an error.
      if (this.running.get(request.requestId) === controller && session === this.deps.getSessionKey()) {
        send({ requestId: request.requestId, type: LanguageToolEventType.Error, code: LanguageToolCode.Upstream });
      }
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch((): void => undefined);
      if (this.running.get(request.requestId) === controller) this.running.delete(request.requestId);
    }
  }
}
