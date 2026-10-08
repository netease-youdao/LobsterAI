import { afterEach, describe, expect, test, vi } from 'vitest';

import { type MarkdownFileApi, MarkdownFileError, type MarkdownFileResult, type SaveMarkdownFileRequest } from '../../shared/artifactPreview/markdownEditing';
import { MarkdownDocument, MarkdownDocumentRegistry, MarkdownSaveState } from './markdownDocument';
import { installMarkdownDocumentLifecycle } from './markdownDocumentLifecycle';

function setup(filePath = '/tmp/document.md') {
  let disk = { filePath, content: '# Original\n', version: 'v1' };
  const drafts = new Map<string, string>();
  const storage = {
    getItem: (key: string) => drafts.get(key) ?? null,
    setItem: (key: string, value: string) => { drafts.set(key, value); },
    removeItem: (key: string) => { drafts.delete(key); },
  };
  const api: MarkdownFileApi = {
    read: vi.fn(async (): Promise<MarkdownFileResult> => ({ success: true, file: { ...disk } })),
    save: vi.fn(async (request: SaveMarkdownFileRequest): Promise<MarkdownFileResult> => {
      if (request.expectedVersion !== disk.version && request.content !== disk.content) {
        return { success: false, code: MarkdownFileError.Conflict, error: 'conflict' };
      }
      disk = { filePath, content: request.content, version: disk.version + '+' };
      return { success: true, file: { ...disk } };
    }),
  };
  const create = (onStateChange?: () => void) => new MarkdownDocument(filePath, api, () => storage, onStateChange);
  return { api, storage, drafts, create, document: create(), disk: () => disk, externalEdit: () => { disk = { filePath, content: 'external', version: 'external' }; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('Markdown autosave and recovery', () => {
  test('backs up immediately, debounces typing, and saves an empty document', async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.document.refresh();
    expect(f.api.save).not.toHaveBeenCalled();
    f.document.setContent('first');
    f.document.setContent('last');
    expect(JSON.parse([...f.drafts.values()][0]).content).toBe('last');
    expect(f.api.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(f.disk().content).toBe('last');
    expect(f.drafts.size).toBe(0);
    f.document.setContent('');
    await f.document.flush();
    expect(f.disk().content).toBe('');
    expect(f.document.getSnapshot().status).toBe(MarkdownSaveState.Saved);
  });

  test('queues newer edits behind an in-flight write, including undoing to the original', async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.document.refresh();
    let finish!: (result: MarkdownFileResult) => void;
    vi.mocked(f.api.save).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.document.setContent('first write');
    const saving = f.document.flush();
    f.document.setContent('# Original\n');
    expect(f.document.dirty).toBe(true);
    expect(JSON.parse([...f.drafts.values()][0]).content).toBe('# Original\n');
    finish({ success: true, file: { filePath: '/tmp/document.md', content: 'first write', version: 'v1' } });
    await saving;
    expect(f.api.save).toHaveBeenCalledTimes(2);
    expect(f.disk().content).toBe('# Original\n');
    expect(f.document.dirty).toBe(false);
    expect(f.drafts.size).toBe(0);
  });

  test('recovers a failed save after reopening and does not overwrite it with a refresh', async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.document.refresh();
    vi.mocked(f.api.save).mockRejectedValueOnce(new Error('IPC disconnected'));
    f.document.setContent('recover me');
    await f.document.flush();
    expect(f.document.getSnapshot().status).toBe(MarkdownSaveState.Error);
    await f.document.refresh();
    expect(f.document.getSnapshot().content).toBe('recover me');
    const reopened = f.create();
    await reopened.refresh();
    expect(reopened.getSnapshot()).toMatchObject({ content: 'recover me', restored: true });
    await reopened.flush();
    expect(f.disk().content).toBe('recover me');
  });

  test('retains the draft and pauses saves on external edits until an explicit choice', async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.document.refresh();
    f.document.setContent('my version');
    f.externalEdit();
    await f.document.refresh();
    await f.document.flush();
    expect(f.document.getSnapshot()).toMatchObject({ content: 'my version', status: MarkdownSaveState.Conflict });
    expect(f.disk().content).toBe('external');
    expect(f.api.save).not.toHaveBeenCalled();
    const reopened = f.create();
    await reopened.refresh();
    expect(reopened.getSnapshot().status).toBe(MarkdownSaveState.Conflict);
    await reopened.resolveConflict(true);
    expect(f.disk().content).toBe('my version');
  });

  test('can explicitly use the external version and reload clean files', async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.document.refresh();
    f.document.setContent('local');
    f.externalEdit();
    await f.document.refresh();
    await f.document.resolveConflict(false);
    expect(f.document.getSnapshot().content).toBe('external');
    expect(f.drafts.size).toBe(0);
    expect(f.api.save).not.toHaveBeenCalled();
  });

  test('signals draft-storage failure and can still save to disk', async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.document.refresh();
    vi.spyOn(f.storage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    f.document.setContent('disk save still works');
    expect(f.document.getSnapshot().draftSafe).toBe(false);
    await f.document.flush();
    expect(f.disk().content).toBe('disk save still works');
    expect(f.document.getSnapshot().status).toBe(MarkdownSaveState.Saved);
  });

  test('ignores a stale refresh that arrives after a successful save', async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.document.refresh();
    const oldFile = { ...f.disk() };
    let finishRead!: (result: MarkdownFileResult) => void;
    vi.mocked(f.api.read).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const refreshing = f.document.refresh();
    f.document.setContent('newer than the read');
    await f.document.flush();
    finishRead({ success: true, file: oldFile });
    await refreshing;
    expect(f.document.getSnapshot().content).toBe('newer than the read');
    expect(f.document.getSnapshot().status).toBe(MarkdownSaveState.Saved);
  });
});

describe('Markdown document registry', () => {
  test('protects failed edits after their editor unmounts and clears the guard after recovery', async () => {
    vi.useFakeTimers();
    const first = setup('/tmp/first.md');
    const second = setup('/tmp/second.md');
    const notify = vi.fn();
    const registry = new MarkdownDocumentRegistry((path, changed) => (
      path === '/tmp/first.md' ? first : second
    ).create(changed), notify);
    const target = new EventTarget();
    const dispose = installMarkdownDocumentLifecycle(target as Window, registry);
    try {
      const document = registry.get('/tmp/first.md');
      const unsubscribe = document.subscribe(() => {});
      await document.refresh();
      const setDraft = vi.spyOn(first.storage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
      const save = vi.mocked(first.api.save).mockResolvedValue({ success: false, code: MarkdownFileError.Io, error: 'disk' });
      document.setContent('unprotected edits');
      await document.flush();
      unsubscribe();
      await registry.get('/tmp/second.md').refresh();
      const unload = new Event('beforeunload', { cancelable: true });
      target.dispatchEvent(unload);
      await registry.flush();
      expect(unload.defaultPrevented).toBe(true);
      expect(notify).toHaveBeenLastCalledWith(true);
      expect(first.drafts.size).toBe(0);
      expect(first.disk().content).toBe('# Original\n');
      expect(registry.getContent('/tmp/first.md')).toBe('unprotected edits');

      setDraft.mockRestore();
      save.mockImplementation(async request => ({ success: true, file: { ...first.disk(), content: request.content, version: 'recovered' } }));
      await registry.flush();
      const afterRecovery = new Event('beforeunload', { cancelable: true });
      target.dispatchEvent(afterRecovery);
      expect(afterRecovery.defaultPrevented).toBe(false);
      expect(notify).toHaveBeenLastCalledWith(false);
    } finally {
      dispose();
    }
  });

  test('copies the live buffer after failures and conflicts, preserving an empty buffer', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const create = vi.fn((_path: string, changed: () => void) => fixture.create(changed));
    const registry = new MarkdownDocumentRegistry(create);
    expect(registry.getContent('/tmp/document.md')).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    const document = registry.get('/tmp/document.md');
    expect(registry.getContent('/tmp/document.md')).toBeUndefined();
    await document.refresh();
    document.setContent('pending edit');
    expect(registry.getContent('file:///tmp/document.md')).toBe('pending edit');
    vi.mocked(fixture.api.save).mockRejectedValueOnce(new Error('disk'));
    await document.flush();
    expect(registry.getContent('/tmp/document.md')).toBe('pending edit');
    fixture.externalEdit();
    await document.refresh();
    expect(document.getSnapshot().status).toBe(MarkdownSaveState.Conflict);
    expect(registry.getContent('/tmp/document.md')).toBe('pending edit');
    document.setContent('');
    expect(registry.getContent('/tmp/document.md')).toBe('');
    expect(fixture.disk().content).toBe('external');
  });

  test('keeps draft-backed changes recoverable without blocking unload', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const registry = new MarkdownDocumentRegistry((_path, changed) => fixture.create(changed));
    const document = registry.get('/tmp/document.md');
    await document.refresh();
    vi.mocked(fixture.api.save).mockResolvedValue({ success: false, code: MarkdownFileError.Io, error: 'disk' });
    document.setContent('draft backup');
    await registry.flush();
    expect(registry.hasUnsafeEdits()).toBe(false);
    const reopened = fixture.create();
    await reopened.refresh();
    expect(reopened.getSnapshot()).toMatchObject({ content: 'draft backup', restored: true });
  });

  test('registry observation does not prevent eviction of clean, unmounted documents', async () => {
    vi.useFakeTimers();
    const create = vi.fn((path: string, changed: () => void) => setup(path).create(changed));
    const registry = new MarkdownDocumentRegistry(create);
    const first = registry.get('/tmp/first.md');
    await first.refresh();
    expect(first.canEvict).toBe(true);
    for (let index = 0; index < 12; index++) {
      await registry.get(`/tmp/other-${index}.md`).refresh();
    }
    expect(registry.getContent('/tmp/first.md')).toBeUndefined();
    expect(registry.get('/tmp/first.md')).not.toBe(first);
  });
});
