import { CompanionAnalyticsOutcome as Outcome, CompanionAnalyticsSource,companionLanguageErrorReason } from '../../shared/desktopCompanion/analytics';
import {
  LANGUAGE_TOOL_DEVICE_HEADER, LANGUAGE_TRANSLATION_MAX_CHARS, LANGUAGE_TTS_MAX_CHARS,
  LanguageTool, LanguageToolCode, type LanguageToolEvent, LanguageToolEventType, type LanguageToolQuotas,
  type LanguageToolRequest, type LanguageToolResult, TranslationTarget,
} from '../../shared/desktopCompanion/languageTools';
import { CompanionAnalytics, type CompanionAnalyticsReporter } from './companionAnalytics';
import { splitSseEvents } from './sse';

interface LanguageClientDeps {
  reportAnalytics?: CompanionAnalyticsReporter;
  fetchWithAuth(url: string, options?: RequestInit): Promise<Response>;
  fetchAnonymous(url: string, options?: RequestInit): Promise<Response>;
  getInstallationId(): string | null;
  getServerApiBaseUrl(): string;
  getSessionKey(): string | null;
}

export class CompanionLanguageClient {
  private running = new Map<string, AbortController>();
  private readonly completions = new WeakMap<AbortController, ReturnType<CompanionAnalytics['tool']>>();
  private readonly analytics: CompanionAnalytics;
  constructor(private readonly deps: LanguageClientDeps) {
    this.analytics = new CompanionAnalytics(deps.reportAnalytics);
  }

  async quota(tool: LanguageTool): Promise<LanguageToolResult> {
    if (!Object.values(LanguageTool).includes(tool)) return { success: false, code: LanguageToolCode.InvalidInput };
    const session = this.deps.getSessionKey();
    if (!session && tool !== LanguageTool.Translate) return { success: false, code: LanguageToolCode.Unauthorized };
    const device = tool === LanguageTool.Translate ? this.deviceId() : null;
    if (tool === LanguageTool.Translate && !device) return { success: false, code: LanguageToolCode.Unavailable };
    try {
      const path = tool === LanguageTool.Translate ? 'translate/quota' : 'quota';
      const response = await this.fetch(session, `${this.deps.getServerApiBaseUrl()}/api/desktop-tools/${path}`, {
        headers: device ? { [LANGUAGE_TOOL_DEVICE_HEADER]: device } : {},
      });
      const body = await response.json().catch((): null => null) as { code?: number; data?: LanguageToolQuotas } | null;
      if (session !== this.deps.getSessionKey()) return { success: false, code: LanguageToolCode.Unauthorized };
      return response.ok && body?.code === 0 && body.data
        ? { success: true, data: body.data }
        : { success: false, code: this.errorCode(response.status, body?.code) };
    } catch { return { success: false, code: LanguageToolCode.Unavailable }; }
  }

  start(request: LanguageToolRequest, send: (event: LanguageToolEvent) => void): LanguageToolResult {
    const session = this.deps.getSessionKey();
    if (!request || !Object.values(LanguageTool).includes(request.tool)
      || typeof request.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.requestId)
      || typeof request.text !== 'string' || !request.text.trim()
      || (request.targetLanguage !== undefined && !Object.values(TranslationTarget).includes(request.targetLanguage))) {
      return { success: false, code: LanguageToolCode.InvalidInput };
    }
    const finish = this.analytics.tool({ source: CompanionAnalyticsSource.LanguageTools, tool: request.tool });
    const blocked = (code: number): LanguageToolResult => {
      finish(Outcome.Blocked, companionLanguageErrorReason(code));
      return { success: false, code };
    };
    if (!session && request.tool !== LanguageTool.Translate) return blocked(LanguageToolCode.Unauthorized);
    const device = request.tool === LanguageTool.Translate ? this.deviceId() : null;
    if (request.tool === LanguageTool.Translate && !device) return blocked(LanguageToolCode.Unavailable);
    if ([...request.text].length > (request.tool === LanguageTool.Translate ? LANGUAGE_TRANSLATION_MAX_CHARS : LANGUAGE_TTS_MAX_CHARS)) {
      return blocked(LanguageToolCode.TooLong);
    }
    if (this.running.has(request.requestId)) return blocked(LanguageToolCode.Duplicate);
    const controller = new AbortController();
    this.completions.set(controller, finish);
    this.running.set(request.requestId, controller);
    void this.stream(request, session, device, controller, send);
    return { success: true };
  }

  abort(id: string): void {
    const controller = this.running.get(id);
    if (controller) { this.completions.get(controller)?.(Outcome.Cancelled); controller.abort(); }
    this.running.delete(id);
  }
  reset(): void { for (const id of this.running.keys()) this.abort(id); }

  private deviceId(): string | null {
    const id = this.deps.getInstallationId();
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
  }

  private fetch(session: string | null, url: string, options: RequestInit): Promise<Response> {
    // A rejected authenticated request must never silently spend the device's guest allowance.
    return session ? this.deps.fetchWithAuth(url, options) : this.deps.fetchAnonymous(url, { ...options, credentials: 'omit' });
  }

  private errorCode(status: number, code?: number): number {
    // Normalize both controller and security-filter responses to the existing sign-in UI.
    if (status === 401 || code === 401 || code === LanguageToolCode.Unauthorized) return LanguageToolCode.Unauthorized;
    return code ?? LanguageToolCode.Unavailable;
  }

  private async stream(request: LanguageToolRequest, session: string | null, device: string | null, controller: AbortController, send: (event: LanguageToolEvent) => void): Promise<void> {
    const finish = this.completions.get(controller)!;
    const emit = (event: LanguageToolEvent) => {
      if (session !== this.deps.getSessionKey()) { controller.abort(); return; }
      if (!controller.signal.aborted) {
        if (event.type === LanguageToolEventType.Done) finish(Outcome.Success);
        if (event.type === LanguageToolEventType.Error) finish(Outcome.Failed, companionLanguageErrorReason(event.code));
        send(event);
      }
    };
    let ended = false;
    let timer = setTimeout(() => controller.abort(), 90_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetch(session, `${this.deps.getServerApiBaseUrl()}/api/desktop-tools/${request.tool}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(device ? { [LANGUAGE_TOOL_DEVICE_HEADER]: device } : {}) },
        body: JSON.stringify({ requestId: request.requestId, text: request.text, targetLanguage: request.targetLanguage ?? TranslationTarget.Auto }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        const body = await response.json().catch((): null => null) as { code?: number } | null;
        emit({ requestId: request.requestId, type: LanguageToolEventType.Error,
          code: this.errorCode(response.status, body?.code) });
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
        finish(Outcome.Failed, companionLanguageErrorReason(LanguageToolCode.Upstream));
        send({ requestId: request.requestId, type: LanguageToolEventType.Error, code: LanguageToolCode.Upstream });
      }
    } finally {
      finish(Outcome.Cancelled);
      clearTimeout(timer);
      await reader?.cancel().catch((): void => undefined);
      if (this.running.get(request.requestId) === controller) this.running.delete(request.requestId);
    }
  }
}
