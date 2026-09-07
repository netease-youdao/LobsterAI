import { compareLibraryLocalItems } from '../../../shared/library/localOrdering';
import type { LocalArtifactItem } from '../../../shared/library/types';
import {
  getLibraryDateGroupKey,
  type LibraryDateSessionBucket,
} from './libraryDateGrouping';

/** Input is a validated snapshot. Task ordering precedes file/date grouping. */
export const groupLibraryItemsByTask = (
  items: readonly LocalArtifactItem[],
): LibraryDateSessionBucket<LocalArtifactItem>[] => {
  const dates = new Map<string, LibraryDateSessionBucket<LocalArtifactItem>>();
  const tasks = new Map<string, LibraryDateSessionBucket<LocalArtifactItem>['sessionBuckets'][number]>();
  for (const item of [...items].sort(compareLibraryLocalItems)) {
    const session = item.latestSession;
    let task = tasks.get(session.sessionId);
    if (!task) {
      const dateKey = getLibraryDateGroupKey(session.updatedAt);
      let date = dates.get(dateKey);
      if (!date) {
        date = { dateKey, representativeTime: session.updatedAt, sessionBuckets: [] };
        dates.set(dateKey, date);
      }
      task = {
        sessionKey: session.sessionId,
        representativeTime: session.updatedAt,
        items: [],
      };
      tasks.set(session.sessionId, task);
      date.sessionBuckets.push(task);
    }
    task.items.push(item);
  }
  return [...dates.values()];
};
