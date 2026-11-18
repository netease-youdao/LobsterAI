import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import { FEEDBACK_LIMITS, FeedbackCategory, FeedbackError, type FeedbackInput, FeedbackIpc, isValidFeedback } from '../../shared/feedback/constants';
import { registerFeedbackIpc } from './feedbackIpc';
import { collectFeedbackLogs } from './feedbackLogs';

vi.mock('./feedbackLogs', async importOriginal => ({
  ...await importOriginal<typeof import('./feedbackLogs')>(),
  collectFeedbackLogs: vi.fn(async () => Buffer.from('PK\u0003\u0004test')),
}));

const input = (): FeedbackInput => ({
  requestId: '1b7da56a-172f-424d-bd77-4ec5c14bdfb3', category: FeedbackCategory.AiReport,
  content: 'Report of generated content', includeLogs: false, images: [],
});

function setup(authenticated = true) {
  let handler!: (event: IpcMainInvokeEvent, value: FeedbackInput) => Promise<unknown>;
  const mainFrame = {};
  const webContents = { mainFrame };
  const getLogEntries = vi.fn(() => []);
  const fetchWithAuth = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { id: 42 } })));
  registerFeedbackIpc({
    ipcMain: { handle: (channel, callback) => { expect(channel).toBe(FeedbackIpc.Submit); handler = callback; } } as IpcMain,
    getMainWindow: () => ({ isDestroyed: () => false, webContents }) as unknown as BrowserWindow,
    hasAuthTokens: () => authenticated,
    getServerBaseUrl: () => 'http://127.0.0.1:18879', getClientVersion: () => '2026.10.16', getLogEntries, fetchWithAuth,
  });
  return { submit: (value: FeedbackInput, frame = mainFrame) => handler({ sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent, value), fetchWithAuth, getLogEntries };
}

describe('feedback submission', () => {
  test('does not read or upload logs when consent is unchecked', async () => {
    const app = setup();
    expect(await app.submit(input())).toEqual({ success: true, id: 42 });
    expect(app.getLogEntries).not.toHaveBeenCalled();
    const request = app.fetchWithAuth.mock.calls[0] as unknown as [string, RequestInit];
    const form = request[1].body as FormData;
    expect(form.get('logs')).toBeNull();
    expect(form.get('includeLogs')).toBe('false');
    expect(form.get('content')).toBe(input().content);
  });
  test('uploads a diagnostic archive only when requested', async () => {
    const app = setup();
    expect(await app.submit({ ...input(), includeLogs: true })).toEqual({ success: true, id: 42 });
    expect(collectFeedbackLogs).toHaveBeenCalled();
    const request = app.fetchWithAuth.mock.calls[0] as unknown as [string, RequestInit];
    expect((request[1].body as FormData).get('logs')).toBeInstanceOf(Blob);
  });
  test('rejects an embedded frame before accessing logs or the network', async () => {
    const app = setup();
    expect(await app.submit(input(), {})).toEqual({ success: false, error: FeedbackError.Invalid });
    expect(app.fetchWithAuth).not.toHaveBeenCalled();
  });
  test('requires a signed in account', async () => {
    const app = setup(false);
    expect(await app.submit(input())).toEqual({ success: false, error: FeedbackError.Unauthorized });
    expect(app.getLogEntries).not.toHaveBeenCalled();
  });
  test('checks content, type, attachment count and size at the IPC boundary', () => {
    expect(isValidFeedback(input())).toBe(true);
    expect(isValidFeedback({ ...input(), content: '   ' })).toBe(false);
    expect(isValidFeedback({ ...input(), content: 'a'.repeat(FEEDBACK_LIMITS.content + 1) })).toBe(false);
    const image = { name: 'test.png', type: 'image/png', bytes: new Uint8Array([1]) };
    expect(isValidFeedback({ ...input(), images: Array.from({ length: 11 }, () => image) })).toBe(false);
    expect(isValidFeedback({ ...input(), images: [{ ...image, type: 'image/svg+xml' }] })).toBe(false);
    expect(isValidFeedback({ ...input(), images: [{ ...image, bytes: new Uint8Array(FEEDBACK_LIMITS.imageBytes + 1) }] })).toBe(false);
  });
  test('never exposes extra server fields or storage URLs through IPC', async () => {
    const app = setup();
    app.fetchWithAuth.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0, data: { id: 42, url: 'https://cdn.invalid/private.zip', attachments: [{ url: 'secret' }] },
    })));
    expect(await app.submit(input())).toEqual({ success: true, id: 42 });
  });
});
