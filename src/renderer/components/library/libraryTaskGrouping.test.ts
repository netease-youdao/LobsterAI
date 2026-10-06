import { describe, expect, test } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryItemKind,
  LibraryOrigin,
  LibraryViewMode,
} from '../../../shared/library/constants';
import type { LocalArtifactItem } from '../../../shared/library/types';
import { captureLibraryScrollAnchor,clampLibraryScrollTop } from './libraryScrollAnchor';
import { groupLibraryItemsByTask } from './libraryTaskGrouping';
import { createVirtualRows, getLibraryItemRowIndices } from './LibraryVirtualizedGroups';

const item = (id: string, sessionId: string, updatedAt: number, sortTime = 1): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId: id,
  title: `${id}.txt`,
  category: LibraryCategory.Other,
  sortTime,
  createdAt: 1,
  isFavorite: false,
  latestSession: { sessionId, title: sessionId, agentId: 'main', createdAt: 1, updatedAt, lastRelatedAt: 1 },
  filePath: `/tmp/${id}.txt`,
  artifactType: LibraryArtifactType.Text,
  extension: '.txt',
  availability: LibraryAvailability.Available,
  origin: LibraryOrigin.Conversation,
  relatedSessionCount: 1,
});

describe('task-first library presentation', () => {
  test('uses task activity dates and keeps files from different dates in one task', () => {
    const today = new Date(2026, 8, 7, 12).getTime();
    const yesterday = new Date(2026, 8, 6, 12).getTime();
    const result = groupLibraryItemsByTask([
      item('old-task-new-file', 'old-task', yesterday, today),
      item('new-task-old-file', 'new-task', today, 1),
      item('new-task-new-file', 'new-task', today, yesterday),
    ]);
    expect(result.map(date => date.dateKey)).toEqual(['2026-09-07', '2026-09-06']);
    expect(result[0].sessionBuckets).toHaveLength(1);
    expect(result[0].sessionBuckets[0].representativeTime).toBe(today);
    expect(result[0].sessionBuckets[0].items.map(value => value.itemId))
      .toEqual(['new-task-new-file', 'new-task-old-file']);
  });

  test('merges a task across page boundaries and uses task ID before file time', () => {
    const result = groupLibraryItemsByTask([
      item('a-new', 'a', 1.5, 999),
      item('z-old', 'z', 1.5, 0),
      item('a-old', 'a', 1.5, 2),
    ]);
    expect(result[0].sessionBuckets.map(task => task.sessionKey)).toEqual(['z', 'a']);
    expect(result[0].sessionBuckets[1].items.map(value => value.itemId)).toEqual(['a-new', 'a-old']);
  });

  test.each([LibraryViewMode.List, LibraryViewMode.Grid])('locates unmounted %s items using virtual row indices', viewMode => {
    const items = Array.from({ length: 120 }, (_, index) => item(`file-${index}`, 'task', 1));
    const dates = [{ key: 'date', title: 'Today', sessionGroups: [{ key: 'task', title: 'Task', sortTime: 1, items }] }];
    const rows = createVirtualRows(dates, viewMode, 3);
    const indices = getLibraryItemRowIndices(rows);
    expect(indices.size).toBe(120);
    expect(indices.get(`${LibraryItemKind.LocalArtifact}:file-119`))
      .toBe(2 + (viewMode === LibraryViewMode.Grid ? 39 : 119));
    const resized = getLibraryItemRowIndices(createVirtualRows(dates, viewMode, 2));
    expect(resized.get(`${LibraryItemKind.LocalArtifact}:file-119`))
      .toBe(2 + (viewMode === LibraryViewMode.Grid ? 59 : 119));
  });

  test('captures visible keys and pixel offsets without depending on all DOM rows', () => {
    const root = {
      scrollTop: 200,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelectorAll: () => Array.from({ length: 12 }, (_, index) => ({
        dataset: { libraryItemKey: `file:${index}` },
        getBoundingClientRect: () => ({ top: 80 + index * 30, bottom: 110 + index * 30 }),
      })),
    } as unknown as HTMLElement;
    const anchor = captureLibraryScrollAnchor(root, 7);
    expect(anchor.userGeneration).toBe(7);
    expect(anchor.scrollTop).toBe(200);
    expect(anchor.candidates).toHaveLength(8);
    expect(anchor.candidates[0]).toEqual({ itemKey: 'file:0', offsetTop: -20 });
  });

  test('top and empty captures need no extra reads; fallback is clamped', () => {
    expect(captureLibraryScrollAnchor(null, 1).candidates).toEqual([]);
    expect(captureLibraryScrollAnchor({ scrollTop: 24 } as HTMLElement, 1).candidates).toEqual([]);
    expect(clampLibraryScrollTop(500, { scrollHeight: 200, clientHeight: 100 })).toBe(100);
    expect(clampLibraryScrollTop(-50, { scrollHeight: 200, clientHeight: 100 })).toBe(0);
    expect(clampLibraryScrollTop(20, { scrollHeight: 20, clientHeight: 100 })).toBe(0);
  });
});
