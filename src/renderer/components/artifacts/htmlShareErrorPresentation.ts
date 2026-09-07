import {
  HtmlShareErrorCode,
  type HtmlShareFailureDescriptor,
  HtmlShareFailureKind,
} from '@shared/htmlShare/constants';

import { i18nService } from '@/services/i18n';

function formatByteLimit(bytes: number): string {
  const safeBytes = Math.max(0, bytes);
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = safeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function withByteLimit(defaultKey: string, limitKey: string, limitBytes?: number): string {
  if (typeof limitBytes !== 'number' || !Number.isFinite(limitBytes) || limitBytes <= 0) {
    return i18nService.t(defaultKey);
  }
  return i18nService
    .t(limitKey)
    .replace('{limit}', formatByteLimit(limitBytes));
}

export function formatHtmlShareFailure(failure?: HtmlShareFailureDescriptor | null): string {
  switch (failure?.failureKind) {
    case HtmlShareFailureKind.InputTooLong:
      return i18nService.t('htmlShareErrorInputTooLong');
    case HtmlShareFailureKind.FileTooLarge:
      return withByteLimit(
        'htmlShareErrorFileTooLarge',
        'htmlShareErrorFileTooLargeWithLimit',
        failure.details?.limitBytes,
      );
    case HtmlShareFailureKind.TotalSizeExceeded:
      return withByteLimit(
        'htmlShareErrorTotalSizeExceeded',
        'htmlShareErrorTotalSizeExceededWithLimit',
        failure.details?.limitBytes,
      );
    case HtmlShareFailureKind.ArchiveSizeExceeded:
      return withByteLimit(
        'htmlShareErrorArchiveSizeExceeded',
        'htmlShareErrorArchiveSizeExceededWithLimit',
        failure.details?.limitBytes,
      );
    case HtmlShareFailureKind.FileCountExceeded:
      return typeof failure.details?.limitCount === 'number'
        ? i18nService
            .t('htmlShareErrorFileCountExceededWithLimit')
            .replace('{limit}', String(failure.details.limitCount))
        : i18nService.t('htmlShareErrorFileCountExceeded');
    case HtmlShareFailureKind.InvalidArchive:
      return i18nService.t('htmlShareErrorInvalidArchive');
    case HtmlShareFailureKind.UnsupportedFile:
      return i18nService.t('htmlShareErrorUnsupportedFile');
    case HtmlShareFailureKind.UploadFailed:
      return i18nService.t('htmlShareErrorUploadFailed');
    case HtmlShareFailureKind.Unknown:
      return i18nService.t('htmlShareErrorGeneric');
    default:
      break;
  }

  switch (failure?.code) {
    case HtmlShareErrorCode.InvalidArchive:
      return i18nService.t('htmlShareErrorInvalidArchive');
    case HtmlShareErrorCode.TooLarge:
      return i18nService.t('htmlShareErrorSizeExceeded');
    case HtmlShareErrorCode.EntryNotFound:
      return i18nService.t('htmlShareErrorEntryNotFound');
    case HtmlShareErrorCode.NotFound:
      return i18nService.t('htmlShareErrorNotFound');
    case HtmlShareErrorCode.UploadFailed:
      return i18nService.t('htmlShareErrorUploadFailed');
    case HtmlShareErrorCode.UnsupportedFile:
      return i18nService.t('htmlShareErrorUnsupportedFile');
    case HtmlShareErrorCode.SubscriptionRequired:
      return i18nService.t('htmlShareSubscriptionRequiredMessage');
    case HtmlShareErrorCode.FeatureUnavailable:
      return i18nService.t('htmlShareUnavailableInProduction');
    case HtmlShareErrorCode.ReopenUnavailable:
      return i18nService.t('htmlShareReopenUnavailable');
    case HtmlShareErrorCode.ActiveShareLimitReached:
      return i18nService.t('htmlShareActiveLimitReached');
    case HtmlShareErrorCode.DisabledCannotUpdate:
      return i18nService.t('htmlShareDisabledCannotUpdate');
    case HtmlShareErrorCode.UnsafeSvg:
      return i18nService.t('artifactShareSvgRejected');
    case HtmlShareErrorCode.VideoTaskNotFound:
      return i18nService.t('htmlShareVideoTaskNotFound');
    case HtmlShareErrorCode.VideoSourceUnavailable:
      return i18nService.t('htmlShareVideoSourceUnavailable');
    case HtmlShareErrorCode.VideoPrepareFailed:
      return i18nService.t('htmlShareVideoPrepareFailed');
    case HtmlShareErrorCode.VideoUnsupported:
      return i18nService.t('htmlShareVideoUnsupported');
    default:
      return i18nService.t('htmlShareErrorGeneric');
  }
}
