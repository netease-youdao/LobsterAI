import { afterEach, expect, it, vi } from 'vitest';

import { requestFollowUpSuggestion } from './followUpSuggestion';

afterEach(() => vi.unstubAllGlobals());
const context = { key: 'turn', question: 'Question', answer: 'Answer' };

it('passes only bounded exchange data to main and drops stale account responses', async () => {
  let current = true;
  const suggestFollowUp = vi.fn(async () => { current = false; return 'Show me the next step.'; });
  vi.stubGlobal('window', { electron: { cowork: { suggestFollowUp } } });
  expect(await requestFollowUpSuggestion(context, 'en', () => current)).toBeNull();
  expect(suggestFollowUp).toHaveBeenCalledWith({ question: 'Question', answer: 'Answer', language: 'en' });
});

it('fails silently for missing configuration, malformed output, and IPC errors', async () => {
  const suggestFollowUp = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('a\nb').mockRejectedValueOnce(new Error('offline'));
  vi.stubGlobal('window', { electron: { cowork: { suggestFollowUp } } });
  for (let index = 0; index < 3; index++) expect(await requestFollowUpSuggestion(context, 'en')).toBeNull();
});
