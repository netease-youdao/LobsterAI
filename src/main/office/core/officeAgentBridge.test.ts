import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { OfficeAgentRequest } from '../../../shared/office/core/officeFile';
import { OFFICE_EDITORS } from '../../../shared/office/editors';
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

describe.each(OFFICE_EDITORS.map(editor => [editor.editorName, editor] as const))('%s agent bridge', (_name, editor) => {
  const [readTool, editTool] = editor.agent.tools.map(tool => tool.name);
  const bridgeFor = (getWindow: () => BrowserWindow | null) => new OfficeAgentBridge({
    getWindow, tools: editor.agent.tools.map(tool => tool.name), requestChannel: editor.channels.AgentRequest,
    timeoutMs: editor.agent.timeoutMs, editorName: editor.editorName, logTag: '[OfficeAgentTest]',
  });
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('forwards a call to the main window and resolves with its answer', async () => {
    const { window, webContents, mainFrame, sent } = fakeWindow();
    const bridge = bridgeFor(() => window);
    const call = bridge.call(readTool, { path: `/tmp/a${editor.extension}` });
    expect(sent[0]).toMatchObject({ channel: editor.channels.AgentRequest, request: { tool: readTool, args: { path: `/tmp/a${editor.extension}` } } });
    const { requestId } = sent[0].request;
    // Another frame cannot answer for the window, and malformed results are replaced.
    bridge.handleResponse({ sender: webContents, senderFrame: {} } as never, { requestId, result: { content: [{ type: 'text', text: 'forged' }] } });
    bridge.handleResponse({ sender: webContents, senderFrame: mainFrame } as never, { requestId, result: { content: [{ type: 'text', text: 'ok' }] } });
    await expect(call).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    const second = bridge.call(editTool, {});
    bridge.handleResponse({ sender: webContents, senderFrame: mainFrame } as never, { requestId: sent[1].request.requestId, result: { content: 'bad' } });
    expect((await second).isError).toBe(true);
  });

  test('refuses other editors\' tools, times out, and fails calls when the window is gone', async () => {
    const { window } = fakeWindow();
    const bridge = bridgeFor(() => window);
    const foreign = OFFICE_EDITORS.find(other => other.id !== editor.id)!.agent.tools[0].name;
    expect((await bridge.call(foreign, {})).isError).toBe(true);
    expect((await bridge.call('shell_exec', {})).isError).toBe(true);
    const pending = bridge.call(editTool, {});
    vi.advanceTimersByTime(editor.agent.timeoutMs + 1);
    expect((await pending).isError).toBe(true);
    expect((await bridgeFor(() => null).call(readTool, {})).isError).toBe(true);
  });

  test('cancels outstanding calls when the renderer goes away', async () => {
    const { window } = fakeWindow();
    const bridge = bridgeFor(() => window);
    const pending = bridge.call(readTool, {});
    bridge.cancelAll('reloaded');
    await expect(pending).resolves.toEqual({ content: [{ type: 'text', text: 'reloaded' }], isError: true });
  });
});
