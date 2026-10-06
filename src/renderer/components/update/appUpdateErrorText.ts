import {
  APP_UPDATE_ELEVATION_DECLINED_ERROR,
  APP_UPDATE_FILE_INVALID_ERROR,
  APP_UPDATE_GRAY_UNAVAILABLE_ERROR,
  APP_UPDATE_URL_UNTRUSTED_ERROR,
} from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';

/**
 * Maps stable main-process error markers to localized text. Anything else is
 * an OS/network message shown as-is.
 */
export const formatAppUpdateError = (message: string): string => {
  if (message === APP_UPDATE_GRAY_UNAVAILABLE_ERROR) {
    return i18nService.t('updateGrayUnavailable');
  }
  if (message === APP_UPDATE_ELEVATION_DECLINED_ERROR) {
    return i18nService.t('updateElevationDeclined');
  }
  if (message === APP_UPDATE_URL_UNTRUSTED_ERROR) {
    return i18nService.t('updateUrlUntrusted');
  }
  if (message === APP_UPDATE_FILE_INVALID_ERROR) {
    return i18nService.t('updateFileInvalid');
  }
  return message;
};
