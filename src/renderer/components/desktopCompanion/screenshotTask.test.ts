import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CompanionScreenshotAction } from '../../../shared/desktopCompanion/screenshot';
import { startCompanionTask } from './companionTasks';
import { createScreenshotTaskRunner, runScreenshotTask } from './screenshotTask';

vi.mock('./companionTasks', () => ({ startCompanionTask: vi.fn() }));
vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
const request = { id: 'capture', action: CompanionScreenshotAction.ExtractText, attachment: { path: '/capture.png', name: 'capture.png', isImage: true } };
beforeEach(() => vi.clearAllMocks());
describe('screenshot task routing', () => {
  test.each([
    [CompanionScreenshotAction.ExtractText, 'desktopCompanionDropOcrPrompt'],
    [CompanionScreenshotAction.Translate, 'desktopCompanionDropTranslatePrompt'],
  ] as const)('%s passes only its capture and the matching prompt', async (action, prompt) => {
    vi.mocked(startCompanionTask).mockResolvedValue({ sessionId: 'new-session' });
    await runScreenshotTask({ ...request, action });
    expect(startCompanionTask).toHaveBeenCalledExactlyOnceWith({ companionScreenshotRequestId: 'capture', prompt, attachments: [request.attachment] });
  });
  test('a failed handoff retries the notification without starting another task', async () => {
    vi.mocked(startCompanionTask).mockResolvedValue({ sessionId: 'new-session' });
    const notify = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const failed = vi.fn();
    const run = createScreenshotTaskRunner(request, notify, failed);
    await run();
    expect(failed).toHaveBeenCalledOnce();
    await failed.mock.calls[0][1]();
    expect(startCompanionTask).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith('capture', 'new-session');
  });
  test('repeated clicks while starting a task are ignored; a failed start remains retryable', async () => {
    let resolve!: (value: { error: string }) => void;
    vi.mocked(startCompanionTask).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const notify = vi.fn().mockResolvedValue(true);
    const failed = vi.fn();
    const run = createScreenshotTaskRunner(request, notify, failed);
    const pending = run(); await run();
    expect(startCompanionTask).toHaveBeenCalledOnce();
    resolve({ error: 'Model unavailable' }); await pending;
    expect(notify).not.toHaveBeenCalled();
    vi.mocked(startCompanionTask).mockResolvedValue({ sessionId: 'retry-session' });
    await failed.mock.calls[0][1]();
    expect(notify).toHaveBeenCalledWith('capture', 'retry-session');
  });
});
