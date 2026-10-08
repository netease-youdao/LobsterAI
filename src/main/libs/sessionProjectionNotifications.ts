/** The persisted fields consumed by task-grouped views, independent of their UI. */
export interface SessionProjection {
  title: string;
  agentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionProjectionChanges {
  changedSessionIds: string[];
  deletedSessionIds: string[];
  affectedArtifactIds: string[];
}

interface SessionProjectionJournal {
  before: Map<string, SessionProjection | undefined>;
  deletedSessionIds: Set<string>;
  affectedArtifactIds: Set<string>;
}

interface SessionProjectionNotificationOptions {
  runTransaction: <T>(operation: () => T) => T;
  isInTransaction: () => boolean;
  readProjection: (sessionId: string) => SessionProjection | undefined;
}

export const sessionProjectionsEqual = (
  before: SessionProjection | undefined,
  after: SessionProjection | undefined,
): boolean => before === after || Boolean(before && after
  && before.title === after.title
  && before.agentId === after.agentId
  && before.createdAt === after.createdAt
  && before.updatedAt === after.updatedAt);

/** A local transaction journal; it never patches the database or guesses commit timing. */
export class SessionProjectionNotifications {
  private readonly journals: SessionProjectionJournal[] = [];
  private readonly listeners = new Set<(changes: SessionProjectionChanges) => void>();

  constructor(private readonly options: SessionProjectionNotificationOptions) {}

  subscribe(listener: (changes: SessionProjectionChanges) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capture(sessionIds: readonly string[]): void {
    const journal = this.currentJournal();
    for (const id of sessionIds) {
      if (!journal.before.has(id)) {
        journal.before.set(id, this.options.readProjection(id));
      }
    }
  }

  recordDeletion(sessionIds: readonly string[], artifactIds: readonly string[]): void {
    const journal = this.currentJournal();
    for (const id of sessionIds) journal.deletedSessionIds.add(id);
    for (const id of artifactIds) journal.affectedArtifactIds.add(id);
  }

  transaction<T>(operation: () => T): T {
    // Existing outer transaction owners must use this boundary too. Publishing
    // after a nested SQLite savepoint would otherwise precede the real COMMIT.
    if (this.journals.length === 0 && this.options.isInTransaction()) {
      throw new Error('Session writes require runSessionTransaction for the outer transaction');
    }
    const journal: SessionProjectionJournal = {
      before: new Map(),
      deletedSessionIds: new Set(),
      affectedArtifactIds: new Set(),
    };
    this.journals.push(journal);
    let changes: SessionProjectionChanges | undefined;
    let result: T;
    try {
      result = this.options.runTransaction(() => {
        const value = operation();
        if (this.journals.length === 1) changes = this.collectChanges(journal);
        return value;
      });
    } catch (error) {
      this.journals.pop();
      throw error;
    }
    this.journals.pop();

    const parent = this.journals.at(-1);
    if (parent) {
      for (const [id, before] of journal.before) {
        if (!parent.before.has(id)) parent.before.set(id, before);
      }
      for (const id of journal.deletedSessionIds) parent.deletedSessionIds.add(id);
      for (const id of journal.affectedArtifactIds) parent.affectedArtifactIds.add(id);
    } else if (changes && (changes.changedSessionIds.length || changes.deletedSessionIds.length)) {
      for (const listener of this.listeners) {
        try {
          listener(changes);
        } catch (error) {
          console.warn('[CoworkStore] Session projection listener failed', error);
        }
      }
    }
    return result;
  }

  private currentJournal(): SessionProjectionJournal {
    const journal = this.journals.at(-1);
    if (!journal) throw new Error('Session projection capture requires a transaction');
    return journal;
  }

  private collectChanges(journal: SessionProjectionJournal): SessionProjectionChanges {
    const changedSessionIds: string[] = [];
    for (const [id, before] of journal.before) {
      if (!journal.deletedSessionIds.has(id)
        && !sessionProjectionsEqual(before, this.options.readProjection(id))) {
        changedSessionIds.push(id);
      }
    }
    return {
      changedSessionIds,
      deletedSessionIds: [...journal.deletedSessionIds],
      affectedArtifactIds: [...journal.affectedArtifactIds],
    };
  }
}
