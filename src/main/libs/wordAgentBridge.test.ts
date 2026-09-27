import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { WORD_AGENT_TIMEOUT_MS, WordAgentIpc, type WordAgentRequest, WordAgentTool } from '../../shared/artifactPreview/wordAgent';
import { WordAgentBridge } from './wordAgentBridge';

function fakeWindow() {
  const sent: { channel: string; request: WordAgentRequest }[] = [];
  const mainFrame = {};
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    send: (channel: string, request: WordAgentRequest) => { sent.push({ channel, request }); },
  };
  const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
  return { window, webContents, mainFrame, sent };
}

describe('WordAgentBridge', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('forwards a call to the main window and resolves with its answer', async () => {
    const { window, webContents, mainFrame, sent } = fakeWindow();
    const bridge = new WordAgentBridge(() => window);
    const call = bridge.call(WordAgentTool.Read, { path: '/tmp/a.docx' });
    expect(sent[0]).toMatchObject({ channel: WordAgentIpc.Request, request: { tool: WordAgentTool.Read, args: { path: '/tmp/a.docx' } } });
    const { requestId } = sent[0].request;
    // Another frame cannot answer for the window.
    bridge.handleResponse({ sender: webContents, senderFrame: {} } as never, { requestId, result: { content: [{ type: 'text', text: 'forged' }] } });
    bridge.handleResponse({ sender: webContents, senderFrame: mainFrame } as never, { requestId, result: { content: [{ type: 'text', text: 'ok' }] } });
    await expect(call).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  test('refuses unknown tools, times out, and fails calls when the window is gone', async () => {
    const { window } = fakeWindow();
    const bridge = new WordAgentBridge(() => window);
    expect((await bridge.call('shell_exec', {})).isError).toBe(true);
    const pending = bridge.call(WordAgentTool.Edit, {});
    vi.advanceTimersByTime(WORD_AGENT_TIMEOUT_MS + 1);
    expect((await pending).isError).toBe(true);
    expect((await new WordAgentBridge(() => null).call(WordAgentTool.Read, {})).isError).toBe(true);
  });

  test('cancels outstanding calls when the renderer goes away', async () => {
    const { window } = fakeWindow();
    const bridge = new WordAgentBridge(() => window);
    const pending = bridge.call(WordAgentTool.Read, {});
    bridge.cancelAll('reloaded');
    await expect(pending).resolves.toEqual({ content: [{ type: 'text', text: 'reloaded' }], isError: true });
  });
});
