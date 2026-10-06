import type { ShellOpenFailureReason as ShellOpenFailureReasonType } from '../../shared/shell/constants';
import { ShellOpenFailureReason } from '../../shared/shell/constants';
import { i18nService } from '../services/i18n';

export interface ShellActionResult {
  success: boolean;
  error?: string;
  reason?: ShellOpenFailureReasonType;
}

export const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

export const getShellFailureMessage = (
  result: ShellActionResult | undefined | null,
  fallbackKey: string,
): string => {
  switch (result?.reason) {
    case ShellOpenFailureReason.NotFound:
      return i18nService.t('localFileNotFound');
    case ShellOpenFailureReason.PermissionDenied:
      return i18nService.t('localFilePermissionDenied');
    case ShellOpenFailureReason.OpenFailed:
    case ShellOpenFailureReason.Unknown:
    default:
      return result?.error || i18nService.t(fallbackKey);
  }
};

export const showShellFailureToast = (
  result: ShellActionResult | undefined | null,
  fallbackKey = 'openFileFailed',
): void => {
  showToast(getShellFailureMessage(result, fallbackKey));
};

const logLocalFileActionFailure = (
  operation: string,
  filePath: string,
  result: ShellActionResult | undefined | null,
): void => {
  console.warn(
    `[LocalFileActions] failed to ${operation} local path because ${result?.reason || 'the shell request failed'}:`,
    filePath,
    result?.error,
  );
  try {
    window.electron?.log?.fromRenderer?.(
      'warn',
      'LocalFileActions',
      `${operation} failed; reason=${result?.reason || 'unknown'}${result?.error ? `; error=${result.error}` : ''}`,
    );
  } catch {
    // Diagnostics must not alter the user-visible file action result.
  }
};

export const openLocalPathWithToast = async (
  filePath: string,
  fallbackKey = 'openFileFailed',
): Promise<boolean> => {
  try {
    const result = await window.electron?.shell?.openPath(filePath);
    if (result?.success) return true;
    logLocalFileActionFailure('open', filePath, result);
    showShellFailureToast(result, fallbackKey);
    return false;
  } catch (error) {
    console.warn('[LocalFileActions] failed to open local path because the shell call threw:', filePath, error);
    try {
      window.electron?.log?.fromRenderer?.(
        'warn',
        'LocalFileActions',
        `open threw; error=${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // Best-effort diagnostics only.
    }
    showToast(i18nService.t(fallbackKey));
    return false;
  }
};

export const revealLocalPathWithToast = async (
  filePath: string,
  fallbackKey = 'showInFolderFailed',
): Promise<boolean> => {
  try {
    const result = await window.electron?.shell?.showItemInFolder(filePath);
    if (result?.success) return true;
    logLocalFileActionFailure('reveal', filePath, result);
    showShellFailureToast(result, fallbackKey);
    return false;
  } catch (error) {
    console.warn('[LocalFileActions] failed to reveal local path because the shell call threw:', filePath, error);
    try {
      window.electron?.log?.fromRenderer?.(
        'warn',
        'LocalFileActions',
        `reveal threw; error=${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // Best-effort diagnostics only.
    }
    showToast(i18nService.t(fallbackKey));
    return false;
  }
};
