import type { WebContents } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CompanionQuickAnswerEventType, DesktopCompanionIpc } from '../../shared/desktopCompanion/constants';
import { buildCompanionQuickAnswerPrompt, CompanionSelectionAction } from '../../shared/desktopCompanion/selectionActions';
import { ApiFormat, ProviderName } from '../../shared/providers/constants';
import { resolveCurrentApiConfig, resolveRawApiConfig } from '../libs/claudeSettings';
import { CoworkModelProtocol } from '../libs/coworkModelApi';
import { getCoworkOpenAICompatProxyToken } from '../libs/coworkOpenAICompatProxy';
import { buildQuickAnswerHttpRequest, CompanionQuickAnswerService, resolveQuickAnswerModel } from './quickAnswerService';

vi.mock('../libs/claudeSettings', () => ({ resolveCurrentApiConfig: vi.fn(), resolveRawApiConfig: vi.fn() }));
vi.mock('../libs/coworkOpenAICompatProxy', () => ({ getCoworkOpenAICompatProxyToken: vi.fn() }));
vi.mock('../i18n', () => ({ t: (key: string) => key, getLanguage: () => 'zh' }));

const prompt = buildCompanionQuickAnswerPrompt({ action: CompanionSelectionAction.Ask, text: 'Hello', language: 'zh' });
const upstreamKey = 'test-upstream-key';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveRawApiConfig).mockReturnValue({ config: null });
  vi.mocked(getCoworkOpenAICompatProxyToken).mockReturnValue('test-local-token');
});

describe('selection quick-answer authentication', () => {
  test('authenticates a local compatibility proxy separately from the upstream provider', () => {
    vi.mocked(resolveCurrentApiConfig).mockReturnValue({
      config: { apiKey: upstreamKey, baseURL: 'http://127.0.0.1:9876', model: 'test-model', apiType: ApiFormat.OpenAI },
    });
    const model = resolveQuickAnswerModel();
    expect(model).not.toBeNull();
    const request = buildQuickAnswerHttpRequest(model!, prompt);
    expect(request.url).toBe('http://127.0.0.1:9876/v1/messages');
    const headers = new Headers(request.init.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-local-token');
    expect(headers.get('x-api-key')).toBe(upstreamKey);
  });

  test('never sends a local proxy token to a direct Anthropic or Gemini provider', () => {
    vi.mocked(resolveCurrentApiConfig).mockReturnValue({
      config: { apiKey: upstreamKey, baseURL: 'https://provider.example', model: 'test-model', apiType: ApiFormat.Anthropic },
    });
    const anthropic = buildQuickAnswerHttpRequest(resolveQuickAnswerModel()!, prompt);
    expect(new Headers(anthropic.init.headers).get('Authorization')).toBeNull();

    vi.mocked(resolveRawApiConfig).mockReturnValue({
      config: { apiKey: upstreamKey, baseURL: 'https://generativelanguage.googleapis.com', model: 'test-model' },
      providerMetadata: { providerName: ProviderName.Gemini, codingPlanEnabled: false },
    });
    const gemini = buildQuickAnswerHttpRequest(resolveQuickAnswerModel()!, prompt);
    const headers = new Headers(gemini.init.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('x-goog-api-key')).toBe(upstreamKey);
    expect(getCoworkOpenAICompatProxyToken).not.toHaveBeenCalled();
  });
});

describe('translation follow-up through quick answers', () => {
  test('sends the selection, translation and previous turns together and streams to the owning card', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"另一种译法"}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    ));
    const service = new CompanionQuickAnswerService({
      resolveModel: () => ({ protocol: CoworkModelProtocol.Anthropic, apiKey: upstreamKey, baseURL: 'https://provider.example', model: 'test-model' }),
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

  test('keeps initial translation on the server API instead of the configured conversation model', () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = new CompanionQuickAnswerService({ resolveModel: () => null, fetch: fetchMock });
    const sender = { id: 31, isDestroyed: () => false, send: vi.fn() };
    expect(service.start(sender as unknown as WebContents, {
      requestId: 'initial-translation', action: CompanionSelectionAction.Translate, text: 'Hello',
    }).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    service.dispose();
  });
});
