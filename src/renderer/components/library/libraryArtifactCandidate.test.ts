import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryErrorCode,
  LibraryItemKind,
  LibraryOrigin,
} from '../../../shared/library/constants';
import type { LocalArtifactItem } from '../../../shared/library/types';
import { loadLibraryArtifact } from './libraryArtifactCandidate';

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
