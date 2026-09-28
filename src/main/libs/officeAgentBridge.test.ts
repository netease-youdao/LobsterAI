import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { OfficeAgentRequest } from '../../shared/artifactPreview/officeEditing';
import { SHEET_AGENT_TIMEOUT_MS, SheetAgentTool } from '../../shared/artifactPreview/sheetAgent';
import { SheetFileIpc } from '../../shared/artifactPreview/sheetEditing';
import { OfficeAgentBridge } from './officeAgentBridge';

function fakeWindow() {
  const sent: { channel: string; request: OfficeAgentRequest }[] = [];
  const mainFrame = {};
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    send: (channel: string, request: OfficeAgentRequest) => { sent.push({ channel, request }); },
  };
  const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
  return { window, webContents, mainFrame, sent };
}

const bridgeFor = (getWindow: () => BrowserWindow | null) => new OfficeAgentBridge({
  getWindow, tools: Object.values(SheetAgentTool), requestChannel: SheetFileIpc.AgentRequest,
  timeoutMs: SHEET_AGENT_TIMEOUT_MS, editorName: 'Excel', logTag: '[SheetAgent]',
});

describe('OfficeAgentBridge', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('forwards a call to the main window and resolves with its answer', async () => {
    const { window, webContents, mainFrame, sent } = fakeWindow();
    const bridge = bridgeFor(() => window);
    const call = bridge.call(SheetAgentTool.Read, { path: '/tmp/a.xlsx' });
    expect(sent[0]).toMatchObject({ channel: SheetFileIpc.AgentRequest, request: { tool: SheetAgentTool.Read, args: { path: '/tmp/a.xlsx' } } });
    const { requestId } = sent[0].request;
    // Another frame cannot answer for the window, and malformed results are replaced.
    bridge.handleResponse({ sender: webContents, senderFrame: {} } as never, { requestId, result: { content: [{ type: 'text', text: 'forged' }] } });
    bridge.handleResponse({ sender: webContents, senderFrame: mainFrame } as never, { requestId, result: { content: [{ type: 'text', text: 'ok' }] } });
    await expect(call).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    const second = bridge.call(SheetAgentTool.Edit, {});
    bridge.handleResponse({ sender: webContents, senderFrame: mainFrame } as never, { requestId: sent[1].request.requestId, result: { content: 'bad' } });
    expect((await second).isError).toBe(true);
  });

  test('refuses unknown tools, times out, and fails calls when the window is gone', async () => {
    const { window } = fakeWindow();
    const bridge = bridgeFor(() => window);
    expect((await bridge.call('word_read', {})).isError).toBe(true);
    const pending = bridge.call(SheetAgentTool.Edit, {});
    vi.advanceTimersByTime(SHEET_AGENT_TIMEOUT_MS + 1);
    expect((await pending).isError).toBe(true);
    expect((await bridgeFor(() => null).call(SheetAgentTool.Read, {})).isError).toBe(true);
  });

  test('cancels outstanding calls when the renderer goes away', async () => {
    const { window } = fakeWindow();
    const bridge = bridgeFor(() => window);
    const pending = bridge.call(SheetAgentTool.Read, {});
    bridge.cancelAll('reloaded');
    await expect(pending).resolves.toEqual({ content: [{ type: 'text', text: 'reloaded' }], isError: true });
  });
});
