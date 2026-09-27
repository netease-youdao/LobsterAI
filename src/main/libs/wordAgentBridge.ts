import { randomUUID } from 'node:crypto';

import type { BrowserWindow, IpcMainEvent } from 'electron';

import {
  WORD_AGENT_TIMEOUT_MS, WordAgentIpc, type WordAgentRequest, type WordAgentResponse, WordAgentTool,
  type WordAgentToolResult,
} from '../../shared/artifactPreview/wordAgent';

const TOOLS = new Set<string>(Object.values(WordAgentTool));

const failure = (text: string): WordAgentToolResult => ({ content: [{ type: 'text', text }], isError: true });

function isToolResult(value: unknown): value is WordAgentToolResult {
  const result = value as WordAgentToolResult | null;
  return !!result && Array.isArray(result.content)
    && result.content.every(block => block && block.type === 'text' && typeof block.text === 'string');
}

interface PendingCall {
  resolve: (result: WordAgentToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Forwards agent Word tool calls to the main window, whose renderer owns the live editor.
 * Only that window's top frame may answer, and every call ends within the timeout.
 */
export class WordAgentBridge {
  private readonly pending = new Map<string, PendingCall>();

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /** Accept a reply from the renderer; anything else is ignored. */
  handleResponse = (event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>, response: unknown): void => {
    const owner = this.getWindow()?.webContents;
    if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) return;
    const { requestId, result } = (response ?? {}) as Partial<WordAgentResponse>;
    const call = typeof requestId === 'string' ? this.pending.get(requestId) : undefined;
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(requestId!);
    call.resolve(isToolResult(result) ? result : failure('The Word editor returned an invalid result.'));
  };

  call(tool: string, args: Record<string, unknown>): Promise<WordAgentToolResult> {
    if (!TOOLS.has(tool)) return Promise.resolve(failure(`Unknown Word tool "${tool}".`));
    const window = this.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return Promise.resolve(failure('LobsterAI\'s main window is not open, so the Word editor is unavailable.'));
    }
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        console.warn(`[WordAgent] Tool ${tool} timed out after ${WORD_AGENT_TIMEOUT_MS}ms`);
        resolve(failure('The Word editor did not answer in time. The document may be large or still opening; try again.'));
      }, WORD_AGENT_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      window.webContents.send(WordAgentIpc.Request, { requestId, tool: tool as WordAgentRequest['tool'], args } satisfies WordAgentRequest);
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
