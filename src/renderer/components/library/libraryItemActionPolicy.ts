import { LibraryItemKind } from '../../../shared/library/constants';
import type { LibraryItem } from '../../../shared/library/types';

export const LibraryItemAction = {
  ShareLocal: 'share_local',
  ToggleFavorite: 'toggle_favorite',
  OpenWithApp: 'open_with_app',
  RevealLocal: 'reveal_local',
  RelatedSessions: 'related_sessions',
  OpenLink: 'open_link',
  CopyLink: 'copy_link',
  ManageSite: 'manage_site',
} as const;

export type LibraryItemAction =
  (typeof LibraryItemAction)[keyof typeof LibraryItemAction];

const LOCAL_ACTIONS = [
  LibraryItemAction.ShareLocal,
  LibraryItemAction.ToggleFavorite,
  LibraryItemAction.OpenWithApp,
  LibraryItemAction.RevealLocal,
] as const;

const SHARED_ACTIONS = [
  LibraryItemAction.ToggleFavorite,
  LibraryItemAction.OpenLink,
  LibraryItemAction.CopyLink,
  LibraryItemAction.RelatedSessions,
] as const;

const SITE_ACTIONS = [
  LibraryItemAction.ToggleFavorite,
  LibraryItemAction.OpenLink,
  LibraryItemAction.CopyLink,
  LibraryItemAction.ManageSite,
  LibraryItemAction.RelatedSessions,
] as const;

const PREVIEW_PROMOTED_ACTIONS = new Set<LibraryItemAction>([
  LibraryItemAction.ShareLocal,
  LibraryItemAction.ToggleFavorite,
]);

const hasRelatedSessions = (item: LibraryItem): boolean => (
  Boolean(item.latestSession)
  || (item.itemKind === LibraryItemKind.LocalArtifact && item.relatedSessionCount > 0)
);

const getLibraryItemActionIds = (item: LibraryItem): readonly LibraryItemAction[] => {
  const actions = item.itemKind === LibraryItemKind.LocalArtifact
    ? LOCAL_ACTIONS
    : item.itemKind === LibraryItemKind.SharedFile
      ? SHARED_ACTIONS
      : SITE_ACTIONS;
  return hasRelatedSessions(item)
    ? actions
    : actions.filter(action => action !== LibraryItemAction.RelatedSessions);
};

export const getLibraryCardActionIds = (item: LibraryItem): readonly LibraryItemAction[] => {
  return getLibraryItemActionIds(item);
};

export const getLibraryPreviewActionIds = (item: LibraryItem): readonly LibraryItemAction[] => {
  return getLibraryItemActionIds(item).filter(action => !PREVIEW_PROMOTED_ACTIONS.has(action));
};
