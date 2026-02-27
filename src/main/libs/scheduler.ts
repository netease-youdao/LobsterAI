import { BrowserWindow } from 'electron';
import { ScheduledTaskStore, ScheduledTask, ScheduledTaskRun, Schedule, NotifyPlatform } from '../scheduledTaskStore';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRunner } from './coworkRunner';
import type { IMGatewayManager } from '../im/imGatewayManager';

interface SchedulerDeps {
  scheduledTaskStore: ScheduledTaskStore;
  coworkStore: CoworkStore;
  getCoworkRunner: () => CoworkRunner;
  getIMGatewayManager?: () => IMGatewayManager | null;
  getSkillsPrompt?: () => Promise<string | null>;
}

export class Scheduler {
  private store: ScheduledTaskStore;
  private coworkStore: CoworkStore;
  private getCoworkRunner: () => CoworkRunner;
  private getIMGatewayManager: (() => IMGatewayManager | null) | null;
  private getSkillsPrompt: (() => Promise<string | null>) | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private activeTasks: Map<string, AbortController> = new Map();
  // Track cowork session IDs for running tasks so we can stop them
  private taskSessionIds: Map<string, string> = new Map();

  private static readonly MAX_TIMER_INTERVAL_MS = 60_000;
  private static readonly MAX_CONSECUTIVE_ERRORS = 5;

  constructor(deps: SchedulerDeps) {
    this.store = deps.scheduledTaskStore;
    this.coworkStore = deps.coworkStore;
    this.getCoworkRunner = deps.getCoworkRunner;
    this.getIMGatewayManager = deps.getIMGatewayManager ?? null;
    this.getSkillsPrompt = deps.getSkillsPrompt ?? null;
  }

  // --- Lifecycle ---

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('[Scheduler] Started');
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [, controller] of this.activeTasks) {
      controller.abort();
    }
    this.activeTasks.clear();
    console.log('[Scheduler] Stopped');
  }

  reschedule(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext();
  }

  // --- Core Scheduling ---

  private scheduleNext(): void {
    if (!this.running) return;

    const nextDueMs = this.store.getNextDueTimeMs();
    const now = Date.now();

    let delayMs: number;
    if (nextDueMs === null) {
      delayMs = Scheduler.MAX_TIMER_INTERVAL_MS;
    } else {
      delayMs = Math.min(
        Math.max(nextDueMs - now, 0),
        Scheduler.MAX_TIMER_INTERVAL_MS
      );
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();
    const dueTasks = this.store.getDueTasks(now);

    const executions = dueTasks.map((task) => this.executeTask(task, 'scheduled'));
    await Promise.allSettled(executions);

    this.scheduleNext();
  }

  // --- Task Execution ---

  async executeTask(
    task: ScheduledTask,
    trigger: 'scheduled' | 'manual'
  ): Promise<void> {
    if (this.activeTasks.has(task.id)) {
      console.log(`[Scheduler] Task ${task.id} already running, skipping`);
      return;
    }

    // Check if task has expired (skip for manual triggers)
    if (trigger === 'scheduled' && task.expiresAt) {
      const todayStr = new Date().toISOString().slice(0, 10);
      if (task.expiresAt <= todayStr) {
        console.log(`[Scheduler] Task ${task.id} expired (${task.expiresAt}), skipping`);
        return;
      }
    }

    const startTime = Date.now();
    const run = this.store.createRun(task.id, trigger);

    this.store.markTaskRunning(task.id, startTime);
    this.emitTaskStatusUpdate(task.id);
    this.emitRunUpdate(run);

    const abortController = new AbortController();
    this.activeTasks.set(task.id, abortController);

    let sessionId: string | null = null;
    let success = false;
    let error: string | null = null;

    try {
      sessionId = await this.startCoworkSession(task);
      success = true;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Task ${task.id} failed:`, error);
    } finally {
      const durationMs = Date.now() - startTime;
      this.activeTasks.delete(task.id);
      this.taskSessionIds.delete(task.id);

      // Check if task still exists (may have been deleted while running)
      const taskStillExists = this.store.getTask(task.id) !== null;

      if (taskStillExists) {
        // Update run record
        this.store.completeRun(
          run.id,
          success ? 'success' : 'error',
          sessionId,
          durationMs,
          error
        );

        // Update task state
        this.store.markTaskCompleted(
          task.id,
          success,
          durationMs,
          error,
          task.schedule
        );

        // Auto-disable on too many consecutive errors
        const updatedTask = this.store.getTask(task.id);
        if (updatedTask && updatedTask.state.consecutiveErrors >= Scheduler.MAX_CONSECUTIVE_ERRORS) {
          this.store.toggleTask(task.id, false);
          console.warn(
            `[Scheduler] Task ${task.id} auto-disabled after ${Scheduler.MAX_CONSECUTIVE_ERRORS} consecutive errors`
          );
        }

        // Disable one-shot 'at' tasks after execution
        if (task.schedule.type === 'at') {
          this.store.toggleTask(task.id, false);
        }

        // Prune old run history
        this.store.pruneRuns(task.id, 100);

        // Send IM notifications
        if (task.notifyPlatforms && task.notifyPlatforms.length > 0) {
          await this.sendNotifications(task, success, durationMs, error, sessionId);
        }

        // Emit final updates
        this.emitTaskStatusUpdate(task.id);
        const updatedRun = this.store.getRun(run.id);
        if (updatedRun) {
          this.emitRunUpdate(updatedRun);
        }
      } else {
        console.log(`[Scheduler] Task ${task.id} was deleted during execution, skipping post-run updates`);
      }

      this.reschedule();
    }
  }

  private async startCoworkSession(task: ScheduledTask): Promise<string> {
    const config = this.coworkStore.getConfig();
    const cwd = task.workingDirectory || config.workingDirectory;
    const baseSystemPrompt = task.systemPrompt || config.systemPrompt;
    let skillsPrompt: string | null = null;
    if (this.getSkillsPrompt) {
      try {
        skillsPrompt = await this.getSkillsPrompt();
      } catch (error) {
        console.warn('[Scheduler] Failed to build skills prompt for scheduled task:', error);
      }
    }
    const systemPrompt = [skillsPrompt, baseSystemPrompt]
      .filter((prompt): prompt is string => Boolean(prompt?.trim()))
      .join('\n\n');
    const executionMode = task.executionMode || config.executionMode || 'auto';

    // Create a cowork session
    const session = this.coworkStore.createSession(
      `[定时] ${task.name}`,
      cwd,
      systemPrompt,
      executionMode,
      []
    );

    // Update session to running
    this.coworkStore.updateSession(session.id, { status: 'running' });

    // Add initial user message
    this.coworkStore.addMessage(session.id, {
      type: 'user',
      content: task.prompt,
    });

    // Start the session with normal permission flow (no auto-approve).
    this.taskSessionIds.set(task.id, session.id);
    const runner = this.getCoworkRunner();
    await runner.startSession(session.id, task.prompt, {
      skipInitialUserMessage: true,
      confirmationMode: 'text',
    });

    return session.id;
  }

  // --- IM Notifications ---

  private async sendNotifications(
    task: ScheduledTask,
    success: boolean,
    durationMs: number,
    error: string | null,
    sessionId: string | null,
  ): Promise<void> {
    const imManager = this.getIMGatewayManager?.();
    if (!imManager) return;

    const status = success ? '✅ 成功' : '❌ 失败';
    const durationStr = durationMs < 1000
      ? `${durationMs}ms`
      : `${(durationMs / 1000).toFixed(1)}s`;

    let header = `📋 定时任务通知\n\n任务: ${task.name}\n状态: ${status}\n耗时: ${durationStr}`;
    if (error) {
      header += `\n错误: ${error}`;
    }

    // Extract full AI reply from completed cowork session (includes media markers)
    let fullReplyText = '';
    if (sessionId && success) {
      try {
        const session = this.coworkStore.getSession(sessionId);
        if (session) {
          const assistantMessages = session.messages.filter(
            (msg) => msg.type === 'assistant' && msg.content && !msg.metadata?.isThinking
          );
          fullReplyText = assistantMessages.map(m => m.content).join('\n\n');
        }
      } catch (err: unknown) {
        console.warn(`[Scheduler] Failed to extract session result for notification:`, err);
      }
    }

    // Build the complete notification message with header + result
    let message = header;
    if (fullReplyText) {
      const MAX_RESULT_LENGTH = 1500;
      const resultSnippet = fullReplyText.length > MAX_RESULT_LENGTH
        ? fullReplyText.slice(0, MAX_RESULT_LENGTH) + '…'
        : fullReplyText;
      message += `\n\n📝 执行结果:\n${resultSnippet}`;
    }

    for (const platform of task.notifyPlatforms) {
      try {
        // Use sendNotificationWithMedia to support media files in AI reply
        await imManager.sendNotificationWithMedia(platform, message);
        console.log(`[Scheduler] Notification sent via ${platform} for task ${task.id}`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[Scheduler] Failed to send notification via ${platform}: ${errMsg}`);
      }
    }
  }

  // --- Manual Execution ---

  async runManually(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await this.executeTask(task, 'manual');
  }

  stopTask(taskId: string): boolean {
    const controller = this.activeTasks.get(taskId);
    if (controller) {
      // Also stop the cowork session if one is running
      const sessionId = this.taskSessionIds.get(taskId);
      if (sessionId) {
        try {
          this.getCoworkRunner().stopSession(sessionId);
        } catch (err) {
          console.warn(`[Scheduler] Failed to stop cowork session for task ${taskId}:`, err);
        }
      }
      controller.abort();
      return true;
    }
    return false;
  }

  // --- Event Emission ---

  private emitTaskStatusUpdate(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;

    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('scheduledTask:statusUpdate', {
          taskId: task.id,
          state: task.state,
        });
      }
    });
  }

  private emitRunUpdate(run: ScheduledTaskRun): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('scheduledTask:runUpdate', { run });
      }
    });
  }
}
