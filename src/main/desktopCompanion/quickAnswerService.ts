import type { WebContents } from 'electron';

import { CompanionAnalyticsOutcome as Outcome, CompanionAnalyticsReason as Reason, CompanionAnalyticsSource } from '../../shared/desktopCompanion/analytics';
import {
  CompanionQuickAnswerErrorCode,
  type CompanionQuickAnswerEvent,
  CompanionQuickAnswerEventType,
  type CompanionQuickAnswerRequest,
  type CompanionQuickAnswerResult,
  DesktopCompanionIpc,
} from '../../shared/desktopCompanion/constants';
import {
  buildCompanionQuickAnswerPrompt,
  COMPANION_SELECTION_MAX_CHARS,
  type CompanionQuickAnswerPrompt,
  CompanionSelectionAction,
  isCompanionSelectionAction,
} from '../../shared/desktopCompanion/selectionActions';
import { getLanguage, t } from '../i18n';
import { extractApiErrorSnippet } from '../libs/coworkModelApi';
import {
  buildOneShotHttpRequest,
  type OneShotTarget,
  OneShotTargetError,
  type OneShotTargetResolution,
  readOneShotStreamEvent,
  resolveOneShotTarget,
} from '../libs/oneShotModelClient';
import { splitSseEvents, type StreamChunk } from '../libs/sse';
import { CompanionAnalytics, type CompanionAnalyticsReporter } from './companionAnalytics';

const MAX_OUTPUT_TOKENS = 2_048;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_HISTORY_TURNS = 12;

interface Running {
  controller: AbortController;
  ownerId: number;
  finish: ReturnType<CompanionAnalytics['tool']>;
}

interface QuickAnswerDeps {
  reportAnalytics?: CompanionAnalyticsReporter;
  getSessionKey(): string | null;
  /** Loopback token for providers OpenClaw reaches through a local proxy. */
  getProxyToken?(): string | null;
  resolveModel?(): OneShotTargetResolution;
  fetch?: typeof fetch;
}

/**
 * Streams short, sessionless answers for the selection toolbar. These do not
 * go through the agent: they need no tools, should start in about a second,
 * and must not add a session for every translated sentence.
 */
export class CompanionQuickAnswerService {
  private running = new Map<string, Running>();
  private readonly analytics: CompanionAnalytics;

  constructor(private readonly deps: QuickAnswerDeps = { getSessionKey: () => null }) {
    this.analytics = new CompanionAnalytics(deps.reportAnalytics);
  }

  start(sender: WebContents, request: CompanionQuickAnswerRequest, source: CompanionAnalyticsSource = CompanionAnalyticsSource.Selection): CompanionQuickAnswerResult {
    const finish = isCompanionSelectionAction(request?.action) ? this.analytics.tool({
      source, tool: request.action, isFollowUp: (typeof request.question === 'string' && !!request.question.trim())
        || (Array.isArray(request.history) && request.history.length > 0),
    }) : undefined;
    if (!this.deps.getSessionKey()) {
      finish?.(Outcome.Blocked, Reason.LoginRequired);
      return { success: false, code: CompanionQuickAnswerErrorCode.LoginRequired, error: t('desktopToolsLoginRequired') };
    }
    const requestId = typeof request?.requestId === 'string' ? request.requestId.slice(0, 100) : '';
    const text = typeof request?.text === 'string' ? request.text.trim() : '';
    if (!requestId || !text || !isCompanionSelectionAction(request.action) || request.action === CompanionSelectionAction.Translate) {
      finish?.(Outcome.Blocked, Reason.InvalidInput);
      return { success: false, error: t('desktopCompanionRequestFailed') };
    }
    const resolution = this.deps.resolveModel
      ? this.deps.resolveModel()
      : resolveOneShotTarget({ getProxyToken: () => this.deps.getProxyToken?.() ?? null });
    if ('error' in resolution) {
      finish?.(Outcome.Blocked, Reason.NoModel);
      return {
        success: false,
        error: t(resolution.error === OneShotTargetError.UnsupportedModel
          ? 'desktopCompanionAnswerUnsupportedModel'
          : 'desktopCompanionAnswerNoModel'),
      };
    }
    const history = Array.isArray(request.history)
      ? request.history.filter(turn => turn && typeof turn.content === 'string').slice(-MAX_HISTORY_TURNS)
      : [];
    const prompt = buildCompanionQuickAnswerPrompt({
      action: request.action,
      text: text.slice(0, COMPANION_SELECTION_MAX_CHARS),
      question: typeof request.question === 'string' ? request.question.slice(0, 4_000) : undefined,
      history,
      language: getLanguage(),
    });
    this.abort(requestId);
    const controller = new AbortController();
    this.running.set(requestId, { controller, ownerId: sender.id, finish: finish! });
    void this.stream(sender, requestId, resolution.target, prompt, controller);
    return { success: true };
  }

  abort(requestId: string): void {
    this.running.get(requestId)?.finish(Outcome.Cancelled);
    this.running.get(requestId)?.controller.abort();
    this.running.delete(requestId);
  }

  abortOwnedBy(ownerId: number): void {
    for (const [requestId, running] of this.running) {
      if (running.ownerId === ownerId) this.abort(requestId);
    }
  }

  dispose(): void {
    for (const requestId of [...this.running.keys()]) this.abort(requestId);
  }

  private async stream(
    sender: WebContents,
    requestId: string,
    target: OneShotTarget,
    prompt: CompanionQuickAnswerPrompt,
    controller: AbortController,
  ): Promise<void> {
    const finish = this.running.get(requestId)!.finish;
    const send = (event: CompanionQuickAnswerEvent) => {
      if (event.type === CompanionQuickAnswerEventType.Done) finish(Outcome.Success);
      if (event.type === CompanionQuickAnswerEventType.Error) finish(Outcome.Failed, Reason.Upstream);
      if (!sender.isDestroyed()) sender.send(DesktopCompanionIpc.QuickAnswerEvent, event);
    };
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const { url, init } = buildOneShotHttpRequest(target, {
        system: prompt.system,
        messages: prompt.messages,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
      const response = await (this.deps.fetch ?? fetch)(url, { ...init, signal: controller.signal });
      if (!response.ok || !response.body) {
        const detail = extractApiErrorSnippet(await response.text().catch(() => '')) || `HTTP ${response.status}`;
        send({ requestId, type: CompanionQuickAnswerEventType.Error, message: t('desktopCompanionAnswerFailed', { error: detail }) });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = splitSseEvents(buffer);
        buffer = rest;
        for (const event of events) {
          const chunk: StreamChunk = readOneShotStreamEvent(target.api, event);
          if (chunk.error) {
            send({ requestId, type: CompanionQuickAnswerEventType.Error, message: t('desktopCompanionAnswerFailed', { error: chunk.error }) });
            return;
          }
          if (chunk.text) send({ requestId, type: CompanionQuickAnswerEventType.Delta, text: chunk.text });
        }
      }
      send({ requestId, type: CompanionQuickAnswerEventType.Done });
    } catch (error) {
      if (controller.signal.aborted && this.running.get(requestId)?.controller !== controller) return;
      const message = controller.signal.aborted ? 'timeout' : error instanceof Error ? error.message : String(error);
      console.warn('[DesktopCompanion] Quick answer failed:', message);
      send({ requestId, type: CompanionQuickAnswerEventType.Error, message: t('desktopCompanionAnswerFailed', { error: message }) });
    } finally {
      clearTimeout(timeout);
      if (this.running.get(requestId)?.controller === controller) this.running.delete(requestId);
    }
  }
}
