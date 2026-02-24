import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { CronExpressionParser } from 'cron-parser';

// Types for scheduled tasks (main process side)
export type TaskLastStatus = 'success' | 'error' | 'running' | null;

export interface TaskState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: TaskLastStatus;
  lastError: string | null;
  lastDurationMs: number | null;
  runningAtMs: number | null;
  consecutiveErrors: number;
}

export interface Schedule {
  type: 'at' | 'interval' | 'cron';
  datetime?: string;
  intervalMs?: number;
  unit?: 'minutes' | 'hours' | 'days';
  value?: number;
  expression?: string;
}

export type NotifyPlatform = 'dingtalk' | 'feishu' | 'telegram' | 'discord' | 'nim';

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  expiresAt: string | null;
  notifyPlatforms: NotifyPlatform[];
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  trigger: 'scheduled' | 'manual';
}

export interface ScheduledTaskInput {
  name: string;
  description: string;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  expiresAt: string | null;
  notifyPlatforms: NotifyPlatform[];
  enabled: boolean;
}

// Raw DB row types
interface TaskRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  schedule_json: string;
  prompt: string;
  working_directory: string;
  system_prompt: string;
  execution_mode: string;
  expires_at: string | null;
  notify_platforms_json: string;
  next_run_at_ms: number | null;
  last_run_at_ms: number | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  running_at_ms: number | null;
  consecutive_errors: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  task_id: string;
  session_id: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  trigger_type: string;
}

export class ScheduledTaskStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.resetStuckRunningTasks();
  }

  // Helper method to get a single row from query result
  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    return row as T;
  }

  // Helper method to get all rows from query result
  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  }

  // --- Startup ---

  private resetStuckRunningTasks(): void {
    try {
      // Reset stuck runs
      this.db.run(`
        UPDATE scheduled_task_runs
        SET status = 'error',
            finished_at = ?,
            error = 'Application was closed during execution'
        WHERE status = 'running'
      `, [new Date().toISOString()]);

      // Reset stuck task states
      this.db.run(`
        UPDATE scheduled_tasks
        SET running_at_ms = NULL,
            last_status = 'error',
            last_error = 'Application was closed during execution'
        WHERE running_at_ms IS NOT NULL
      `);

      this.saveDb();
    } catch (error) {
      console.warn('Failed to reset stuck running tasks:', error);
    }
  }

  // --- Task CRUD ---

  listTasks(): ScheduledTask[] {
    const rows = this.getAll<TaskRow>(
      'SELECT * FROM scheduled_tasks ORDER BY created_at DESC'
    );
    return rows.map((row) => this.rowToTask(row));
  }

  getTask(id: string): ScheduledTask | null {
    const row = this.getOne<TaskRow>(
      'SELECT * FROM scheduled_tasks WHERE id = ?',
      [id]
    );
    return row ? this.rowToTask(row) : null;
  }

  createTask(input: ScheduledTaskInput): ScheduledTask {
    const id = uuidv4();
    const now = new Date().toISOString();
    const nextRunAtMs = input.enabled ? this.calculateNextRunTime(input.schedule, null) : null;

    this.db.run(`
      INSERT INTO scheduled_tasks
        (id, name, description, enabled, schedule_json, prompt,
         working_directory, system_prompt, execution_mode, expires_at,
         notify_platforms_json, next_run_at_ms, consecutive_errors, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `, [
      id, input.name, input.description,
      input.enabled ? 1 : 0,
      JSON.stringify(input.schedule),
      input.prompt,
      input.workingDirectory, input.systemPrompt, input.executionMode,
      input.expiresAt ?? null,
      JSON.stringify(input.notifyPlatforms ?? []),
      nextRunAtMs,
      now, now,
    ]);

    this.saveDb();
    return this.getTask(id)!;
  }

  updateTask(id: string, input: Partial<ScheduledTaskInput>): ScheduledTask | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const name = input.name ?? existing.name;
    const description = input.description ?? existing.description;
    const enabled = input.enabled ?? existing.enabled;
    const schedule = input.schedule ?? existing.schedule;
    const prompt = input.prompt ?? existing.prompt;
    const workingDirectory = input.workingDirectory ?? existing.workingDirectory;
    const systemPrompt = input.systemPrompt ?? existing.systemPrompt;
    const executionMode = input.executionMode ?? existing.executionMode;
    const expiresAt = input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt;
    const notifyPlatforms = input.notifyPlatforms !== undefined ? input.notifyPlatforms : existing.notifyPlatforms;

    // Recalculate next run if schedule or enabled changed
    let nextRunAtMs = existing.state.nextRunAtMs;
    if (input.schedule !== undefined || input.enabled !== undefined) {
      nextRunAtMs = enabled
        ? this.calculateNextRunTime(schedule, existing.state.lastRunAtMs)
        : null;
    }

    this.db.run(`
      UPDATE scheduled_tasks
      SET name = ?, description = ?, enabled = ?, schedule_json = ?,
          prompt = ?, working_directory = ?, system_prompt = ?,
          execution_mode = ?, expires_at = ?, notify_platforms_json = ?,
          next_run_at_ms = ?, updated_at = ?
      WHERE id = ?
    `, [
      name, description,
      enabled ? 1 : 0,
      JSON.stringify(schedule),
      prompt, workingDirectory,
      systemPrompt, executionMode,
      expiresAt,
      JSON.stringify(notifyPlatforms),
      nextRunAtMs, now, id,
    ]);

    this.saveDb();
    return this.getTask(id)!;
  }

  deleteTask(id: string): boolean {
    // Delete runs first (CASCADE may not work with sql.js)
    this.db.run('DELETE FROM scheduled_task_runs WHERE task_id = ?', [id]);
    this.db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  toggleTask(id: string, enabled: boolean): { task: ScheduledTask | null; warning: string | null } {
    const task = this.updateTask(id, { enabled });
    if (!task || !enabled) return { task, warning: null };

    const warning = this.validateTaskActivation(task);
    return { task, warning };
  }

  /**
   * Check if a task can meaningfully run after being enabled.
   * Returns a warning string if the task will never fire, null otherwise.
   */
  validateTaskActivation(task: ScheduledTask): string | null {
    const now = Date.now();
    const todayStr = new Date().toISOString().slice(0, 10);

    // Check: "at" type task with past datetime → will never fire
    if (task.schedule.type === 'at' && task.schedule.datetime) {
      const targetMs = new Date(task.schedule.datetime).getTime();
      if (targetMs <= now) {
        return 'TASK_AT_PAST';
      }
    }

    // Check: expiresAt is today or in the past → task expired
    if (task.expiresAt && task.expiresAt <= todayStr) {
      return 'TASK_EXPIRED';
    }

    return null;
  }

  // --- Task State Updates (called by Scheduler) ---

  markTaskRunning(id: string, runningAtMs: number): void {
    this.db.run(`
      UPDATE scheduled_tasks
      SET running_at_ms = ?, last_status = 'running', updated_at = ?
      WHERE id = ?
    `, [runningAtMs, new Date().toISOString(), id]);
    this.saveDb();
  }

  markTaskCompleted(
    id: string,
    success: boolean,
    durationMs: number,
    error: string | null,
    schedule: Schedule
  ): void {
    const now = Date.now();
    const task = this.getTask(id);
    const consecutiveErrors = success ? 0 : (task?.state.consecutiveErrors ?? 0) + 1;
    const nextRunAtMs = task?.enabled ? this.calculateNextRunTime(schedule, now) : null;

    this.db.run(`
      UPDATE scheduled_tasks
      SET running_at_ms = NULL,
          last_run_at_ms = ?,
          last_status = ?,
          last_error = ?,
          last_duration_ms = ?,
          consecutive_errors = ?,
          next_run_at_ms = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      now,
      success ? 'success' : 'error',
      error,
      durationMs,
      consecutiveErrors,
      nextRunAtMs,
      new Date().toISOString(),
      id,
    ]);

    this.saveDb();
  }

  // --- Run History ---

  createRun(taskId: string, trigger: 'scheduled' | 'manual'): ScheduledTaskRun {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(`
      INSERT INTO scheduled_task_runs (id, task_id, status, started_at, trigger_type)
      VALUES (?, ?, 'running', ?, ?)
    `, [id, taskId, now, trigger]);
    this.saveDb();
    return this.getRun(id)!;
  }

  completeRun(
    runId: string,
    status: 'success' | 'error',
    sessionId: string | null,
    durationMs: number,
    error: string | null
  ): ScheduledTaskRun | null {
    const now = new Date().toISOString();
    this.db.run(`
      UPDATE scheduled_task_runs
      SET status = ?, session_id = ?, finished_at = ?, duration_ms = ?, error = ?
      WHERE id = ?
    `, [status, sessionId, now, durationMs, error, runId]);
    this.saveDb();
    return this.getRun(runId);
  }

  getRun(id: string): ScheduledTaskRun | null {
    const row = this.getOne<RunRow>(
      'SELECT * FROM scheduled_task_runs WHERE id = ?',
      [id]
    );
    return row ? this.rowToRun(row) : null;
  }

  listRuns(taskId: string, limit: number = 50, offset: number = 0): ScheduledTaskRun[] {
    const rows = this.getAll<RunRow>(
      'SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
      [taskId, limit, offset]
    );
    return rows.map((row) => this.rowToRun(row));
  }

  listAllRuns(limit: number = 50, offset: number = 0): (ScheduledTaskRun & { taskName: string })[] {
    const rows = this.getAll<RunRow & { task_name: string }>(
      `SELECT r.*, t.name as task_name
       FROM scheduled_task_runs r
       LEFT JOIN scheduled_tasks t ON r.task_id = t.id
       ORDER BY r.started_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return rows.map((row) => ({
      ...this.rowToRun(row),
      taskName: row.task_name ?? '',
    }));
  }

  countRuns(taskId: string): number {
    const row = this.getOne<{ 'COUNT(*)': number }>(
      'SELECT COUNT(*) FROM scheduled_task_runs WHERE task_id = ?',
      [taskId]
    );
    return row?.['COUNT(*)'] ?? 0;
  }

  pruneRuns(taskId: string, keepCount: number = 100): void {
    // Get IDs of the runs to keep
    const keepRows = this.getAll<{ id: string }>(
      'SELECT id FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?',
      [taskId, keepCount]
    );
    const keepIds = keepRows.map((r) => r.id);

    if (keepIds.length === 0) return;

    // Delete all runs not in the keep list
    const placeholders = keepIds.map(() => '?').join(',');
    this.db.run(
      `DELETE FROM scheduled_task_runs WHERE task_id = ? AND id NOT IN (${placeholders})`,
      [taskId, ...keepIds]
    );
    this.saveDb();
  }

  // --- Scheduler Queries ---

  getDueTasks(nowMs: number): ScheduledTask[] {
    const todayStr = new Date(nowMs).toISOString().slice(0, 10);
    const rows = this.getAll<TaskRow>(`
      SELECT * FROM scheduled_tasks
      WHERE enabled = 1
        AND next_run_at_ms IS NOT NULL
        AND next_run_at_ms <= ?
        AND running_at_ms IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY next_run_at_ms ASC
    `, [nowMs, todayStr]);
    return rows.map((row) => this.rowToTask(row));
  }

  getNextDueTimeMs(): number | null {
    const todayStr = new Date().toISOString().slice(0, 10);
    const row = this.getOne<{ min_time: number | null }>(
      `SELECT MIN(next_run_at_ms) as min_time
       FROM scheduled_tasks
       WHERE enabled = 1
         AND next_run_at_ms IS NOT NULL
         AND running_at_ms IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
      [todayStr]
    );
    return row?.min_time ?? null;
  }

  // --- Helpers ---

  calculateNextRunTime(schedule: Schedule, lastRunAtMs: number | null): number | null {
    const now = Date.now();

    switch (schedule.type) {
      case 'at': {
        if (!schedule.datetime) return null;
        const targetMs = new Date(schedule.datetime).getTime();
        return targetMs > now ? targetMs : null;
      }
      case 'interval': {
        const intervalMs = schedule.intervalMs ?? 60000;
        if (lastRunAtMs) {
          return Math.max(lastRunAtMs + intervalMs, now);
        }
        return now + intervalMs;
      }
      case 'cron': {
        if (!schedule.expression) return null;
        return this.getNextCronTime(schedule.expression, now);
      }
      default:
        return null;
    }
  }

  private getNextCronTime(expression: string, afterMs: number): number | null {
    try {
      const interval = CronExpressionParser.parse(expression, {
        currentDate: new Date(afterMs),
      });
      return interval.next().toDate().getTime();
    } catch {
      return null;
    }
  }

  private rowToTask(row: TaskRow): ScheduledTask {
    let notifyPlatforms: NotifyPlatform[] = [];
    try {
      notifyPlatforms = row.notify_platforms_json ? JSON.parse(row.notify_platforms_json) : [];
    } catch {
      notifyPlatforms = [];
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled === 1,
      schedule: JSON.parse(row.schedule_json),
      prompt: row.prompt,
      workingDirectory: row.working_directory,
      systemPrompt: row.system_prompt,
      executionMode: row.execution_mode as 'auto' | 'local' | 'sandbox',
      expiresAt: row.expires_at,
      notifyPlatforms,
      state: {
        nextRunAtMs: row.next_run_at_ms,
        lastRunAtMs: row.last_run_at_ms,
        lastStatus: row.last_status as TaskLastStatus,
        lastError: row.last_error,
        lastDurationMs: row.last_duration_ms,
        runningAtMs: row.running_at_ms,
        consecutiveErrors: row.consecutive_errors,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToRun(row: RunRow): ScheduledTaskRun {
    return {
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id,
      status: row.status as 'running' | 'success' | 'error',
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      error: row.error,
      trigger: row.trigger_type as 'scheduled' | 'manual',
    };
  }
}
