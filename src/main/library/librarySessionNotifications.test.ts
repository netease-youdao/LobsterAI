import { describe, expect, test, vi } from 'vitest';

import { LibraryChangeReason } from '../../shared/library/constants';
import { LibraryIndexService } from './libraryIndexService';
import type { LibraryLocalStore } from './libraryLocalStore';

const createService = (relatedSessionIds: string[]) => {
  const onChanged = vi.fn();
  const listSessionIdsWithArtifactRelations = vi.fn(() => relatedSessionIds);
  const service = new LibraryIndexService({
    store: { listSessionIdsWithArtifactRelations } as unknown as LibraryLocalStore,
    userDataPath: '/tmp',
    onChanged,
    getMetadata: () => undefined,
    setMetadata: () => undefined,
  });
  return { service, onChanged, listSessionIdsWithArtifactRelations };
};

describe('Library session projection notifications', () => {
  test('prechecks all changed sessions and broadcasts even a non-owner relation', () => {
    const { service, onChanged, listSessionIdsWithArtifactRelations } = createService(['non-owner']);
    service.notifySessionProjectionChanges({
      changedSessionIds: ['unrelated', 'non-owner'], deletedSessionIds: [], affectedArtifactIds: [],
    });
    expect(listSessionIdsWithArtifactRelations).toHaveBeenCalledWith(['unrelated', 'non-owner']);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({
      reason: LibraryChangeReason.SessionProjectionChanged, sessionIds: ['non-owner'],
    });
  });

  test('does not broadcast projection changes or deletion with no affected files', () => {
    const { service, onChanged } = createService([]);
    service.notifySessionProjectionChanges({
      changedSessionIds: ['new-session'], deletedSessionIds: ['empty-session'], affectedArtifactIds: [],
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  test('broadcasts deletion from the journal once without querying removed relationships', () => {
    const { service, onChanged } = createService([]);
    service.notifySessionProjectionChanges({
      changedSessionIds: [], deletedSessionIds: ['deleted-session'], affectedArtifactIds: ['file'],
    });
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({
      reason: LibraryChangeReason.SessionDeleted, sessionIds: ['deleted-session'], itemIds: ['file'],
    });
  });
});
