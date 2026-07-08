import { EventEmitter } from 'events';

import type { OpenClawSessionPatch } from '../../../common/openclawSession';
import type { CoworkGoal } from '../../../shared/cowork/goal';
import type {
  CoworkAgentEngine,
  CoworkContextUsage,
  CoworkContinueOptions,
  CoworkForkCompactionSummary,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkSessionPatchResult,
  CoworkStartOptions,
  PermissionResult,
} from './types';
import { ENGINE_SWITCHED_CODE } from './types';

type RouterDeps = {
  getCurrentEngine: () => CoworkAgentEngine;
  openclawRuntime: CoworkRuntime;
};

export class CoworkEngineRouter extends EventEmitter implements CoworkRuntime {
  private readonly getCurrentEngine: () => CoworkAgentEngine;
  private readonly runtime: CoworkRuntime;
  private readonly sessionEngine = new Map<string, CoworkAgentEngine>();
  private readonly requestEngine = new Map<string, CoworkAgentEngine>();
  private readonly requestSession = new Map<string, string>();
  private currentEngine: CoworkAgentEngine;

  constructor(deps: RouterDeps) {
    super();
    this.getCurrentEngine = deps.getCurrentEngine;
    this.runtime = deps.openclawRuntime;
    this.currentEngine = this.safeResolveEngine();

    this.bindRuntimeEvents('openclaw', deps.openclawRuntime);
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(sessionId: string, prompt: string, options: CoworkStartOptions = {}): Promise<void> {
    const engine = this.safeResolveEngine();
    this.sessionEngine.set(sessionId, engine);
    try {
      await this.runtime.startSession(sessionId, prompt, options);
    } catch (error) {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      throw error;
    }
  }

  async continueSession(sessionId: string, prompt: string, options: CoworkContinueOptions = {}): Promise<void> {
    const engine = this.safeResolveEngine();
    this.sessionEngine.set(sessionId, engine);
    try {
      await this.runtime.continueSession(sessionId, prompt, options);
    } catch (error) {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      throw error;
    }
  }

  async runGoalCommand(sessionId: string, command: string): Promise<CoworkGoal | null> {
    const engine = this.safeResolveEngine();
    this.sessionEngine.set(sessionId, engine);
    if (!this.runtime.runGoalCommand) {
      throw new Error(`Goal commands are not supported by engine: ${engine}`);
    }
    return this.runtime.runGoalCommand(sessionId, command);
  }

  async patchSession(sessionId: string, patch: OpenClawSessionPatch): Promise<CoworkSessionPatchResult | void> {
    const engine = this.safeResolveEngine();
    this.sessionEngine.set(sessionId, engine);
    if (!this.runtime.patchSession) {
      throw new Error(`Session patch is not supported by engine: ${engine}`);
    }
    return this.runtime.patchSession(sessionId, patch);
  }

  async getContextUsage(sessionId: string): Promise<CoworkContextUsage | null> {
    if (!this.runtime.getContextUsage) {
      return null;
    }
    return this.runtime.getContextUsage(sessionId);
  }

  async compactContext(sessionId: string): Promise<{ compacted: boolean; reason?: string; usage?: CoworkContextUsage | null }> {
    const engine = this.safeResolveEngine();
    this.sessionEngine.set(sessionId, engine);
    if (!this.runtime.compactContext) {
      throw new Error(`Context compaction is not supported by engine: ${engine}`);
    }
    return this.runtime.compactContext(sessionId);
  }

  async getForkCompactionSummary(sessionId: string, beforeCreatedAt?: number): Promise<CoworkForkCompactionSummary | null> {
    if (!this.runtime.getForkCompactionSummary) {
      return null;
    }
    return this.runtime.getForkCompactionSummary(sessionId, beforeCreatedAt);
  }

  stopSession(sessionId: string): void {
    this.runtime.stopSession(sessionId);
    this.sessionEngine.delete(sessionId);
    this.clearRequestEngineBySession(sessionId);
  }

  stopAllSessions(): void {
    this.runtime.stopAllSessions();
    this.sessionEngine.clear();
    this.requestEngine.clear();
    this.requestSession.clear();
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const engine = this.requestEngine.get(requestId);
    if (engine) {
      this.runtime.respondToPermission(requestId, result);
      if (result.behavior === 'allow' || result.behavior === 'deny') {
        this.requestEngine.delete(requestId);
        this.requestSession.delete(requestId);
      }
      return;
    }

    this.runtime.respondToPermission(requestId, result);
  }

  isSessionActive(sessionId: string): boolean {
    return this.runtime.isSessionActive(sessionId);
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.runtime.getSessionConfirmationMode(sessionId);
  }

  async deleteSubagentSession(parentSessionId: string, runId: string): Promise<boolean> {
    if (!this.runtime.deleteSubagentSession) {
      return false;
    }
    return this.runtime.deleteSubagentSession(parentSessionId, runId);
  }

  onSessionDeleted(sessionId: string): void {
    this.sessionEngine.delete(sessionId);
    this.clearRequestEngineBySession(sessionId);
    this.runtime.onSessionDeleted?.(sessionId);
  }

  handleEngineConfigChanged(nextEngine: CoworkAgentEngine): void {
    if (nextEngine === this.currentEngine) {
      return;
    }

    this.currentEngine = nextEngine;
    const activeSessionIds = Array.from(this.sessionEngine.keys())
      .filter((sessionId) => this.runtime.isSessionActive(sessionId));
    this.stopAllSessions();

    activeSessionIds.forEach((sessionId) => {
      this.emit('error', sessionId, ENGINE_SWITCHED_CODE);
    });
  }

  private bindRuntimeEvents(engine: CoworkAgentEngine, runtime: CoworkRuntime): void {
    runtime.on('message', (sessionId, message, beforeMessageId) => {
      this.sessionEngine.set(sessionId, engine);
      this.emit('message', sessionId, message, beforeMessageId);
    });

    runtime.on('messageUpdate', (sessionId, messageId, content, metadata) => {
      this.sessionEngine.set(sessionId, engine);
      this.emit('messageUpdate', sessionId, messageId, content, metadata);
    });

    runtime.on('sessionStatus', (sessionId, status) => {
      if (status === 'running') {
        this.sessionEngine.set(sessionId, engine);
      }
      this.emit('sessionStatus', sessionId, status);
    });

    runtime.on('contextUsageUpdate', (sessionId, usage) => {
      this.sessionEngine.set(sessionId, engine);
      this.emit('contextUsageUpdate', sessionId, usage);
    });

    runtime.on('contextMaintenance', (sessionId, active) => {
      this.sessionEngine.set(sessionId, engine);
      this.emit('contextMaintenance', sessionId, active);
    });

    runtime.on('permissionRequest', (sessionId, request) => {
      this.sessionEngine.set(sessionId, engine);
      this.requestEngine.set(request.requestId, engine);
      this.requestSession.set(request.requestId, sessionId);
      this.emit('permissionRequest', sessionId, request);
    });

    runtime.on('complete', (sessionId, claudeSessionId) => {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      this.emit('complete', sessionId, claudeSessionId);
    });

    runtime.on('error', (sessionId, error) => {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      this.emit('error', sessionId, error);
    });

    runtime.on('sessionStopped', (sessionId) => {
      this.emit('sessionStopped', sessionId);
    });
  }

  private clearRequestEngineBySession(sessionId: string): void {
    for (const [requestId, requestSessionId] of this.requestSession.entries()) {
      if (requestSessionId !== sessionId) continue;
      this.requestSession.delete(requestId);
      this.requestEngine.delete(requestId);
    }
  }

  private safeResolveEngine(): CoworkAgentEngine {
    this.currentEngine = this.getCurrentEngine();
    return this.currentEngine;
  }
}
