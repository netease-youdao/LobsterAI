import { expect, test, vi } from 'vitest';

import { PromptAnalyticsConversationState, PromptAnalyticsSurface } from '../../../shared/analytics/constants';
import { getPromptAnalyticsConversationState, getPromptAnalyticsSurface } from './promptAnalytics';

vi.mock('../../services/logReporter', () => ({ reportYdAnalyzer: vi.fn(), LogReporterAction: {} }));
vi.mock('../../services/skill', () => ({ resolveLocalizedText: vi.fn() }));

test('keeps companion new-task input out of the home funnel without changing conversation state', () => {
  expect(getPromptAnalyticsSurface()).toBe(PromptAnalyticsSurface.Home);
  expect(getPromptAnalyticsSurface('session')).toBe(PromptAnalyticsSurface.Conversation);
  expect(getPromptAnalyticsSurface(undefined, PromptAnalyticsSurface.DesktopCompanion)).toBe(PromptAnalyticsSurface.DesktopCompanion);
  expect(getPromptAnalyticsConversationState()).toBe(PromptAnalyticsConversationState.NewTask);
});
