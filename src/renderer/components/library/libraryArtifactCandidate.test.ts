import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryItemKind,
  LibraryOrigin,
} from '../../../shared/library/constants';
import type { LocalArtifactItem } from '../../../shared/library/types';
import { getLibraryPreviewContentKey, getLibraryPreviewKey } from './libraryArtifactCandidate';

const makeItem = (overrides: Partial<LocalArtifactItem> = {}): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId: 'item-1',
  title: 'report.docx',
  category: LibraryCategory.Document,
  sortTime: 1_000,
  createdAt: 500,
  isFavorite: false,
  latestSession: {
    sessionId: 'session-1',
    title: 'Session',
    agentId: 'main',
    createdAt: 100,
    updatedAt: 1_000,
    lastRelatedAt: 1_000,
    lastMessageId: 'message-1',
  },
  filePath: '/work/report.docx',
  artifactType: LibraryArtifactType.Document,
  extension: '.docx',
  sizeBytes: 2_048,
  fileMtimeMs: 1_000,
  availability: LibraryAvailability.Available,
  origin: LibraryOrigin.Conversation,
  relatedSessionCount: 1,
  ...overrides,
});

/** What a library refresh brings after a save of the file: a new version and sort time. */
const savedAgain = (item: LocalArtifactItem): LocalArtifactItem => ({
  ...item,
  sortTime: 2_000,
  sizeBytes: 4_096,
  fileMtimeMs: 2_000,
});

const stubBridges = (bridges: { markdown?: boolean; office?: boolean }): void => {
  vi.stubGlobal('window', {
    electron: {
      artifact: {
        ...(bridges.markdown ? { markdown: {} } : {}),
        ...(bridges.office ? { office: { word: {}, sheet: {}, slides: {} } } : {}),
      },
    },
  });
};

describe('library preview keys', () => {
  beforeEach(() => {
    stubBridges({ markdown: true, office: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('keep the preview of a file across refreshes of its item', () => {
    const item = makeItem();
    const refreshed = savedAgain({
      ...item,
      isFavorite: true,
      relatedSessionCount: 2,
      latestSession: { ...item.latestSession, sessionId: 'session-2', lastMessageId: 'message-2' },
    });

    expect(getLibraryPreviewKey(refreshed)).toBe(getLibraryPreviewKey(item));
  });

  test('open the preview anew for another file or renderer', () => {
    const key = getLibraryPreviewKey(makeItem());

    expect(getLibraryPreviewKey(makeItem({ itemId: 'item-2' }))).not.toBe(key);
    expect(getLibraryPreviewKey(makeItem({ filePath: '/work/renamed.docx' }))).not.toBe(key);
    expect(getLibraryPreviewKey(makeItem({ title: 'renamed.docx' }))).not.toBe(key);
    expect(getLibraryPreviewKey(makeItem({ artifactType: LibraryArtifactType.Text }))).not.toBe(key);
  });

  test('have no preview while the file is unavailable', () => {
    for (const availability of [LibraryAvailability.Missing, LibraryAvailability.PermissionDenied]) {
      const item = makeItem({ availability });
      expect(getLibraryPreviewKey(item)).toBeUndefined();
      expect(getLibraryPreviewContentKey(item)).toBeUndefined();
    }
  });

  test('leave a saved file to the editor that follows it', () => {
    const editable = [
      makeItem(),
      makeItem({ title: 'numbers.xlsx', filePath: '/work/numbers.xlsx', extension: '.xlsx' }),
      makeItem({ title: 'deck.pptx', filePath: '/work/deck.pptx', extension: '.pptx' }),
      makeItem({
        title: 'notes.md',
        filePath: '/work/notes.md',
        extension: '.md',
        artifactType: LibraryArtifactType.Markdown,
      }),
    ];

    for (const item of editable) {
      expect(getLibraryPreviewContentKey(savedAgain(item))).toBe(getLibraryPreviewContentKey(item));
    }
  });

  test('read a changed file again for previews that do not follow it', () => {
    const readOnly = [
      makeItem({ title: 'paper.pdf', filePath: '/work/paper.pdf', extension: '.pdf' }),
      makeItem({
        title: 'chart.png',
        filePath: '/work/chart.png',
        extension: '.png',
        artifactType: LibraryArtifactType.Image,
      }),
      makeItem({
        title: 'page.html',
        filePath: '/work/page.html',
        extension: '.html',
        artifactType: LibraryArtifactType.Html,
      }),
    ];

    for (const item of readOnly) {
      expect(getLibraryPreviewContentKey(savedAgain(item))).not.toBe(getLibraryPreviewContentKey(item));
      expect(getLibraryPreviewContentKey({ ...item, isFavorite: true, sortTime: 3_000 }))
        .toBe(getLibraryPreviewContentKey(item));
    }
  });

  test('read Office and Markdown files again where this window cannot edit them', () => {
    stubBridges({});
    const word = makeItem();
    const markdown = makeItem({
      title: 'notes.md',
      filePath: '/work/notes.md',
      extension: '.md',
      artifactType: LibraryArtifactType.Markdown,
    });

    expect(getLibraryPreviewContentKey(savedAgain(word))).not.toBe(getLibraryPreviewContentKey(word));
    expect(getLibraryPreviewContentKey(savedAgain(markdown))).not.toBe(getLibraryPreviewContentKey(markdown));
  });
});
