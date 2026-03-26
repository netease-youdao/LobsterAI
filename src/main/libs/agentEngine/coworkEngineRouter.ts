import { EventEmitter } from 'events';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
} from './types';
import { ENGINE_SWITCHED_CODE } from './types';

type RouterDeps = {
  openclawRuntime: CoworkRuntime;
};

export class CoworkEngineRouter extends EventEmitter implements CoworkRuntime {
  private readonly runtime: CoworkRuntime;
  private readonly sessionEngine = new Map<string, true>();
  private readonly requestEngine = new Map<string, true>();
  private readonly requestSession = new Map<string, string>();

  constructor(deps: RouterDeps) {
    super();
    this.runtime = deps.openclawRuntime;
    this.bindRuntimeEvents(this.runtime);
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
    this.sessionEngine.set(sessionId, true);
    try {
      await this.runtime.startSession(sessionId, prompt, options);
    } catch (error) {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      throw error;
    }
  }

  async continueSession(sessionId: string, prompt: string, options: CoworkContinueOptions = {}): Promise<void> {
    this.sessionEngine.set(sessionId, true);
    try {
      await this.runtime.continueSession(sessionId, prompt, options);
    } catch (error) {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      throw error;
    }
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
    this.runtime.respondToPermission(requestId, result);
    if (result.behavior === 'allow' || result.behavior === 'deny') {
      this.requestEngine.delete(requestId);
      this.requestSession.delete(requestId);
    }
  }

  isSessionActive(sessionId: string): boolean {
    return this.runtime.isSessionActive(sessionId);
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.runtime.getSessionConfirmationMode(sessionId);
  }

  onSessionDeleted(sessionId: string): void {
    this.sessionEngine.delete(sessionId);
    this.clearRequestEngineBySession(sessionId);
    this.runtime.onSessionDeleted?.(sessionId);
  }

  handleEngineConfigChanged(): void {
    const activeSessionIds = Array.from(this.sessionEngine.keys())
      .filter((sessionId) => this.runtime.isSessionActive(sessionId));
    this.stopAllSessions();

    activeSessionIds.forEach((sessionId) => {
      this.emit('error', sessionId, ENGINE_SWITCHED_CODE);
    });
  }

  private bindRuntimeEvents(runtime: CoworkRuntime): void {
    runtime.on('message', (sessionId, message) => {
      this.sessionEngine.set(sessionId, true);
      this.emit('message', sessionId, message);
    });

    runtime.on('messageUpdate', (sessionId, messageId, content) => {
      this.sessionEngine.set(sessionId, true);
      this.emit('messageUpdate', sessionId, messageId, content);
    });

    runtime.on('permissionRequest', (sessionId, request) => {
      this.sessionEngine.set(sessionId, true);
      this.requestEngine.set(request.requestId, true);
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
  }

  private clearRequestEngineBySession(sessionId: string): void {
    for (const [requestId, requestSessionId] of this.requestSession.entries()) {
      if (requestSessionId !== sessionId) continue;
      this.requestSession.delete(requestId);
      this.requestEngine.delete(requestId);
    }
  }
}
