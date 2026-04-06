import { Notification } from 'electron';

import { t } from './i18n';

// macOS notification body is rendered at roughly 50 characters per line in Banner
// style. Matching this keeps the toast clean without awkward mid-word wrapping.
const MAX_BODY_LENGTH = 50;

function truncateBody(text: string): string {
  if (text.length <= MAX_BODY_LENGTH) return text;
  return `${text.slice(0, MAX_BODY_LENGTH - 1)}\u2026`; // …
}

class NativeNotificationService {
  isSupported(): boolean {
    return Notification.isSupported();
  }

  /**
   * Fires when a cowork session finishes.
   * Layout (macOS):
   *   [App icon]  LobsterAI
   *               对话任务完成          ← subtitle
   *               {session title}      ← body (≤ 50 chars)
   */
  notifyCoworkComplete(sessionTitle: string): void {
    if (!Notification.isSupported()) return;
    new Notification({
      title: t('notifyTitle'),
      subtitle: t('notifyCoworkCompleteSubtitle'),
      body: truncateBody(sessionTitle),
    }).show();
  }

  /**
   * Fires when a scheduled task run completes.
   * Layout (macOS):
   *   [App icon]  LobsterAI
   *               定时任务执行完成       ← subtitle
   *               {task name}           ← body (≤ 50 chars)
   */
  notifyScheduledTaskComplete(taskName: string): void {
    if (!Notification.isSupported()) return;
    new Notification({
      title: t('notifyTitle'),
      subtitle: t('notifyScheduledTaskCompleteSubtitle'),
      body: truncateBody(taskName),
    }).show();
  }
}

let _instance: NativeNotificationService | null = null;

export function getNativeNotificationService(): NativeNotificationService {
  if (!_instance) _instance = new NativeNotificationService();
  return _instance;
}
