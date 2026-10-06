import { HtmlShareAccessMode, HtmlShareStatus } from '../../../shared/htmlShare/constants';
import {
  LibraryItemKind,
} from '../../../shared/library/constants';
import type { LibraryItem } from '../../../shared/library/types';
import { i18nService } from '../../services/i18n';

export const formatLibraryTime = (value: number): string => new Intl.DateTimeFormat(
  i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US',
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
).format(new Date(value));

export const formatLibrarySize = (value?: number): string => {
  if (value === undefined) return i18nService.t('libraryUnknownSize');
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export const getLibrarySourceLabel = (item: LibraryItem): string => {
  if (item.itemKind === LibraryItemKind.LocalArtifact) {
    return i18nService.t('libraryLocalArtifact');
  }
  if (item.itemKind === LibraryItemKind.SharedFile) {
    return i18nService.t('librarySharedFile');
  }
  return i18nService.t('libraryDeployedSite');
};

export const isLibraryWebsiteItem = (
  item: Pick<LibraryItem, 'itemKind'>,
): boolean => item.itemKind === LibraryItemKind.DeployedSite;

export const getLibraryItemStatus = (item: LibraryItem): string => {
  if (item.itemKind === LibraryItemKind.LocalArtifact) {
    return i18nService.t(`libraryAvailability_${item.availability}`);
  }
  if (item.itemKind === LibraryItemKind.SharedFile) {
    if (item.status === HtmlShareStatus.Live) return i18nService.t('htmlShareStatusLive');
    if (item.status === HtmlShareStatus.Disabled) {
      return i18nService.t('htmlShareStatusDisabled');
    }
    return i18nService.t('htmlShareStatusFailed');
  }
  return i18nService.t(`sitesStatus_${item.siteStatus}`);
};

export const getLibraryAccessModeLabel = (item: LibraryItem): string | undefined => {
  if (item.itemKind === LibraryItemKind.LocalArtifact) return undefined;
  return item.accessMode === HtmlShareAccessMode.Public
    ? i18nService.t('htmlShareAccessModePublic')
    : i18nService.t('htmlShareAccessModeCode');
};

const getLegacySanitizedFileName = (fileName: string): string => {
  const baseName = fileName.split(/[\\/]/).pop()?.trim() ?? '';
  return baseName.replace(/[^A-Za-z0-9._-]/g, '_');
};

export const getLibraryDisplayFileName = (item: LibraryItem): string => {
  if (item.itemKind !== LibraryItemKind.SharedFile || !item.entryFile) {
    return item.title;
  }

  // Older clients replaced every non-ASCII character in the archive entry with `_`.
  // Prefer the original title only when it exactly explains that legacy entry name.
  if (
    item.title !== item.entryFile
    && getLegacySanitizedFileName(item.title) === item.entryFile
  ) {
    return item.title;
  }

  return item.entryFile;
};
