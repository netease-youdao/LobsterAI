import { randomUUID } from 'node:crypto';

import type { BrowserWindow, IpcMainEvent } from 'electron';

import type { OfficeAgentRequest, OfficeAgentResponse, OfficeAgentToolResult } from '../../../shared/office/core/officeFile';

const failure = (text: string): OfficeAgentToolResult => ({ content: [{ type: 'text', text }], isError: true });

function isToolResult(value: unknown): value is OfficeAgentToolResult {
  const result = value as OfficeAgentToolResult | null;
  return !!result && Array.isArray(result.content)
    && result.content.every(block => block && block.type === 'text' && typeof block.text === 'string');
}

interface PendingCall {
  resolve: (result: OfficeAgentToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface OfficeAgentBridgeOptions {
  getWindow: () => BrowserWindow | null;
  tools: readonly string[];
  requestChannel: string;
  timeoutMs: number;
  /** Product name used in messages the agent reads, e.g. `Excel`. */
  editorName: string;
  logTag: string;
}

/**
 * Forwards agent tool calls to the main window, whose renderer owns the live editor. Only
 * that window's top frame may answer, and every call ends within the timeout.
 */
export class OfficeAgentBridge {
  private readonly pending = new Map<string, PendingCall>();
  private readonly tools: Set<string>;

  constructor(private readonly options: OfficeAgentBridgeOptions) {
    this.tools = new Set(options.tools);
  }

  /** Accept a reply from the renderer; anything else is ignored. */
  handleResponse = (event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>, response: unknown): void => {
    const owner = this.options.getWindow()?.webContents;
    if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) return;
    const { requestId, result } = (response ?? {}) as Partial<OfficeAgentResponse>;
    const call = typeof requestId === 'string' ? this.pending.get(requestId) : undefined;
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(requestId!);
    call.resolve(isToolResult(result) ? result : failure(`The ${this.options.editorName} editor returned an invalid result.`));
  };

  call(tool: string, args: Record<string, unknown>): Promise<OfficeAgentToolResult> {
    const { editorName } = this.options;
    if (!this.tools.has(tool)) return Promise.resolve(failure(`Unknown ${editorName} tool "${tool}".`));
    const window = this.options.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return Promise.resolve(failure(`LobsterAI's main window is not open, so the ${editorName} editor is unavailable.`));
    }
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        console.warn(`${this.options.logTag} Tool ${tool} timed out after ${this.options.timeoutMs}ms`);
        resolve(failure(`The ${editorName} editor did not answer in time. The file may be large or still opening; try again.`));
      }, this.options.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      window.webContents.send(this.options.requestChannel, { requestId, tool, args } satisfies OfficeAgentRequest);
    });
  }

  /** Fail outstanding calls, e.g. when the renderer reloads. */
  cancelAll(reason: string): void {
    for (const [requestId, call] of this.pending) {
      clearTimeout(call.timer);
      call.resolve(failure(reason));
      this.pending.delete(requestId);
    }
  }
}
