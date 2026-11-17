import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { DesktopCompanionState } from '../../../shared/desktopCompanion/constants';
import { LanguageTool, LanguageToolCode, LanguageToolErrorReason, type LanguageToolQuota, SpeechStatus, TranslationTarget } from '../../../shared/desktopCompanion/languageTools';
import { languageToolsTranslations } from '../../../shared/desktopCompanion/languageToolsCopy';
import LanguageToolsSurface from './LanguageToolsSurface';
import type { useLanguageTools } from './useLanguageTools';

const mocks = vi.hoisted(() => ({ tools: {} as ReturnType<typeof useLanguageTools>, language: 'zh' as 'zh' | 'en' }));
vi.mock('./useLanguageTools', () => ({ useLanguageTools: () => mocks.tools }));
vi.mock('./useTranslationFollowUp', () => ({ useTranslationFollowUp: () => ({ turns: [], loginRequired: false }) }));
vi.mock('./useMeasuredSurface', () => ({ useMeasuredSurface: () => {} }));
vi.mock('./usePointerPassThrough', () => ({ usePointerPassThrough: () => {} }));
vi.mock('./analytics', () => ({ reportCompanionAnalytics: vi.fn() }));
vi.mock('../../services/auth', () => ({ authService: {} }));
vi.mock('../../services/config', () => ({ configService: {} }));
vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => {
  const dictionary = languageToolsTranslations[mocks.language] as Record<string, string>;
  return dictionary[key] ?? key;
} } }));
vi.mock('./SelectionCard', () => ({
  SelectionAnswer: () => null, SelectionCardHeader: () => null, SelectionComposer: () => null,
  SelectionError: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message),
  SelectionThinking: () => null, SourceQuote: () => null, StopGlyph: () => null,
}));

const guestQuota: LanguageToolQuota = {
  usageDate: '2026-11-06', usedRequests: 20, limitRequests: 20, remainingRequests: 0,
  usedCharacters: 100, limitCharacters: null, remainingCharacters: null, resetsAt: '2026-11-07T00:00:00+08:00',
  unlimitedRequests: false, unlimitedAfterLogin: true,
};
const quotas = (translate = guestQuota) => ({ tools: { translate }, translationMaxCharacters: 5000, ttsMaxCharacters: 100000 });
const render = () => renderToStaticMarkup(createElement(LanguageToolsSurface, { state: {} as DesktopCompanionState }));

beforeEach(() => {
  vi.stubGlobal('window', { electron: { desktopCompanion: {} } });
  mocks.language = 'zh';
  mocks.tools = {
    input: { id: 'selection', tool: LanguageTool.Translate, text: 'Hello' }, target: TranslationTarget.Chinese,
    translation: '你好', translating: false, error: null, errorTool: null, errorDetail: null, quota: quotas(),
    playback: { status: SpeechStatus.Idle, index: 0, completed: 0, total: 0 },
  } as ReturnType<typeof useLanguageTools>;
});
afterEach(() => vi.unstubAllGlobals());

test('the twentieth result remains visible alongside the sign-in benefit', () => {
  const html = render();
  expect(html).toContain('你好');
  expect(html).toContain('今日 20 次免登录翻译已用完');
  expect(html).toContain('登录后翻译不限每日次数');
  expect(html).toContain('登录并继续翻译');
  expect(html).not.toContain('role="alert"');
});

test('the twenty-first rejection uses its server quota and English login copy', () => {
  mocks.language = 'en';
  mocks.tools.translation = '';
  mocks.tools.error = LanguageToolCode.Unauthorized;
  mocks.tools.errorTool = LanguageTool.Translate;
  mocks.tools.errorDetail = { reason: LanguageToolErrorReason.AnonymousTranslationDailyLimit, quota: quotas() };
  mocks.tools.quota = null;
  const html = render();
  expect(html).toContain('All 20 guest translations for today have been used');
  expect(html).toContain('Sign in for translations with no daily limit');
});

test('old servers, remaining guest allowance and signed-in accounts do not show an exhaustion offer', () => {
  for (const quota of [
    { ...guestQuota, unlimitedAfterLogin: undefined },
    { ...guestQuota, usedRequests: 19, remainingRequests: 1 },
    { ...guestQuota, usedRequests: 1001, limitRequests: 2147483647, remainingRequests: 2147482646, unlimitedRequests: true, unlimitedAfterLogin: false },
  ]) {
    mocks.tools.quota = quotas(quota);
    expect(render()).not.toContain('免登录翻译已用完');
  }
});

test('ordinary authentication errors do not reuse an old exhausted quota as the reason', () => {
  mocks.tools.error = LanguageToolCode.Unauthorized;
  mocks.tools.errorTool = LanguageTool.Translate;
  const html = render();
  expect(html).toContain('登录后即可使用');
  expect(html).not.toContain('免登录翻译已用完');
});

test('an explicit server rollback does not promise unlimited translations', () => {
  mocks.tools.error = LanguageToolCode.Unauthorized;
  mocks.tools.errorTool = LanguageTool.Translate;
  mocks.tools.errorDetail = { reason: LanguageToolErrorReason.AnonymousTranslationDailyLimit,
    quota: quotas({ ...guestQuota, unlimitedAfterLogin: false }) };
  const html = render();
  expect(html).toContain('登录后可继续翻译');
  expect(html).not.toContain('不限每日次数');
});

test('legacy daily-limit errors no longer claim a hardcoded thousand requests', () => {
  mocks.tools.error = LanguageToolCode.DailyLimit;
  mocks.tools.errorTool = LanguageTool.Translate;
  const html = render();
  expect(html).toContain('今日翻译次数已用完');
  expect(html).not.toContain('1,000');
  expect(html).not.toContain('登录并继续翻译');
});
