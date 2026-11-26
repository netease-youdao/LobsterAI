import type Database from 'better-sqlite3';

export const TrustedWriteContext = {
  Session: 'remote_write_context',
  Agent: 'agent_write_context',
} as const;
type ContextTable = typeof TrustedWriteContext[keyof typeof TrustedWriteContext];

/** Preserve downgrade guards while the application migrates its own records. */
export function withTrustedMigrationWrite<T>(db: Database.Database, table: ContextTable, operation: () => T): T {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
    return operation();
  }
  return db.transaction(() => {
    const trusted = db.prepare(`SELECT trusted FROM ${table} WHERE id=1`).pluck().get();
    if (trusted === 1) return operation();
    if (trusted !== 0) throw new Error(`Invalid trusted write context in ${table}`);
    const update = db.prepare(`UPDATE ${table} SET trusted=? WHERE id=1`);
    update.run(1);
    try { return operation(); } finally { update.run(0); }
  })();
}
