import { describe, expect, test } from 'vitest';

import { HtmlShareAccessMode, HtmlShareStatus } from '../htmlShare/constants';
import { SiteKind, SiteStatus } from '../site/constants';
import { getLibraryCloudAvailability } from './cloudAvailability';
import {
  LibraryCategory,
  LibraryCloudAvailabilityFilter,
  LibraryItemKind,
} from './constants';
import type { DeployedSiteItem, SharedFileItem } from './types';

const base = {
  title: 'item',
  category: LibraryCategory.Document,
  sortTime: 1,
  createdAt: 1,
  isFavorite: false,
};

const sharedItem = (status: HtmlShareStatus): SharedFileItem => ({
  ...base,
  itemKind: LibraryItemKind.SharedFile,
  itemId: 'share-1',
  shareId: 'share-1',
  url: 'https://share.example/1',
  sourceType: 'document_file',
  accessMode: HtmlShareAccessMode.Public,
  status,
});

const siteItem = (siteStatus: SiteStatus, shareStatus: HtmlShareStatus): DeployedSiteItem => ({
  ...base,
  category: LibraryCategory.Site,
  itemKind: LibraryItemKind.DeployedSite,
  itemId: 'site-1',
  shareId: 'site-1',
  url: 'https://site.example',
  siteKind: SiteKind.StaticSite,
  siteStatus,
  shareStatus,
  accessMode: HtmlShareAccessMode.Public,
});

describe('getLibraryCloudAvailability', () => {
  test('maps live shares to available and closed shares to unavailable', () => {
    expect(getLibraryCloudAvailability(sharedItem(HtmlShareStatus.Live)))
      .toBe(LibraryCloudAvailabilityFilter.Available);
    expect(getLibraryCloudAvailability(sharedItem(HtmlShareStatus.Disabled)))
      .toBe(LibraryCloudAvailabilityFilter.Unavailable);
  });

  test('only treats online sites with a live share as available', () => {
    expect(getLibraryCloudAvailability(siteItem(SiteStatus.Online, HtmlShareStatus.Live)))
      .toBe(LibraryCloudAvailabilityFilter.Available);
    expect(getLibraryCloudAvailability(siteItem(SiteStatus.Deploying, HtmlShareStatus.Live)))
      .toBe(LibraryCloudAvailabilityFilter.Unavailable);
    expect(getLibraryCloudAvailability(siteItem(SiteStatus.Online, HtmlShareStatus.Disabled)))
      .toBe(LibraryCloudAvailabilityFilter.Unavailable);
  });

  test('treats a fixed-expiry free resource as unavailable after the server clock passes it', () => {
    const share = { ...sharedItem(HtmlShareStatus.Live), accessExpiresAt: 10_000 };
    const site = {
      ...siteItem(SiteStatus.Online, HtmlShareStatus.Live),
      accessExpiresAt: 10_000,
    };
    expect(getLibraryCloudAvailability(share, 9_999))
      .toBe(LibraryCloudAvailabilityFilter.Available);
    expect(getLibraryCloudAvailability(share, 10_000))
      .toBe(LibraryCloudAvailabilityFilter.Unavailable);
    expect(getLibraryCloudAvailability(site, 10_001))
      .toBe(LibraryCloudAvailabilityFilter.Unavailable);
  });

  test('uses the read-only entitlement projection for subscription and team resources', () => {
    const projectedUnavailable = {
      ...sharedItem(HtmlShareStatus.Live),
      effectiveAvailable: false,
      effectiveExpiresAt: 10_000,
    };
    const projectedGrace = {
      ...siteItem(SiteStatus.Online, HtmlShareStatus.Live),
      effectiveAvailable: true,
      effectiveExpiresAt: 10_000,
    };

    expect(getLibraryCloudAvailability(projectedUnavailable, 9_999))
      .toBe(LibraryCloudAvailabilityFilter.Unavailable);
    expect(getLibraryCloudAvailability(projectedGrace, 9_999))
      .toBe(LibraryCloudAvailabilityFilter.Available);
    expect(getLibraryCloudAvailability(projectedGrace, 10_000))
      .toBe(LibraryCloudAvailabilityFilter.Unavailable);
  });
});
