import { describe, expect, test } from 'vitest';

import { LibraryItemKind } from '../../../shared/library/constants';
import type { LibraryItem } from '../../../shared/library/types';
import {
  getLibraryCardActionIds,
  getLibraryPreviewActionIds,
  LibraryItemAction,
} from './libraryItemActionPolicy';

const makeItem = (itemKind: LibraryItemKind): LibraryItem => ({
  itemKind,
  itemId: 'item-1',
  title: 'Item',
  category: 'document',
  sortTime: 1,
  createdAt: 1,
  isFavorite: false,
  latestSession: {
    sessionId: 'session-1',
    title: 'Session',
    agentId: 'main',
    lastRelatedAt: 1,
  },
  ...(itemKind === LibraryItemKind.LocalArtifact
    ? {
        filePath: '/tmp/item.pdf',
        artifactType: 'document' as const,
        extension: '.pdf',
        availability: 'available' as const,
        origin: 'conversation' as const,
        relatedSessionCount: 1,
      }
    : itemKind === LibraryItemKind.SharedFile
      ? {
          shareId: 'share-1',
          url: 'https://example.com/share',
          sourceType: 'document_file' as const,
          accessMode: 'public' as const,
          status: 'live' as const,
        }
      : {
          shareId: 'site-1',
          url: 'https://example.com/site',
          siteKind: 'static_site' as const,
          siteStatus: 'online' as const,
          shareStatus: 'live' as const,
          accessMode: 'public' as const,
        }),
}) as LibraryItem;

describe('library item action policy', () => {
  test('uses the overflow menu for local file management instead of preview', () => {
    const actions = getLibraryCardActionIds(makeItem(LibraryItemKind.LocalArtifact));
    expect(actions).toEqual([
      LibraryItemAction.ShareLocal,
      LibraryItemAction.ToggleFavorite,
      LibraryItemAction.OpenWithApp,
      LibraryItemAction.RevealLocal,
    ]);
  });

  test('offers link actions for a shared file', () => {
    expect(getLibraryCardActionIds(makeItem(LibraryItemKind.SharedFile))).toEqual([
      LibraryItemAction.ToggleFavorite,
      LibraryItemAction.OpenLink,
      LibraryItemAction.CopyLink,
      LibraryItemAction.RelatedSessions,
    ]);
    expect(getLibraryPreviewActionIds(makeItem(LibraryItemKind.SharedFile))).toEqual([
      LibraryItemAction.OpenLink,
      LibraryItemAction.CopyLink,
      LibraryItemAction.RelatedSessions,
    ]);
  });

  test('routes site management through the existing site surface', () => {
    const item = makeItem(LibraryItemKind.DeployedSite);
    expect(getLibraryCardActionIds(item)).toContain(LibraryItemAction.ManageSite);
    expect(getLibraryPreviewActionIds(item)).toEqual([
      LibraryItemAction.OpenLink,
      LibraryItemAction.CopyLink,
      LibraryItemAction.ManageSite,
      LibraryItemAction.RelatedSessions,
    ]);
  });

  test('keeps favorite in the preview header and moves local utilities into overflow', () => {
    expect(getLibraryPreviewActionIds(makeItem(LibraryItemKind.LocalArtifact))).toEqual([
      LibraryItemAction.OpenWithApp,
      LibraryItemAction.RevealLocal,
    ]);
  });

  test('derives preview overflow from the same complete action set as the card menu', () => {
    const item = makeItem(LibraryItemKind.LocalArtifact);
    const cardActions = getLibraryCardActionIds(item);
    const previewActions = getLibraryPreviewActionIds(item);
    expect(cardActions.filter(action => (
      action !== LibraryItemAction.ShareLocal
      && action !== LibraryItemAction.ToggleFavorite
    ))).toEqual(previewActions);
  });

  test('omits related sessions when an item has no relation', () => {
    const item = {
      ...makeItem(LibraryItemKind.SharedFile),
      latestSession: undefined,
    } as LibraryItem;
    expect(getLibraryCardActionIds(item)).not.toContain(LibraryItemAction.RelatedSessions);
  });
});
