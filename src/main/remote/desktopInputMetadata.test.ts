import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { RemoteRunStatus } from '../../shared/remote/constants';
import { RemoteFileReason } from '../../shared/remote/files';
import { RemoteInputIntent } from '../../shared/remote/input';
import { assertDesktopInputDispatchCurrent, captureDesktopInput, desktopInputCaptureEnabled, waitForDesktopInputCapture } from './desktopInputMetadata';
import * as snapshots from './remoteFileSnapshots';

const folders: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'desktop-input-')); folders.push(folder);
  const filePath = path.join(folder, 'report.txt'); writeFileSync(filePath, 'fixture content');
  return { filePath, deps: { owner: { userId: 'A', scopeKey: 'personal' }, fallbackText: `Read ${filePath}`, cacheRoot: path.join(folder, 'cache'), current: () => true,
    access: vi.fn(() => ({ assertAllowed: vi.fn() })) } };
}
it('captures only explicit picker files with frozen filesystem identity', async () => {
  const { filePath, deps } = fixture();
  const result = await captureDesktopInput({ text: 'Analyze this', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined, deps);
  expect(result).toMatchObject({ text: 'Analyze this', attachments: [{ path: filePath, fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '15' }] });
  expect(result?.attachments[0].fileIdentity.ino).toMatch(/^\d+$/u);
});
it('does not infer an upload from a path appearing in prompt text', async () => {
  const { deps } = fixture();
  expect(await captureDesktopInput(undefined, undefined, deps)).toBeNull();
  expect(deps.access).not.toHaveBeenCalled();
});
it('stops metadata capture when the account generation changes after stat', async () => {
  const { filePath, deps } = fixture(); let current = true;
  const result = await captureDesktopInput({ text: 'Analyze', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, current: () => current, access: () => ({ assertAllowed: () => { current = false; } }) });
  expect(result).toBeNull();
});
it('does not grant a hidden indexed attachment permission to upload', async () => {
  const { filePath, deps } = fixture();
  const result = await captureDesktopInput({ text: 'Analyze', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, access: () => { throw new Error('hidden'); } });
  expect(result?.attachments).toEqual([]);
});

it('does not freeze a mutable picker path later and misrepresent it as the engine input', async () => {
  const { filePath, deps } = fixture();
  const result = await captureDesktopInput({ text: 'Analyze', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, captureSnapshot: true });
  expect(result?.attachments).toHaveLength(1);
  expect(result?.attachments[0].snapshot).toBeUndefined();
});

it('retains metadata for inline images when file sync is unavailable without manufacturing a source', async () => {
  const { deps } = fixture();
  const result = await captureDesktopInput(undefined, [{ name: 'pasted.png', mimeType: 'image/png', base64Data: 'aGk=' }], deps);
  expect(result?.attachments).toMatchObject([{ fileName: 'pasted.png', path: '', sizeBytes: '2', intent: 'image' }]);
  expect(result?.attachments[0].snapshot).toBeUndefined();
  expect(deps.access).not.toHaveBeenCalled();
});

it('retains image metadata when immutable snapshot storage fails and cleans its temporary input', async () => {
  const { deps } = fixture();
  vi.spyOn(snapshots, 'captureRemoteFileSnapshot').mockRejectedValue(new Error(RemoteFileReason.Final));
  const result = await captureDesktopInput(undefined,
    [{ name: 'pasted.png', mimeType: 'image/png', base64Data: 'aGk=' }], { ...deps, captureSnapshot: true });
  expect(result?.attachments).toMatchObject([{ fileName: 'pasted.png', mimeType: 'image/png', sizeBytes: '2', captureReason: RemoteFileReason.Final }]);
  expect(result?.attachments[0].snapshot).toBeUndefined();
});
it('does not retain a snapshot result after the account changes during capture', async () => {
  const { deps } = fixture(); let current = true;
  vi.spyOn(snapshots, 'captureRemoteFileSnapshot').mockImplementation(async () => { current = false; throw new Error('ACCESS_DENIED'); });
  expect(await captureDesktopInput(undefined, [{ name: 'pasted.png', mimeType: 'image/png', base64Data: 'aGk=' }],
    { ...deps, current: () => current, captureSnapshot: true })).toBeNull();
});
it('does not expose raw filesystem errors as capture failure reasons', async () => {
  const { deps } = fixture();
  vi.spyOn(snapshots, 'captureRemoteFileSnapshot').mockRejectedValue(new Error('/private/secret: permission denied'));
  const result = await captureDesktopInput(undefined,
    [{ name: 'pasted.png', mimeType: 'image/png', base64Data: 'aGk=' }], { ...deps, captureSnapshot: true });
  expect(result?.attachments[0].captureReason).toBe(RemoteFileReason.Source);
});


it.each(['md', 'csv', 'json', 'yaml', 'py', 'pdf', 'docx', 'xlsx', 'pptx', 'mp3', 'mp4'])(
  'freezes an explicitly selected .%s input at dispatch without changing its local path', async extension => {
    const { filePath, deps } = fixture();
    const result = await captureDesktopInput({ text: 'Edit the original', attachments: [{ path: filePath, name: `input.${extension}`, intent: RemoteInputIntent.File }] }, undefined,
      { ...deps, captureSnapshot: true, selectedFileCaptureDeadline: performance.now() + 5000 });
    const attachment = result!.attachments[0];
    expect(attachment.path).toBe(filePath);
    expect(attachment.snapshot).toBeDefined();
    writeFileSync(filePath, 'edited by task');
    expect(readFileSync(attachment.snapshot!.path, 'utf8')).toBe('fixture content');
    expect(readFileSync(filePath, 'utf8')).toBe('edited by task');
  },
);

it('never starts a source capture after the fixed dispatch deadline', async () => {
  const { filePath, deps } = fixture();
  const capture = vi.spyOn(snapshots, 'captureRemoteFileSnapshot');
  const result = await captureDesktopInput({ text: '', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, captureSnapshot: true, selectedFileCaptureDeadline: performance.now() - 1 });
  expect(capture).not.toHaveBeenCalled();
  expect(result?.attachments[0]).toMatchObject({ captureReason: RemoteFileReason.Transfer });
  expect(result?.attachments[0].snapshot).toBeUndefined();
});

it('rejects and removes a source version changed after the send-time stat', async () => {
  const { filePath, deps } = fixture();
  const capture = snapshots.captureRemoteFileSnapshot;
  let copiedPath = '';
  vi.spyOn(snapshots, 'captureRemoteFileSnapshot').mockImplementation(async (...args) => {
    writeFileSync(filePath, 'new version after input inspection');
    const result = await capture(...args); copiedPath = result.path; return result;
  });
  const result = await captureDesktopInput({ text: '', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, captureSnapshot: true, selectedFileCaptureDeadline: performance.now() + 5000 });
  expect(result?.attachments[0]).toMatchObject({ captureReason: RemoteFileReason.Source });
  expect(result?.attachments[0].snapshot).toBeUndefined();
  expect(copiedPath).not.toBe('');
  expect(existsSync(copiedPath)).toBe(false);
});

it('rejects and cleans a late worker result even if its file bytes are unchanged', async () => {
  const { filePath, deps } = fixture();
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const capture = snapshots.captureRemoteFileSnapshot;
  let copiedPath = '';
  vi.spyOn(snapshots, 'captureRemoteFileSnapshot').mockImplementation(async (...args) => {
    const result = await capture(...args); copiedPath = result.path; now.mockReturnValue(251); return result;
  });
  const result = await captureDesktopInput({ text: '', attachments: [{ path: filePath, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, captureSnapshot: true, selectedFileCaptureDeadline: 250 });
  expect(result?.attachments[0]).toMatchObject({ captureReason: RemoteFileReason.Transfer });
  expect(result?.attachments[0].snapshot).toBeUndefined();
  expect(existsSync(copiedPath)).toBe(false);
});

it('refuses a symbolic-link attachment without changing the source', async () => {
  const { filePath, deps } = fixture(); const linked = `${filePath}.link`; symlinkSync(filePath, linked);
  const capture = vi.spyOn(snapshots, 'captureRemoteFileSnapshot');
  const result = await captureDesktopInput({ text: '', attachments: [{ path: linked, name: 'report.txt', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, captureSnapshot: true, selectedFileCaptureDeadline: performance.now() + 5000 });
  expect(result?.attachments).toEqual([]);
  expect(capture).not.toHaveBeenCalled();
  expect(readFileSync(filePath, 'utf8')).toBe('fixture content');
});

it('enforces allowed types, per-file size, and ten-file capture count', async () => {
  const { filePath, deps } = fixture();
  const blocked = await captureDesktopInput({ text: '', attachments: [{ path: filePath, name: 'file.exe', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, captureSnapshot: true, selectedFileCaptureDeadline: performance.now() + 5000 });
  expect(blocked?.attachments[0].captureReason).toBe(RemoteFileReason.Type);
  const many = await captureDesktopInput({ text: '', attachments: Array.from({ length: 11 }, (_, index) => ({ path: filePath, name: `${index}.txt`, intent: RemoteInputIntent.File })) }, undefined,
    { ...deps, captureSnapshot: true, selectedFileCaptureDeadline: performance.now() + 5000 });
  expect(many?.attachments.filter(item => item.snapshot)).toHaveLength(10);
  expect(many?.attachments[10].captureReason).toBe(RemoteFileReason.Size);
  writeFileSync(filePath, Buffer.alloc(5 * 1024 * 1024 + 1));
  const large = await captureDesktopInput({ text: '', attachments: [{ path: filePath, name: 'large.md', intent: RemoteInputIntent.File }] }, undefined,
    { ...deps, captureSnapshot: true, selectedFileCaptureDeadline: performance.now() + 5000 });
  expect(large?.attachments[0].captureReason).toBe(RemoteFileReason.Size);
});

it('lets local dispatch proceed after 250ms while a stalled capture remains isolated', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const before = performance.now();
  const record = vi.fn((deadline: number) => { expect(deadline).toBeGreaterThanOrEqual(before + 250); return new Promise<void>(() => undefined); });
  let dispatched = false;
  const dispatch = waitForDesktopInputCapture(record).then(() => { dispatched = true; });
  await vi.advanceTimersByTimeAsync(249); expect(dispatched).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await dispatch;
  expect(dispatched).toBe(true);
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0][0]).toBeGreaterThanOrEqual(before + 250);
});

it('does not fail local dispatch when input capture rejects or throws synchronously', async () => {
  await expect(waitForDesktopInputCapture(async () => { throw new Error('cache full'); })).resolves.toBeUndefined();
  await expect(waitForDesktopInputCapture(() => { throw new Error('cache unavailable'); })).resolves.toBeUndefined();
});


it('does not delay dispatch when remote file capture is disabled', async () => {
  const record = vi.fn(() => new Promise<void>(() => undefined));
  await expect(waitForDesktopInputCapture(record, false)).resolves.toBeUndefined();
  expect(record).toHaveBeenCalledWith(0);
});


it('keeps immutable image identity and MIME separate when selected images share a name', async () => {
  const { deps } = fixture();
  const result = await captureDesktopInput(undefined, [
    { name: 'image.png', mimeType: 'image/png', base64Data: Buffer.from('png input').toString('base64') },
    { name: 'image.png', mimeType: 'image/jpeg', base64Data: Buffer.from('jpeg input').toString('base64') },
  ], { ...deps, captureSnapshot: true });
  expect(result?.attachments.map(item => item.mimeType)).toEqual(['image/png', 'image/jpeg']);
  expect(result?.attachments.map(item => readFileSync(item.snapshot!.path, 'utf8'))).toEqual(['png input', 'jpeg input']);
});


it('treats remote capture-state failures as disabled and keeps local dispatch unblocked', async () => {
  const enabled = desktopInputCaptureEnabled(() => { throw new Error('remote storage unavailable'); });
  expect(enabled).toBe(false);
  expect(desktopInputCaptureEnabled(() => true)).toBe(true);
  expect(desktopInputCaptureEnabled(() => false)).toBe(false);
  await expect(waitForDesktopInputCapture(() => new Promise<void>(() => undefined), enabled)).resolves.toBeUndefined();
});

it('settles this exact undispatched local run after capture context becomes invalid', () => {
  const expected = { runId: 'local-run', status: RemoteRunStatus.Starting, statusVersion: '1', startedAt: null, finishedAt: null, error: null };
  const store = { run: () => ({ ...expected }), updateRun: vi.fn() };
  const failure = new Error('account changed during capture');
  expect(() => assertDesktopInputDispatchCurrent(store, 'session', expected, true, () => { throw failure; })).toThrow(failure);
  expect(store.updateRun).toHaveBeenCalledExactlyOnceWith('session', RemoteRunStatus.Cancelled);
});

it('does not settle a valid dispatch, remote-owned run, replacement, advanced version, or running task', () => {
  const expected = { runId: 'local-run', status: RemoteRunStatus.Starting, statusVersion: '1', startedAt: null, finishedAt: null, error: null };
  const updateRun = vi.fn();
  assertDesktopInputDispatchCurrent({ run: () => expected, updateRun }, 'session', expected, true, () => undefined);
  for (const [run, local] of [
    [expected, false], [{ ...expected, runId: 'new-run' }, true], [{ ...expected, statusVersion: '2' }, true],
    [{ ...expected, status: RemoteRunStatus.Running }, true], [null, true],
  ] as const) {
    expect(() => assertDesktopInputDispatchCurrent({ run: () => run, updateRun }, 'session', expected, local,
      () => { throw new Error('stale capture'); })).toThrow('stale capture');
  }
  expect(updateRun).not.toHaveBeenCalled();
});

it('keeps the original validation error if undispatched-run cleanup also fails', () => {
  const expected = { runId: 'local-run', status: RemoteRunStatus.Starting, statusVersion: '1', startedAt: null, finishedAt: null, error: null };
  const store = { run: () => expected, updateRun: () => { throw new Error('storage unavailable'); } };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(() => assertDesktopInputDispatchCurrent(store, 'session', expected, true, () => { throw new Error('account changed'); })).toThrow('account changed');
  expect(warn).toHaveBeenCalledOnce();
});
