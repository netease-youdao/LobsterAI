import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryErrorCode,
  LibraryItemKind,
  LibraryOrigin,
} from '../../../shared/library/constants';
import type { LocalArtifactItem } from '../../../shared/library/types';
import { getLibraryPreviewContentKey, getLibraryPreviewKey, loadLibraryArtifact } from './libraryArtifactCandidate';

const item: LocalArtifactItem = {
  itemKind: LibraryItemKind.LocalArtifact,
  itemId: 'item-a',
  title: 'report.md',
  category: LibraryCategory.Document,
  sortTime: 1,
  createdAt: 1,
  isFavorite: false,
  latestSession: {
    sessionId: 'session-a', title: 'Session', agentId: 'main',
    createdAt: 1, updatedAt: 1, lastRelatedAt: 1,
  },
  filePath: '/untrusted/report.md',
  artifactType: LibraryArtifactType.Markdown,
  extension: '.md',
  availability: LibraryAvailability.Available,
  origin: LibraryOrigin.Conversation,
  relatedSessionCount: 1,
};
const access = { itemId: item.itemId, accountEpoch: 'epoch-a' };
const authorized = { success: true, data: { filePath: '/authorized/report.md', access } };

const setup = () => {
  const getLocalAccess = vi.fn().mockResolvedValue(authorized);
  const readFileAsDataUrl = vi.fn().mockResolvedValue({
    success: true, dataUrl: 'data:text/plain;base64,IyBSZXBvcnQ=',
  });
  const statFile = vi.fn().mockResolvedValue({ success: true, isFile: true });
  vi.stubGlobal('window', { electron: {
    library: { getLocalAccess }, dialog: { readFileAsDataUrl, statFile },
  } });
  return { getLocalAccess, readFileAsDataUrl, statFile };
};

afterEach(() => vi.unstubAllGlobals());

describe('authorized library artifact loading', () => {
  test('uses only the authorized path and forwards the account-bound access', async () => {
    const { getLocalAccess, readFileAsDataUrl } = setup();
    const artifact = await loadLibraryArtifact(item, () => true);
    expect(getLocalAccess).toHaveBeenCalledWith(item.itemId);
    expect(readFileAsDataUrl).toHaveBeenCalledWith(authorized.data.filePath, access);
    expect(artifact).toMatchObject({ filePath: authorized.data.filePath, fileAccess: access, content: '# Report' });
  });

  test('denied items never reach file-reading IPC', async () => {
    const { getLocalAccess, readFileAsDataUrl } = setup();
    getLocalAccess.mockResolvedValue({ success: false, code: LibraryErrorCode.NotFound, error: 'Unavailable' });
    await expect(loadLibraryArtifact(item, () => true)).rejects.toThrow('Unavailable');
    expect(readFileAsDataUrl).not.toHaveBeenCalled();
  });

  test('account changes while authorizing prevent a read', async () => {
    const { getLocalAccess, readFileAsDataUrl } = setup();
    let current = true;
    getLocalAccess.mockImplementation(async () => { current = false; return authorized; });
    expect(await loadLibraryArtifact(item, () => current)).toBeNull();
    expect(readFileAsDataUrl).not.toHaveBeenCalled();
  });

  test('account changes during a read discard the returned content', async () => {
    const { readFileAsDataUrl } = setup();
    let current = true;
    readFileAsDataUrl.mockImplementation(async () => {
      current = false;
      return { success: true, dataUrl: 'data:text/plain;base64,IyBSZXBvcnQ=' };
    });
    expect(await loadLibraryArtifact(item, () => current)).toBeNull();
  });

  test('HTML file stat checks use the authorized access', async () => {
    const { statFile, readFileAsDataUrl } = setup();
    const artifact = await loadLibraryArtifact({ ...item, artifactType: LibraryArtifactType.Html }, () => true);
    expect(statFile).toHaveBeenCalledWith(authorized.data.filePath, access);
    expect(readFileAsDataUrl).not.toHaveBeenCalled();
    expect(artifact?.fileAccess).toEqual(access);
  });

  test('videos carry authorization into their streaming renderer', async () => {
    setup();
    const artifact = await loadLibraryArtifact({ ...item, artifactType: LibraryArtifactType.Video }, () => true);
    expect(artifact).toMatchObject({ filePath: authorized.data.filePath, fileAccess: access });
  });
});

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

  test('read changed Office and Markdown files again even when live editors are available', () => {
    const libraryDocuments = [
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

    for (const item of libraryDocuments) {
      expect(getLibraryPreviewContentKey(savedAgain(item))).not.toBe(getLibraryPreviewContentKey(item));
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
