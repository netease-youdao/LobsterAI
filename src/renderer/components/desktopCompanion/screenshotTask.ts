import { CompanionDropAction, companionDropCopyKeys } from '../../../shared/desktopCompanion/fileKinds';
import { CompanionScreenshotAction } from '../../../shared/desktopCompanion/screenshot';
import type { ScreenshotTaskRequest } from '../../../shared/desktopCompanion/screenshotTask';
import { i18nService } from '../../services/i18n';
import { startCompanionTask } from './companionTasks';

/** Image actions create their own task and leave the unsent composer draft intact. */
export function runScreenshotTask(request: ScreenshotTaskRequest): Promise<{ sessionId: string } | { error: string }> {
  const action = request.action === CompanionScreenshotAction.ExtractText ? CompanionDropAction.Ocr : CompanionDropAction.Translate;
  return startCompanionTask({
    companionScreenshotRequestId: request.id,
    prompt: i18nService.t(companionDropCopyKeys(action).prompt),
    attachments: [request.attachment],
  });
}

/** A failed notification retries only the handoff once a task has already started. */
export function createScreenshotTaskRunner(
  request: ScreenshotTaskRequest,
  notify: (requestId: string, sessionId: string) => Promise<boolean>,
  failed: (message: string, retry: () => Promise<void>) => void,
): () => Promise<void> {
  let inFlight = false;
  let sessionId: string | undefined;
  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (!sessionId) {
        const result = await runScreenshotTask(request);
        if ('error' in result) throw new Error(result.error);
        sessionId = result.sessionId;
      }
      if (!await notify(request.id, sessionId)) throw new Error(i18nService.t('desktopCompanionRequestFailed'));
    } catch (error) {
      failed(error instanceof Error ? error.message : i18nService.t('desktopCompanionRequestFailed'), run);
    } finally { inFlight = false; }
  };
  return run;
}
