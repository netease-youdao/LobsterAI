import { describe, expect, test, vi } from 'vitest';

import {
  type SessionProjection,
  SessionProjectionNotifications,
  sessionProjectionsEqual,
} from './sessionProjectionNotifications';

const projection = (updatedAt = 1000.25): SessionProjection => ({
  title: 'Task', agentId: 'main', createdAt: 500.5, updatedAt,
});

const createJournal = () => {
  let rows = new Map<string, SessionProjection>([['a', projection()], ['b', projection()]]);
  let depth = 0;
  const journal = new SessionProjectionNotifications({
    readProjection: id => rows.get(id),
    isInTransaction: () => depth > 0,
    runTransaction: operation => {
      const before = new Map(rows);
      depth += 1;
      try { return operation(); } catch (error) { rows = before; throw error; } finally { depth -= 1; }
    },
  });
  return {
    journal,
    rows: () => rows,
    depth: () => depth,
    write: (id: string, value: SessionProjection) => {
      journal.capture([id]);
      rows.set(id, value);
    },
  };
};

describe('SessionProjectionNotifications', () => {
  test('compares each projected field without truncating fractions or requiring monotonic time', () => {
    expect(sessionProjectionsEqual(undefined, undefined)).toBe(true);
    expect(sessionProjectionsEqual(undefined, projection())).toBe(false);
    expect(sessionProjectionsEqual(projection(), { ...projection() })).toBe(true);
    for (const changed of [
      { ...projection(), title: 'Other' },
      { ...projection(), agentId: 'other' },
      { ...projection(), createdAt: 500.75 },
      projection(1000),
      projection(1000.5),
    ]) expect(sessionProjectionsEqual(projection(), changed)).toBe(false);
  });

  test('nested rollback discards only its journal and commits outer changes once', () => {
    const fixture = createJournal();
    const listener = vi.fn(() => expect(fixture.depth()).toBe(0));
    fixture.journal.subscribe(listener);
    fixture.journal.transaction(() => {
      fixture.write('a', projection(2000));
      expect(() => fixture.journal.transaction(() => {
        fixture.write('b', projection(3000));
        throw new Error('inner rollback');
      })).toThrow('inner rollback');
      expect(listener).not.toHaveBeenCalled();
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      changedSessionIds: ['a'], deletedSessionIds: [], affectedArtifactIds: [],
    });
    expect(fixture.rows().get('b')).toEqual(projection());
  });

  test('deletion wins over updates, deduplicates affected IDs and is discarded on rollback', () => {
    const fixture = createJournal();
    const listener = vi.fn();
    fixture.journal.subscribe(listener);
    const remove = () => {
      fixture.write('a', projection(2000));
      fixture.rows().delete('a');
      fixture.journal.recordDeletion(['a', 'a'], ['file', 'file']);
    };
    expect(() => fixture.journal.transaction(() => {
      remove();
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(listener).not.toHaveBeenCalled();
    fixture.journal.transaction(remove);
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      changedSessionIds: [], deletedSessionIds: ['a'], affectedArtifactIds: ['file'],
    });
  });

  test('listener failure does not undo committed data or suppress other listeners', () => {
    const fixture = createJournal();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listener = vi.fn();
    fixture.journal.subscribe(() => { throw new Error('listener failure'); });
    fixture.journal.subscribe(listener);
    expect(() => fixture.journal.transaction(() => fixture.write('a', projection(2000)))).not.toThrow();
    expect(fixture.rows().get('a')?.updatedAt).toBe(2000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  test('rejects an untracked outer transaction before writing or notifying', () => {
    const operation = vi.fn();
    const journal = new SessionProjectionNotifications({
      readProjection: () => projection(), isInTransaction: () => true,
      runTransaction: callback => callback(),
    });
    expect(() => journal.transaction(operation)).toThrow('runSessionTransaction');
    expect(operation).not.toHaveBeenCalled();
  });
});
