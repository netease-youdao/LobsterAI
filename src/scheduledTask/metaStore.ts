/**
 * Local metadata store for scheduled task origin/binding.
 * OpenClaw gateway cron.* API doesn't support custom fields,
 * so we persist origin/binding locally in SQLite.
 */
import type { Database } from 'sql.js';

export interface TaskMeta {
  taskId: string;
  origin: string; // JSON.stringify(TaskOrigin)
  binding: string; // JSON.stringify(ExecutionBinding)
}

export class ScheduledTaskMetaStore {
  constructor(private db: Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.run(
      'CREATE TABLE IF NOT EXISTS scheduled_task_meta (task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, binding TEXT NOT NULL)'
    );
  }

  get(taskId: string): TaskMeta | null {
    const stmt = this.db.prepare('SELECT task_id, origin, binding FROM scheduled_task_meta WHERE task_id = ?');
    stmt.bind([taskId]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { task_id: string; origin: string; binding: string };
      stmt.free();
      return { taskId: row.task_id, origin: row.origin, binding: row.binding };
    }
    stmt.free();
    return null;
  }

  set(taskId: string, origin: unknown, binding: unknown): void {
    this.db.run(
      'INSERT OR REPLACE INTO scheduled_task_meta (task_id, origin, binding) VALUES (?, ?, ?)',
      [taskId, JSON.stringify(origin), JSON.stringify(binding)]
    );
  }

  delete(taskId: string): void {
    this.db.run('DELETE FROM scheduled_task_meta WHERE task_id = ?', [taskId]);
  }

  list(): TaskMeta[] {
    const results: TaskMeta[] = [];
    const stmt = this.db.prepare('SELECT task_id, origin, binding FROM scheduled_task_meta');
    while (stmt.step()) {
      const row = stmt.getAsObject() as { task_id: string; origin: string; binding: string };
      results.push({ taskId: row.task_id, origin: row.origin, binding: row.binding });
    }
    stmt.free();
    return results;
  }
}
