/**
 * Local metadata store for scheduled task origin/binding.
 * OpenClaw gateway cron.* API doesn't support custom fields,
 * so we persist origin/binding locally in SQLite.
 */
import type Database from 'better-sqlite3';

export interface TaskMeta {
  taskId: string;
  origin: string; // JSON.stringify(TaskOrigin)
  binding: string; // JSON.stringify(ExecutionBinding)
}

export class ScheduledTaskMetaStore {
  constructor(private db: Database.Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS scheduled_task_meta (task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, binding TEXT NOT NULL)'
    );
  }

  get(taskId: string): TaskMeta | null {
    const row = this.db
      .prepare('SELECT task_id, origin, binding FROM scheduled_task_meta WHERE task_id = ?')
      .get(taskId) as { task_id: string; origin: string; binding: string } | undefined;
    if (!row) return null;
    return { taskId: row.task_id, origin: row.origin, binding: row.binding };
  }

  set(taskId: string, origin: unknown, binding: unknown): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO scheduled_task_meta (task_id, origin, binding) VALUES (?, ?, ?)',
      )
      .run(taskId, JSON.stringify(origin), JSON.stringify(binding));
  }

  delete(taskId: string): void {
    this.db.prepare('DELETE FROM scheduled_task_meta WHERE task_id = ?').run(taskId);
  }

  list(): TaskMeta[] {
    const rows = this.db
      .prepare('SELECT task_id, origin, binding FROM scheduled_task_meta')
      .all() as Array<{ task_id: string; origin: string; binding: string }>;
    return rows.map((row) => ({ taskId: row.task_id, origin: row.origin, binding: row.binding }));
  }
}
