export interface OpenClawHistorySyncTurnSnapshot {
  sessionKey: string;
  turnToken: number;
}

interface OpenClawTurnHistorySyncDependencies {
  getTurn: (sessionId: string) => OpenClawHistorySyncTurnSnapshot | undefined;
  requestHistory: (sessionKey: string, limit: number) => Promise<unknown[] | undefined>;
  handleThinkingHistory: (sessionId: string, messages: unknown[]) => void;
  handleBackfillHistory: (sessionId: string, messages: unknown[]) => void;
}

const THINKING_SYNC_DEBOUNCE_MS = 250;
const TOOL_RESULT_BACKFILL_DEBOUNCE_MS = 2_000;

export class OpenClawTurnHistorySync {
  private readonly thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingThinkingToolCallIds = new Map<string, Set<string>>();
  private readonly backfillTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingBackfillToolCallIds = new Map<string, Set<string>>();

  constructor(private readonly dependencies: OpenClawTurnHistorySyncDependencies) {}

  scheduleThinking(sessionId: string, toolCallId: string): void {
    this.addPending(this.pendingThinkingToolCallIds, sessionId, toolCallId);
    this.schedule(
      this.thinkingTimers,
      sessionId,
      THINKING_SYNC_DEBOUNCE_MS,
      () => this.executeThinking(sessionId),
    );
  }

  scheduleToolResultBackfill(sessionId: string, toolCallId: string): void {
    this.addPending(this.pendingBackfillToolCallIds, sessionId, toolCallId);
    this.schedule(
      this.backfillTimers,
      sessionId,
      TOOL_RESULT_BACKFILL_DEBOUNCE_MS,
      () => this.executeBackfill(sessionId),
    );
  }

  clearSession(sessionId: string): void {
    this.clearTimer(this.thinkingTimers, sessionId);
    this.clearTimer(this.backfillTimers, sessionId);
    this.pendingThinkingToolCallIds.delete(sessionId);
    this.pendingBackfillToolCallIds.delete(sessionId);
  }

  dispose(): void {
    for (const timer of [...this.thinkingTimers.values(), ...this.backfillTimers.values()]) {
      clearTimeout(timer);
    }
    this.thinkingTimers.clear();
    this.backfillTimers.clear();
    this.pendingThinkingToolCallIds.clear();
    this.pendingBackfillToolCallIds.clear();
  }

  private addPending(
    pendingBySession: Map<string, Set<string>>,
    sessionId: string,
    toolCallId: string,
  ): void {
    const pending = pendingBySession.get(sessionId) ?? new Set<string>();
    pending.add(toolCallId);
    pendingBySession.set(sessionId, pending);
  }

  private schedule(
    timers: Map<string, ReturnType<typeof setTimeout>>,
    sessionId: string,
    delayMs: number,
    execute: () => Promise<void>,
  ): void {
    this.clearTimer(timers, sessionId);
    timers.set(sessionId, setTimeout(() => {
      timers.delete(sessionId);
      void execute();
    }, delayMs));
  }

  private clearTimer(
    timers: Map<string, ReturnType<typeof setTimeout>>,
    sessionId: string,
  ): void {
    const timer = timers.get(sessionId);
    if (timer) clearTimeout(timer);
    timers.delete(sessionId);
  }

  private async executeThinking(sessionId: string): Promise<void> {
    const pending = this.pendingThinkingToolCallIds.get(sessionId);
    if (!pending?.size) return;

    const toolCallIds = new Set(pending);
    pending.clear();
    const turn = this.dependencies.getTurn(sessionId);
    if (!turn?.sessionKey) return;

    try {
      const messages = await this.dependencies.requestHistory(
        turn.sessionKey,
        Math.min(toolCallIds.size * 3 + 5, 30),
      );
      const currentTurn = this.dependencies.getTurn(sessionId);
      if (!messages || currentTurn?.turnToken !== turn.turnToken) return;
      this.dependencies.handleThinkingHistory(sessionId, messages);
    } catch (error) {
      console.warn('[OpenClawRuntime] tool-boundary thinking history sync failed:', error);
    } finally {
      if (this.pendingThinkingToolCallIds.get(sessionId)?.size && this.dependencies.getTurn(sessionId)) {
        this.schedule(
          this.thinkingTimers,
          sessionId,
          THINKING_SYNC_DEBOUNCE_MS,
          () => this.executeThinking(sessionId),
        );
      }
    }
  }

  private async executeBackfill(sessionId: string): Promise<void> {
    const pending = this.pendingBackfillToolCallIds.get(sessionId);
    if (!pending?.size) return;

    const toolCallIds = new Set(pending);
    pending.clear();
    const turn = this.dependencies.getTurn(sessionId);
    if (!turn?.sessionKey) {
      this.pendingBackfillToolCallIds.delete(sessionId);
      return;
    }

    try {
      const messages = await this.dependencies.requestHistory(
        turn.sessionKey,
        Math.min(toolCallIds.size * 3 + 5, 30),
      );
      const currentTurn = this.dependencies.getTurn(sessionId);
      if (!messages || currentTurn?.turnToken !== turn.turnToken) return;
      this.dependencies.handleBackfillHistory(sessionId, messages);
    } catch (error) {
      console.warn('[OpenClawRuntime] incremental backfill chat.history fetch failed:', error);
      const currentPending = this.pendingBackfillToolCallIds.get(sessionId) ?? new Set<string>();
      toolCallIds.forEach((toolCallId) => currentPending.add(toolCallId));
      this.pendingBackfillToolCallIds.set(sessionId, currentPending);
    } finally {
      if (this.pendingBackfillToolCallIds.get(sessionId)?.size && this.dependencies.getTurn(sessionId)) {
        this.schedule(
          this.backfillTimers,
          sessionId,
          TOOL_RESULT_BACKFILL_DEBOUNCE_MS,
          () => this.executeBackfill(sessionId),
        );
      }
    }
  }
}
