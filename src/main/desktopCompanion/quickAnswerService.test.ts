import type { WebContents } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CompanionAnalyticsOutcome as Outcome, CompanionAnalyticsReason as Reason, CompanionAnalyticsSource as Source,
  CompanionAnalyticsStage as Stage } from '../../shared/desktopCompanion/analytics';
import { CompanionQuickAnswerErrorCode, CompanionQuickAnswerEventType, DesktopCompanionIpc } from '../../shared/desktopCompanion/constants';
import { CompanionSelectionAction } from '../../shared/desktopCompanion/selectionActions';
import { ModelPresetId, modelPresetModelId } from '../../shared/modelPresets/constants';
import { ApiFormat, OpenClawApi, ProviderName } from '../../shared/providers';
import type { ResolvedPresetModel } from '../libs/modelPresets';
import { type OneShotTarget, OneShotTargetError, resolveOneShotTarget } from '../libs/oneShotModelClient';
import { CompanionQuickAnswerService } from './quickAnswerService';

vi.mock('../libs/oneShotModelClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../libs/oneShotModelClient')>(),
  resolveOneShotTarget: vi.fn(),
}));
vi.mock('../i18n', () => ({ t: (key: string) => key, getLanguage: () => 'zh' }));

const upstreamKey = 'test-upstream-key';
const anthropicTarget = (overrides: Partial<OneShotTarget> = {}) => ({
  target: {
    api: OpenClawApi.AnthropicMessages,
    apiKey: upstreamKey,
    baseUrl: 'https://provider.example',
    model: 'test-model',
    providerName: 'custom_0',
    ...overrides,
  },
});
const noModel = () => ({ error: OneShotTargetError.NoModel });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveOneShotTarget).mockReturnValue(noModel());
});

describe('selection quick-answer authentication', () => {
  test.each([
    CompanionSelectionAction.Summarize,
    CompanionSelectionAction.Explain,
    CompanionSelectionAction.Ask,
  ])('requires a LobsterAI login before resolving a model or sending %s', action => {
    const resolveModel = vi.fn(() => anthropicTarget());
    const fetchMock = vi.fn<typeof fetch>();
    const service = new CompanionQuickAnswerService({ getSessionKey: () => null, resolveModel, fetch: fetchMock });
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() };
    expect(service.start(sender as unknown as WebContents, { requestId: 'signed-out', action, text: 'Hello' })).toEqual({
      success: false, code: CompanionQuickAnswerErrorCode.LoginRequired, error: 'desktopToolsLoginRequired',
    });
    expect(resolveModel).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    service.dispose();
  });

  test('only reports a missing model after login and checks credentials again on each request', () => {
    let session: string | null = null;
    const resolveModel = vi.fn(noModel);
    const service = new CompanionQuickAnswerService({ getSessionKey: () => session, resolveModel, fetch: vi.fn() });
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const request = { requestId: 'summary', action: CompanionSelectionAction.Summarize, text: 'Hello' };
    expect(service.start(sender, request).code).toBe(CompanionQuickAnswerErrorCode.LoginRequired);
    session = 'signed-in';
    expect(service.start(sender, request)).toEqual({ success: false, error: 'desktopCompanionAnswerNoModel' });
    session = null;
    expect(service.start(sender, request).code).toBe(CompanionQuickAnswerErrorCode.LoginRequired);
    expect(resolveModel).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  test('requires login when no credential source is configured', () => {
    const service = new CompanionQuickAnswerService();
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    expect(service.start(sender, { requestId: 'ask', action: CompanionSelectionAction.Ask, text: 'Hello' }).code)
      .toBe(CompanionQuickAnswerErrorCode.LoginRequired);
    expect(resolveOneShotTarget).not.toHaveBeenCalled();
    service.dispose();
  });

  test('resolves the current model with the loopback proxy token', () => {
    const service = new CompanionQuickAnswerService({ getSessionKey: () => 'signed-in', getProxyToken: () => 'loopback-token' });
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    service.start(sender, { requestId: 'ask', action: CompanionSelectionAction.Ask, text: 'Hello' });
    const { getProxyToken } = vi.mocked(resolveOneShotTarget).mock.calls[0][0];
    expect(getProxyToken()).toBe('loopback-token');
    service.dispose();
  });

  test('explains when the current model cannot serve quick answers', () => {
    const service = new CompanionQuickAnswerService({
      getSessionKey: () => 'signed-in',
      resolveModel: () => ({ error: OneShotTargetError.UnsupportedModel }),
      fetch: vi.fn(),
    });
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    expect(service.start(sender, { requestId: 'ask', action: CompanionSelectionAction.Ask, text: 'Hello' }))
      .toEqual({ success: false, error: 'desktopCompanionAnswerUnsupportedModel' });
    service.dispose();
  });
});

describe('translation follow-up through quick answers', () => {
  test.each([Outcome.Success, Outcome.Failed, Outcome.Cancelled])('reports a single %s result without selected text, model URL or streaming chunks', async outcome => {
    const reportAnalytics = vi.fn();
    let release!: (response: Response) => void;
    const service = new CompanionQuickAnswerService({ getSessionKey: () => 'account-secret', reportAnalytics,
      resolveModel: () => anthropicTarget({ baseUrl: 'https://private.example', model: 'model' }),
      fetch: () => new Promise(resolve => { release = resolve; }),
    });
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    service.start(sender, { requestId: 'private-request', action: CompanionSelectionAction.Ask, text: 'private selection',
      history: [{ role: 'user', content: 'private question' }] }, Source.LanguageTools);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (outcome === Outcome.Cancelled) service.abortOwnedBy(sender.id);
    release(outcome === Outcome.Failed ? new Response('private error', { status: 500 }) : new Response(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"private answer"}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    ));
    await vi.waitFor(() => expect(reportAnalytics).toHaveBeenCalledTimes(2));
    // Allow a cancelled transport's late completion to run before checking deduplication.
    await new Promise(resolve => setTimeout(resolve, 10));
    service.dispose();
    expect(reportAnalytics.mock.calls.map(([event]) => event.stage)).toEqual([Stage.Submit, Stage.Result]);
    expect(reportAnalytics.mock.lastCall?.[0]).toMatchObject({ outcome, source: Source.LanguageTools, isFollowUp: true });
    expect(JSON.stringify(reportAnalytics.mock.calls)).not.toMatch(/private|account-secret|test-upstream-key/);
  });

  test('reports login and model preflight blocks as results', () => {
    const reportAnalytics = vi.fn();
    let session: string | null = null;
    const service = new CompanionQuickAnswerService({ getSessionKey: () => session, reportAnalytics, resolveModel: noModel });
    const sender = { id: 31 } as WebContents;
    const request = { requestId: 'test', action: CompanionSelectionAction.Ask, text: 'private' };
    service.start(sender, request);
    session = 'account';
    service.start(sender, request);
    expect(reportAnalytics.mock.calls.map(([event]) => event).filter(event => event.stage === Stage.Result)).toEqual([
      expect.objectContaining({ outcome: Outcome.Blocked, reason: Reason.LoginRequired }),
      expect.objectContaining({ outcome: Outcome.Blocked, reason: Reason.NoModel }),
    ]);
  });
  test('sends the selection, translation and previous turns together and streams to the owning card', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"另一种译法"}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    ));
    const service = new CompanionQuickAnswerService({
      getSessionKey: () => 'signed-in',
      resolveModel: () => anthropicTarget(),
      fetch: fetchMock,
    });
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() };
    const history = [
      { role: 'assistant' as const, content: '你好，世界。' },
      { role: 'user' as const, content: '解释一下这个译法' },
      { role: 'assistant' as const, content: '这是一句问候语。' },
      { role: 'user' as const, content: '还可以怎么说？' },
    ];
    try {
      expect(service.start(sender as unknown as WebContents, {
        requestId: 'follow-up', action: CompanionSelectionAction.Ask, text: 'Hello, world.', history,
      })).toEqual({ success: true });
      await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent,
        { requestId: 'follow-up', type: CompanionQuickAnswerEventType.Done }));
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body.messages).toEqual([{ role: 'user', content: '<selected_text>\nHello, world.\n</selected_text>' }, ...history]);
      expect(body.system).toContain('追问');
      expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent,
        { requestId: 'follow-up', type: CompanionQuickAnswerEventType.Delta, text: '另一种译法' });
    } finally { service.dispose(); }
  });

  test('streams OpenAI Responses deltas from a Responses-mode model', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"答案"}\n\n'
      + 'data: {"type":"response.completed"}\n\n',
    ));
    const service = new CompanionQuickAnswerService({
      getSessionKey: () => 'signed-in',
      resolveModel: () => anthropicTarget({ api: OpenClawApi.OpenAIResponses, baseUrl: 'https://gw.example/v1' }),
      fetch: fetchMock,
    });
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() };
    try {
      service.start(sender as unknown as WebContents, { requestId: 'responses', action: CompanionSelectionAction.Ask, text: 'Hi' });
      await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent,
        { requestId: 'responses', type: CompanionQuickAnswerEventType.Done }));
      expect(fetchMock.mock.calls[0][0]).toBe('https://gw.example/v1/responses');
      expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent,
        { requestId: 'responses', type: CompanionQuickAnswerEventType.Delta, text: '答案' });
    } finally { service.dispose(); }
  });

  test('keeps initial translation on the server API instead of the configured conversation model', () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = new CompanionQuickAnswerService({ getSessionKey: () => 'signed-in', resolveModel: noModel, fetch: fetchMock });
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() };
    expect(service.start(sender as unknown as WebContents, {
      requestId: 'initial-translation', action: CompanionSelectionAction.Translate, text: 'Hello',
    }).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe('quick-answer model presets', () => {
  const resolvedModel = { modelId: 'resolved-model', apiFormat: ApiFormat.OpenAI };
  const sse = () => new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n');
  const presetTarget = (presetId: ModelPresetId = ModelPresetId.Balanced) => anthropicTarget({
    providerName: ProviderName.LobsteraiServer, model: modelPresetModelId(presetId), api: OpenClawApi.OpenAICompletions,
  });
  const sender = () => ({ id: 31, isDestroyed: () => false, send: vi.fn() });
  const request = { requestId: 'preset-answer', action: CompanionSelectionAction.Summarize, text: 'Selected text' };

  test.each(Object.values(ModelPresetId).flatMap(presetId => [CompanionSelectionAction.Summarize,
    CompanionSelectionAction.Explain, CompanionSelectionAction.Polish, CompanionSelectionAction.Ask]
    .map(action => ({ presetId, action }))))('resolves $presetId before $action', async ({ presetId, action }) => {
    const resolvePreset = vi.fn().mockResolvedValue(resolvedModel);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => sse());
    const owner = sender();
    const service = new CompanionQuickAnswerService({ getSessionKey: () => 'signed-in',
      resolveModel: () => presetTarget(presetId), resolvePreset, fetch: fetchMock });
    const history = action === CompanionSelectionAction.Ask ? [{ role: 'assistant' as const, content: 'Translation' },
      { role: 'user' as const, content: 'Explain the translation' }] : [];
    try {
      expect(service.start(owner as unknown as WebContents, { ...request, action, history })).toEqual({ success: true });
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent,
        expect.objectContaining({ type: CompanionQuickAnswerEventType.Done })));
      expect(resolvePreset).toHaveBeenCalledWith(presetId, expect.any(AbortSignal));
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body.model).toBe(resolvedModel.modelId);
      if (history.length) expect(body.messages).toEqual(expect.arrayContaining(history));
    } finally { service.dispose(); }
  });

  test.each(['cancel', 'account-change', 'replacement'] as const)('does not dispatch a late resolution after %s', async reason => {
    let resolve!: (model: ResolvedPresetModel) => void;
    let account = 'first-account';
    const resolvePreset = vi.fn(() => new Promise<ResolvedPresetModel>(done => { resolve = done; }));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => sse());
    const owner = sender();
    const service = new CompanionQuickAnswerService({ getSessionKey: () => account,
      resolveModel: () => presetTarget(), resolvePreset, fetch: fetchMock });
    service.start(owner as unknown as WebContents, request);
    const oldResolve = resolve;
    if (reason === 'cancel') service.abortOwnedBy(owner.id);
    if (reason === 'account-change') account = 'second-account';
    if (reason === 'replacement') service.start(owner as unknown as WebContents, request);
    oldResolve(resolvedModel);
    await new Promise(done => setTimeout(done, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalled();
    if (reason === 'replacement') {
      resolve(resolvedModel);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    }
    service.dispose();
  });

  test('reports a resolve failure once without falling back to the virtual model', async () => {
    const fetchMock = vi.fn();
    const owner = sender();
    const reportAnalytics = vi.fn();
    const service = new CompanionQuickAnswerService({ getSessionKey: () => 'signed-in', reportAnalytics,
      resolveModel: () => presetTarget(), resolvePreset: async () => { throw new Error('Resolve unavailable'); }, fetch: fetchMock });
    service.start(owner as unknown as WebContents, request);
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent,
      expect.objectContaining({ type: CompanionQuickAnswerEventType.Error })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportAnalytics.mock.calls.filter(([event]) => event.stage === Stage.Result)).toHaveLength(1);
    expect(reportAnalytics.mock.lastCall?.[0]).toMatchObject({ outcome: Outcome.Failed });
    service.dispose();
  });

  test('uses the existing localized error for an invalid preset resolution', async () => {
    const owner = sender();
    const fetchMock = vi.fn();
    const service = new CompanionQuickAnswerService({ getSessionKey: () => 'signed-in',
      resolveModel: () => presetTarget(), resolvePreset: async () => ({ ...resolvedModel,
        modelId: modelPresetModelId(ModelPresetId.Balanced) }), fetch: fetchMock });
    service.start(owner as unknown as WebContents, request);
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent,
      { requestId: request.requestId, type: CompanionQuickAnswerEventType.Error, message: 'desktopCompanionAnswerUnsupportedModel' }));
    expect(fetchMock).not.toHaveBeenCalled();
    service.dispose();
  });

  test('includes preset resolution in the request timeout and never dispatches after it', async () => {
    vi.useFakeTimers();
    const owner = sender();
    const fetchMock = vi.fn();
    const reportAnalytics = vi.fn();
    const service = new CompanionQuickAnswerService({ getSessionKey: () => 'signed-in', reportAnalytics,
      resolveModel: () => presetTarget(), resolvePreset: (_preset, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }), fetch: fetchMock });
    try {
      service.start(owner as unknown as WebContents, request);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(owner.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent,
        expect.objectContaining({ type: CompanionQuickAnswerEventType.Error }));
      expect(reportAnalytics.mock.calls.filter(([event]) => event.stage === Stage.Result)).toHaveLength(1);
      expect(reportAnalytics.mock.lastCall?.[0]).toMatchObject({ outcome: Outcome.Failed });
    } finally { service.dispose(); vi.useRealTimers(); }
  });
});
