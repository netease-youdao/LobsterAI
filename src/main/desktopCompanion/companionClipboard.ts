import { clipboard } from 'electron';

import { COMPANION_COPY_MAX_BYTES, type CompanionCopyResult } from '../../shared/desktopCompanion/constants';
import { t } from '../i18n';

export function isCompanionTextTooLarge(text: string): boolean {
  // Reject obviously oversized strings before scanning their UTF-8 bytes.
  return text.length > COMPANION_COPY_MAX_BYTES || Buffer.byteLength(text, 'utf8') > COMPANION_COPY_MAX_BYTES;
}

export function copyCompanionText(value: unknown): CompanionCopyResult {
  if (typeof value !== 'string') return { success: false, error: t('desktopCompanionCopyFailed') };
  if (isCompanionTextTooLarge(value)) {
    return { success: false, error: t('desktopCompanionCopyTooLarge', { limit: COMPANION_COPY_MAX_BYTES / 1_000_000 }) };
  }
  try {
    clipboard.writeText(value);
    return { success: true };
  } catch (error) {
    console.error('[DesktopCompanion] Clipboard write failed:', error);
    return { success: false, error: t('desktopCompanionCopyFailed') };
  }
}
