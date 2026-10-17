import type { DesktopCompanionAttachment } from './constants';
import { CompanionScreenshotAction } from './screenshot';

export const ScreenshotTaskIpc = {
  Consume: 'desktop-companion:screenshot:consume-task',
  Started: 'desktop-companion:screenshot:task-started',
} as const;

export interface ScreenshotTaskRequest {
  id: string;
  action: typeof CompanionScreenshotAction.ExtractText | typeof CompanionScreenshotAction.Translate;
  attachment: DesktopCompanionAttachment;
}

export interface ScreenshotTaskBridge {
  consumeScreenshotRequest(id: string): Promise<ScreenshotTaskRequest | null>;
  screenshotTaskStarted(requestId: string, sessionId: string): Promise<boolean>;
}
