import crypto from 'crypto';
import { app, BrowserWindow } from 'electron';
import path from 'path';

import { ASK_USER_QUESTION_TOOL_NAME, CoworkIpcChannel, SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../../shared/cowork/constants';
import { McpIpcChannel } from '../../shared/mcp/constants';
import { isComputerUseKitInstalled } from '../computerUse/computerUseKit';
import { resolveComputerUseMcpServer } from '../computerUse/computerUseMcpServer';
import { installComputerUseRuntime } from '../computerUse/computerUseRuntime';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { getElectronNodeRuntimePath } from '../libs/coworkUtil';
import {
  type AskUserRequest,
  type AskUserResponse,
  AskUserResponseReason,
  type BrowserToolRequest,
  type BrowserToolResponse,
  McpBridgeServer,
  type MediaGenerationRequest,
  type MediaGenerationResponse,
} from '../libs/mcpBridgeServer';
import { OpenClawConfigImpact } from '../libs/openclawConfigImpact';
import type { ResolvedMcpServer } from '../libs/openclawConfigSync';
import { resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey } from '../libs/openclawLocalSessionResolver';
import { resolveStdioCommand } from '../libs/resolveStdioCommand';
import type { SqliteStore } from '../sqliteStore';
import { createMcpLaunchSourceFingerprint, McpLaunchResolutionStatus } from './mcpLaunchResolution';
import { McpLaunchResolverManager } from './mcpLaunchResolverManager';
import { McpStore } from './mcpStore';

export type { AskUserResponse, MediaGenerationRequest, MediaGenerationResponse };

function questionStatus(response: AskUserResponse): 'answered' | 'cancelled' | 'expired' | 'unavailable' {
  if (response.reason === AskUserResponseReason.Timeout) return 'expired';
  if (response.reason === AskUserResponseReason.Unavailable) return 'unavailable';
  return response.behavior === 'allow' ? 'answered' : 'cancelled';
}

function questionAnswers(request: AskUserRequest, response: AskUserResponse): Record<string, string[]> {
  return Object.fromEntries(request.questions.map((question, index) => {
    const value = response.answers?.[question.question];
    return [`q_${index}`, typeof value !== 'string' || !value ? []
      : question.multiSelect ? value.split('|||').map(item => item.trim()).filter(Boolean) : [value]];
  }));
}

export interface McpRuntimeDeps {
  /** Shared with the IPC ownership check; only live question IDs are registered here. */
  permissionSessions: Map<string, string>;
  getStore: () => SqliteStore;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
    expectedImpact?: OpenClawConfigImpact;
  }) => Promise<{ success: boolean; changed: boolean }>;
  /** Fired when an AskUserQuestion request is surfaced to the renderer. */
  onAskUserRequested?: (sessionId: string, request: { requestId: string; toolName: string }) => void;
  /** Fired when a pending AskUserQuestion request is dismissed upstream. */
  onAskUserDismissed?: (requestId: string) => void;
  registerQuestion?: NonNullable<CoworkRuntime['registerQuestion']>;
  settleQuestion?: NonNullable<CoworkRuntime['settleQuestion']>;
}

export class McpRuntime {
  private mcpStore: McpStore | null = null;
  private launchResolverManager: McpLaunchResolverManager | null = null;
  private bridgeServer: McpBridgeServer | null = null;
  private readonly bridgeSecret = crypto.randomUUID();
  private readonly remoteQuestions = new Map<string, { request: AskUserRequest; terminal?: AskUserResponse }>();
  private resolvedServersCache: ResolvedMcpServer[] = [];
  private mediaGenerationHandler:
    | ((request: MediaGenerationRequest) => Promise<MediaGenerationResponse>)
    | null = null;
  private browserToolHandler:
    | ((request: BrowserToolRequest) => Promise<BrowserToolResponse>)
    | null = null;

  constructor(private readonly deps: McpRuntimeDeps) {}

  getStore(): McpStore {
    if (!this.mcpStore) {
      const sqliteStore = this.deps.getStore();
      this.mcpStore = new McpStore(sqliteStore.getDatabase());
    }
    return this.mcpStore;
  }

  getLaunchResolverManager(): McpLaunchResolverManager {
    if (!this.launchResolverManager) {
      this.launchResolverManager = new McpLaunchResolverManager(
        this.getStore(),
        () => this.broadcastServersChanged(),
        reason => {
          this.deps.syncOpenClawConfig({
            reason,
            expectedImpact: OpenClawConfigImpact.Sync,
          }).catch(err =>
            console.error('[MCP] config sync error after launch resolution:', err),
          );
        },
      );
    }
    return this.launchResolverManager;
  }

  ensureLaunchResolution(serverId: string, reason: string): void {
    this.getLaunchResolverManager().ensureResolved(serverId, reason);
  }

  setMediaGenerationHandler(
    handler: (request: MediaGenerationRequest) => Promise<MediaGenerationResponse>,
  ): void {
    this.mediaGenerationHandler = handler;
  }

  setBrowserToolHandler(
    handler: (request: BrowserToolRequest) => Promise<BrowserToolResponse>,
  ): void {
    this.browserToolHandler = handler;
    this.bridgeServer?.onBrowserTool(handler);
  }

  getAskUserCallbackUrl(): string | null {
    return this.bridgeServer?.askUserCallbackUrl ?? null;
  }

  getMediaCallbackUrl(): string | null {
    return this.bridgeServer?.mediaCallbackUrl ?? null;
  }

  getBrowserCallbackUrl(): string | null {
    return this.bridgeServer?.browserCallbackUrl ?? null;
  }

  getBridgeSecret(): string {
    return this.bridgeSecret;
  }

  getResolvedServersCache(): ResolvedMcpServer[] {
    return this.resolvedServersCache;
  }

  async refreshResolvedServersCache(): Promise<ResolvedMcpServer[]> {
    this.resolvedServersCache = await this.getResolvedServers();
    return this.resolvedServersCache;
  }

  clearResolvedServersCache(): void {
    this.resolvedServersCache = [];
  }

  async startAskUserServer(): Promise<void> {
    if (this.bridgeServer?.port) return;

    if (!this.bridgeServer) {
      this.bridgeServer = new McpBridgeServer(this.bridgeSecret);
    }
    console.log('[AskUser] starting HTTP callback server...');
    await this.bridgeServer.start();

    this.bridgeServer.onAskUser(request => {
      const sessionId = request.sessionKey
        ? resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey(
            this.deps.getStore().getDatabase(),
            request.sessionKey,
          )
        : SESSION_AGNOSTIC_PERMISSION_SESSION_ID;
      if (!sessionId) {
        console.warn('[AskUser] denied request for non-desktop or unknown session:', request.sessionKey);
        this.resolveAskUser(request.requestId, { behavior: 'deny' });
        return;
      }
      this.deps.permissionSessions.set(request.requestId, sessionId);
      this.registerQuestion(sessionId, request);
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send(CoworkIpcChannel.StreamPermission, {
            sessionId,
            request: {
              requestId: request.requestId,
              toolName: ASK_USER_QUESTION_TOOL_NAME,
              toolInput: {
                questions: request.questions,
                ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
              },
            },
          });
        } catch (error) {
          console.error('[AskUser] failed to send permission request to window:', error);
        }
      });
      this.deps.onAskUserRequested?.(sessionId, {
        requestId: request.requestId,
        toolName: ASK_USER_QUESTION_TOOL_NAME,
      });
    });

    this.bridgeServer.onAskUserSettled((requestId, response) => {
      const pending = this.remoteQuestions.get(requestId);
      if (!pending) return;
      pending.terminal = response;
      this.remoteQuestions.delete(requestId);
      this.deps.settleQuestion?.(requestId, {
        status: questionStatus(response),
        ...(response.behavior === 'allow' ? { answers: questionAnswers(pending.request, response) } : {}),
      });
    });

    this.bridgeServer.onAskUserDismiss(requestId => {
      this.deps.permissionSessions.delete(requestId);
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send(CoworkIpcChannel.StreamPermissionDismiss, { requestId });
        } catch {
          // ignore
        }
      });
      this.deps.onAskUserDismissed?.(requestId);
    });

    this.bridgeServer.onMediaGeneration(async (request) => {
      if (!this.mediaGenerationHandler) {
        return {
          content: [{ type: 'text', text: 'Media generation service is not ready yet.' }],
          isError: true,
        };
      }
      return await this.mediaGenerationHandler(request);
    });

    if (this.browserToolHandler) {
      this.bridgeServer.onBrowserTool(this.browserToolHandler);
    }
  }

  /** Only a verified desktop session may publish a legacy form to remote control. */
  private registerQuestion(sessionId: string, request: AskUserRequest): void {
    if (!this.deps.registerQuestion || !request.sessionKey || sessionId === SESSION_AGNOSTIC_PERMISSION_SESSION_ID) return;
    try {
      // Do not discard a secret marker while adapting the ordinary form contract.
      if (request.questions.some(question => {
        const raw = question as unknown as Record<string, unknown>;
        return raw.isSecret === true || raw.secretStore !== undefined;
      })) return;
      // Legacy answers use the question text as their key; duplicate keys cannot round-trip.
      if (new Set(request.questions.map(question => question.question)).size !== request.questions.length) return;
      const snapshot: AskUserRequest = { ...request, questions: request.questions.map(question => ({
        ...question, options: question.options.map(option => ({ ...option })),
      })) };
      const pending: { request: AskUserRequest; terminal?: AskUserResponse } = { request: snapshot };
      this.remoteQuestions.set(request.requestId, pending);
      const registered = this.deps.registerQuestion({
        requestId: request.requestId, sessionId, kind: 'legacy',
        createdAt: request.createdAt, expiresAt: request.expiresAt,
        questions: snapshot.questions.map((question, index) => ({
          questionId: `q_${index}`, header: question.header ?? '', question: question.question,
          options: question.options, multiSelect: question.multiSelect === true, isOther: true, allowSkip: true,
        })),
        resolve: response => {
          const answers: Record<string, string> = Object.create(null);
          const skippedQuestionIds: string[] = [];
          if (response.action === 'answer') snapshot.questions.forEach((question, index) => {
            const values = response.answers[`q_${index}`] ?? [];
            if (values.length) answers[question.question] = question.multiSelect ? values.join('|||') : values[0];
            else skippedQuestionIds.push(question.id ?? `question-${index + 1}`);
          });
          const applied = this.resolveAskUser(request.requestId, response.action === 'answer'
            ? { behavior: 'allow', answers, ...(skippedQuestionIds.length ? { skippedQuestionIds } : {}) }
            : { behavior: 'deny' });
          if (!applied || !pending.terminal) return { kind: 'known_not_applied', reason: 'QUESTION_UNAVAILABLE' };
          if (pending.terminal.reason) return { kind: 'known_not_applied', status: questionStatus(pending.terminal), reason: 'QUESTION_UNAVAILABLE' };
          return { kind: 'confirmed', status: questionStatus(pending.terminal),
            ...(pending.terminal.behavior === 'allow' ? { answers: questionAnswers(snapshot, pending.terminal) } : {}) };
        },
      });
      if (!registered) this.remoteQuestions.delete(request.requestId);
    } catch (error) {
      this.remoteQuestions.delete(request.requestId);
      console.warn('[AskUser] remote question registration unavailable; local form remains usable', error instanceof Error ? error.name : 'Error');
    }
  }

  async askUserInternal(
    questions: AskUserRequest['questions'],
    timeoutMs?: number,
    options?: { sessionKey?: string },
  ): Promise<AskUserResponse | null> {
    if (!this.bridgeServer) return null;
    return await this.bridgeServer.askUserInternal(questions, timeoutMs, options);
  }

  resolveAskUser(requestId: string, response: AskUserResponse): boolean {
    return this.bridgeServer?.resolveAskUser(requestId, response) ?? false;
  }

  broadcastServersChanged(): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send(McpIpcChannel.Changed);
      } catch {
        // ignore destroyed windows
      }
    });
  }

  private async getResolvedServers(): Promise<ResolvedMcpServer[]> {
    const startedAt = Date.now();
    const enabledServers = this.getStore().getEnabledServers();
    const resolved: ResolvedMcpServer[] = [];
    let optimizedCount = 0;
    let skippedCount = 0;
    let rawCount = 0;
    let builtInCount = 0;

    const electronPath = getElectronNodeRuntimePath();
    const npmBinDir = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin')
      : '';
    const buildShimEnv = (): Record<string, string> => {
      const shimEnv: Record<string, string> = {
        LOBSTERAI_ELECTRON_PATH: electronPath,
      };
      if (npmBinDir) {
        shimEnv.LOBSTERAI_NPM_BIN_DIR = npmBinDir;
      }
      return shimEnv;
    };
    const pushRawStdioServer = async (server: typeof enabledServers[number]): Promise<void> => {
      const r = await resolveStdioCommand(server);
      resolved.push({
        name: server.name,
        transportType: 'stdio',
        command: r.command,
        args: r.args,
        env: { ...buildShimEnv(), ...(r.env || {}) },
      });
    };

    for (const server of enabledServers) {
      if (server.transportType === 'stdio') {
        const launchResolver = this.getLaunchResolverManager();
        if (launchResolver.canOptimize(server)) {
          const readyResolution = launchResolver.getReadyResolution(server);
          if (readyResolution) {
            optimizedCount++;
            const shimEnv: Record<string, string> = {
              LOBSTERAI_ELECTRON_PATH: electronPath,
            };
            if (npmBinDir) {
              shimEnv.LOBSTERAI_NPM_BIN_DIR = npmBinDir;
            }
            resolved.push({
              name: server.name,
              transportType: 'stdio',
              command: readyResolution.command,
              args: readyResolution.args || [],
              env: { ...shimEnv, ...(readyResolution.env || {}), ...(server.env || {}) },
            });
            continue;
          }

          const fingerprint = createMcpLaunchSourceFingerprint(server);
          const status = server.launchResolution?.sourceFingerprint === fingerprint
            ? server.launchResolution.status
            : McpLaunchResolutionStatus.Pending;
          if (
            status === McpLaunchResolutionStatus.Failed
            && launchResolver.shouldStartResolution(server, status)
          ) {
            skippedCount++;
            console.log(
              `[MCP] retrying stdio server "${server.name}" after recoverable managed launch resolution failure`,
            );
            this.ensureLaunchResolution(server.id, 'config-sync:recoverable-failed');
            continue;
          }
          if (
            status === McpLaunchResolutionStatus.Unsupported
            || status === McpLaunchResolutionStatus.Failed
          ) {
            rawCount++;
            if (status === McpLaunchResolutionStatus.Failed) {
              console.warn(
                `[MCP] using raw stdio command for server "${server.name}" because managed launch resolution failed`,
              );
            }
            await pushRawStdioServer(server);
            continue;
          }

          skippedCount++;
          console.log(
            `[MCP] skipping stdio server "${server.name}" while managed launch resolution is ${status}`,
          );
          if (launchResolver.shouldStartResolution(server, status)) {
            this.ensureLaunchResolution(server.id, `config-sync:${status}`);
          }
          continue;
        }

        rawCount++;
        await pushRawStdioServer(server);
      } else {
        resolved.push({
          name: server.name,
          transportType: server.transportType,
          url: server.url,
          headers: server.headers,
        });
      }
    }

    const askUserCallbackUrl = this.getAskUserCallbackUrl();
    const shouldEnableComputerUse = askUserCallbackUrl !== null
      && isComputerUseKitInstalled(this.deps.getStore());
    if (shouldEnableComputerUse) {
      const installResult = await installComputerUseRuntime();
      if (!installResult.success) {
        console.warn(`[MCP] failed to install Computer Use runtime: ${installResult.error || 'unknown error'}`);
      }
    }

    const computerUseServer = shouldEnableComputerUse
      ? resolveComputerUseMcpServer({
        askUserCallbackUrl,
        bridgeSecret: this.bridgeSecret,
        electronNodePath: electronPath,
      })
      : null;
    if (computerUseServer) {
      resolved.push(computerUseServer);
      builtInCount++;
    }

    console.log(
      `[MCP] resolved ${resolved.length}/${enabledServers.length} enabled server(s) for OpenClaw in ${Date.now() - startedAt}ms; optimized=${optimizedCount}, raw=${rawCount}, skipped=${skippedCount}, builtIn=${builtInCount}`,
    );
    return resolved;
  }
}
